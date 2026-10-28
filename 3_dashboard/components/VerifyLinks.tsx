'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import ScrollX from '@/components/ScrollX'
import {
  CLASSIFY_BATCH,
  CLICK_PLATFORMS,
  CLICK_PLATFORM_LABELS,
  DEFAULT_GENRE,
  GENRES,
  GENRE_LABELS,
  isGenre,
} from '@/lib/config'

const PAGE_SIZE = 500
const UPLOAD_CHUNK = 500 // rows per upload request
const CLASSIFY_BATCHES = 5 // split a page's titles into up to this many Groq batches

interface VRow {
  url: string
  account: string | null
  platform: string
  /** Which pool this joins when merged. Never '' - the server defaults it. */
  genre: string
  view_count: number
  heart_count: number
  comment_count: number
  share_count: number
  posted_date: string | null
  title: string | null
  bio: string | null
}

/** The channel's own page, from the platform the row was scraped for. */
function channelUrl(account: string | null, platform: string | null): string | null {
  const a = (account || '').trim().replace(/^@/, '')
  if (!a) return null
  const p = (platform || 'tiktok').toLowerCase()
  if (p.startsWith('youtube')) return `https://www.youtube.com/@${encodeURIComponent(a)}`
  if (p === 'instagram') return `https://www.instagram.com/${encodeURIComponent(a)}/`
  return `https://www.tiktok.com/@${encodeURIComponent(a)}`
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

// Minimal RFC-4180 CSV parser (handles quoted fields with commas / quotes).
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c === '\r') { /* skip */ }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

interface ChannelRank {
  handle: string
  /** Which site the channel is on — a handle alone does not say. */
  platform: 'tiktok' | 'instagram' | 'youtube'
  links: number
  active: number
  blocked: number
  activePct: number | null
  avgHearts: number | null
  perDay: number | null
  lastPostDays: number | null
  score: number
  /** Somebody asked for this channel by hand rather than it being worked out
   *  from links we already hold. */
  added: boolean
}

export default function VerifyLinks({
  genre,
}: {
  /** The admin's master genre switch. The staged list is cut to it. */
  genre: string
}) {
  const [rows, setRows] = useState<VRow[]>([])
  const [total, setTotal] = useState(0)          // count matching the active filter
  const [totalAll, setTotalAll] = useState(0)    // count for the whole list, filter ignored
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /**
   * The links "Mark unrelated" floated to the top, frozen as they were
   * at that moment.
   *
   * A SNAPSHOT, NOT THE LIVE SELECTION. This used to be a boolean and the order
   * was computed from `selected`, so ticking any box moved that row into the
   * pinned block and the whole list re-flowed under the cursor — you went to
   * select a second link and the page jumped to the channel's selected ones.
   *
   * Reviewing is exactly when somebody ticks and unticks a lot, so the order has
   * to hold still while they do it. It is recomputed only by another Mark run,
   * and cleared when a new page loads.
   */
  const [pinnedUrls, setPinnedUrls] = useState<Set<string>>(new Set())
  const [classifying, setClassifying] = useState(false)
  // Merge is gated on this: the current page must be run through "Mark humanizer
  // unrelated" before it can be merged. Resets whenever a new page/batch loads.
  const [classifiedThisPage, setClassifiedThisPage] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [merging, setMerging] = useState(false)
  const [uploading, setUploading] = useState('')
  // Title-presence filter, applied server-side so the pager and totals match.
  // 'has' hides every link that has no title yet.
  const [titleFilter, setTitleFilter] = useState<'all' | 'has' | 'none'>('all')
  // Platform filter, applied server-side like the title one so the pager and
  // the totals describe the same set the table shows. '' = every platform.
  const [platform, setPlatform] = useState('')
  // How many links each platform holds, read from the URLs. Shown in the
  // dropdown: an option that would empty the page should say so first.
  const [platformCounts, setPlatformCounts] = useState<Record<string, number>>({})
  // Genre filter, server-side for the same reason as the other two.
  //
  // Worth having its own filter rather than reading the badge down the list:
  // the genre a link is staged with decides which product's comments can ever
  // be served on it, so reviewing one genre's intake at a time is reviewing it
  // against the right question — a slides video is not judged by whether it
  // suits a humanizer. Set by the master switch above the page (a prop).
  const [genreCounts, setGenreCounts] = useState<Record<string, number>>({})
  // Channels present in the verify list, for the whole-channel merge.
  const [accounts, setAccounts] = useState<{ account: string; platform: string; n: number }[]>([])
  // Channels ticked for merging. A set, so a search's worth can be cleared in
  // one action instead of one channel at a time (there are 1,000+ of them).
  const [mergeAccounts, setMergeAccounts] = useState<Set<string>>(new Set())
  // The channel list gets long, so the picker is a searchable combobox rather
  // than a <select> (which can't be filtered beyond browser type-ahead).
  const [channelQuery, setChannelQuery] = useState('')
  const [channelMenuOpen, setChannelMenuOpen] = useState(false)
  // Same per-channel active/blocked ratio the main Links page calculates — the
  // verify list is exactly where a bad channel is worth spotting before merging.
  const [channelStats, setChannelStats] = useState<Record<string, { active: number; blocked: number }> | null>(null)
  // Why the Active % column is empty, when it is: still loading, or the request
  // failed. It used to fail silently, which read as "no data" on every row.
  const [statsState, setStatsState] = useState<'loading' | 'ok' | 'failed'>('loading')

  // ── Channel ranking + new-video extraction ─────────────────────────────────
  // Two steps on purpose: rank first so the order is visible and checkable, then
  // extract in exactly that order. Extraction stages into verify_link ONLY —
  // nothing reaches the main pool without a manual merge.
  const [ranked, setRanked] = useState<ChannelRank[] | null>(null)
  // Links we hold whose channel cannot be named at all. Shown beside the
  // channel count, because otherwise their absence reads as channels missing
  // from the list rather than links with nobody to attribute them to.
  const [unattributed, setUnattributed] = useState<{
    total: number
    byPlatform: Record<string, number>
  } | null>(null)
  const [ranking, setRanking] = useState(false)
  const [showRanked, setShowRanked] = useState(false)
  const [rankQuery, setRankQuery] = useState('')
  // Which site's channels the ranked table shows. TikTok outnumbers Instagram
  // 2,756 to 535, so without this the Instagram channels are real, ranked and
  // effectively unreachable — they sit below two thousand rows.
  const [rankSite, setRankSite] = useState('')
  // Show only the channels somebody added by hand.
  //
  // A filter rather than a separate mode, because extraction already runs over
  // exactly what the filters leave on screen — so narrowing to the added ones
  // IS "extract from the added ones only", using the mechanism that was already
  // there rather than a second one beside it.
  const [onlyAdded, setOnlyAdded] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [exDone, setExDone] = useState(0)
  const [exTotal, setExTotal] = useState(0)
  const [exNew, setExNew] = useState(0)
  const [exFailed, setExFailed] = useState(0)
  const [exNote, setExNote] = useState('')
  const stopExtract = useRef(false)
  const channelBoxRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true)
    try {
      // Ticked channels narrow the table to exactly what a channel merge would
      // take, so what you see is what you are about to act on.
      const accountsParam = Array.from(mergeAccounts).map(encodeURIComponent).join(',')
      const res = await fetch(
        `/api/admin/verify-links?page=${p}&limit=${PAGE_SIZE}&title=${titleFilter}` +
          (platform ? `&platform=${platform}` : '') +
          (genre ? `&genre=${genre}` : '') +
          (accountsParam ? `&accounts=${accountsParam}` : '')
      )
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        setRows(Array.isArray(d.rows) ? d.rows : [])
        setTotal(Number(d.total) || 0)
        setTotalAll(Number(d.totalAll) || 0)
        if (d.platformCounts && typeof d.platformCounts === 'object') {
          setPlatformCounts(d.platformCounts as Record<string, number>)
        }
        if (d.genreCounts && typeof d.genreCounts === 'object') {
          setGenreCounts(d.genreCounts as Record<string, number>)
        }
      } else {
        alert(d?.error || 'Could not load the verify list.')
      }
    } finally {
      setSelected(new Set())
      setPinnedUrls(new Set())
      setClassifiedThisPage(false) // a freshly-loaded page must be re-classified before merge
      setLoading(false)
    }
  }, [titleFilter, platform, genre, mergeAccounts])

  useEffect(() => { fetchPage(page) }, [page, fetchPage])

  // Channel list for the whole-channel merge. Refreshed whenever the list size
  // changes, so counts stay right after an upload, a merge or a block.
  const loadAccounts = useCallback(() => {
    fetch('/api/admin/verify-links/accounts')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d?.accounts)) setAccounts(d.accounts) })
      .catch(() => {})
  }, [])
  useEffect(() => { loadAccounts() }, [loadAccounts, totalAll])

  // Loaded once with the page: it is the number that decides whether a channel is
  // worth merging at all, so making it opt-in here would just hide it.
  const loadChannelStats = useCallback(() => {
    setStatsState('loading')
    fetch('/api/admin/links/channel-stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.stats) { setChannelStats(d.stats); setStatsState('ok') }
        else setStatsState('failed')
      })
      .catch(() => setStatsState('failed'))
  }, [])
  useEffect(() => { loadChannelStats() }, [loadChannelStats])

  // Channels matching the search box. Matching on the handle only (the counts
  // are not something you search for), case-insensitive substring.
  const channelMatches = useMemo(() => {
    const q = channelQuery.trim().toLowerCase().replace(/^@/, '')
    if (!q) return accounts
    return accounts.filter((a) => a.account.toLowerCase().includes(q))
  }, [accounts, channelQuery])

  useEffect(() => {
    if (!channelMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (channelBoxRef.current && !channelBoxRef.current.contains(e.target as Node)) {
        setChannelMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChannelMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [channelMenuOpen])

  // Any change to the selection re-filters the table, so restart at page 0.
  // fetchPage's identity changes with mergeAccounts, so the existing effect
  // re-runs and this costs exactly one request.
  const setPicked = (next: Set<string>) => {
    setMergeAccounts(next)
    setPage(0)
  }

  const toggleChannel = (account: string) =>
    setPicked((() => {
      const next = new Set(mergeAccounts)
      if (next.has(account)) next.delete(account)
      else next.add(account)
      return next
    })())

  // Tick/untick everything the current search matches, so a query like "study"
  // becomes one decision rather than forty.
  const allMatchesPicked =
    channelMatches.length > 0 && channelMatches.every((a) => mergeAccounts.has(a.account))
  const toggleAllMatches = () => {
    const next = new Set(mergeAccounts)
    for (const a of channelMatches) {
      if (allMatchesPicked) next.delete(a.account)
      else next.add(a.account)
    }
    setPicked(next)
  }

  // Links covered by the current selection — what the merge will actually take.
  const pickedLinkCount = accounts
    .filter((a) => mergeAccounts.has(a.account))
    .reduce((sum, a) => sum + a.n, 0)

  const channelLabel =
    mergeAccounts.size === 0
      ? ''
      : mergeAccounts.size === 1
        ? `@${Array.from(mergeAccounts)[0]}`
        : `${mergeAccounts.size} channels · ${pickedLinkCount.toLocaleString()} links`

  // ── Merge every link of ONE channel (all pages), not just this page ─────────
  /**
   * Merge whole channels into the main list.
   *
   * Shared by the picker's "Merge N channels" button and the per-row 🔀 button,
   * so both take the channel IN FULL across every page — the row button is a
   * shortcut for "this channel", not "this row".
   */
  async function mergeChannels(picked: string[]) {
    if (picked.length === 0 || merging) return
    const linkCount = accounts
      .filter((a) => picked.includes(a.account))
      .reduce((sum, a) => sum + a.n, 0)
    const who =
      picked.length === 1
        ? `@${picked[0]}${linkCount ? ` (${linkCount.toLocaleString()} links)` : ''}`
        : `${picked.length} channels (${linkCount.toLocaleString()} links)`
    if (!confirm(
      `Merge ALL links from ${who} into the MAIN links list?

` +
      `This covers each channel in full, across every page — not just the links shown here. ` +
      `They'll cluster by posted date only (no search rank) and leave the verify list.`
    )) return
    setMerging(true)
    try {
      const res = await fetch('/api/admin/verify-links/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: picked }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Merge failed.'); return }
      const upd = Number(d.updated ?? 0)
      const skipped = Number(d.skippedBlocked ?? 0)
      alert(
        `Merged ${d.added ?? 0} link(s) from ${who}` +
        (upd ? `, refreshed ${upd} already-listed link(s)` : '') +
        (skipped ? `, skipped ${skipped} already-blocked link(s)` : '') +
        ` (removed ${d.removed ?? 0} from verify).`
      )
      // Drop any merged channel from the selection so the table filter can't be
      // left pointing at a channel that no longer exists.
      setPicked(new Set(Array.from(mergeAccounts).filter((a) => !picked.includes(a))))
      await fetchPage(0)
      loadAccounts()
    } finally {
      setMerging(false)
    }
  }

  const mergeChannel = () => mergeChannels(Array.from(mergeAccounts))

  // ── Review every staged channel, one at a time ──────────────────────────────
  // Open the channel, look at it, merge it or set it aside. The whole staging
  // list is 2,000+ channels, so the modal has to hold your place: a merged
  // channel leaves the list by itself, and one you decide against is hidden for
  // the session rather than sitting at the top of every later pass.
  const [channelsOpen, setChannelsOpen] = useState(false)
  const [chanQuery, setChanQuery] = useState('')
  const [chanSort, setChanSort] = useState<'links' | 'name'>('links')
  const [chanSeen, setChanSeen] = useState<Set<string>>(new Set())
  const [chanHidden, setChanHidden] = useState<Set<string>>(new Set())
  const [chanBusy, setChanBusy] = useState('')

  const chanShown = useMemo(() => {
    const q = chanQuery.trim().toLowerCase()
    const out = accounts.filter(
      (a) => !chanHidden.has(a.account) && (q === '' || a.account.toLowerCase().includes(q))
    )
    return chanSort === 'name'
      ? [...out].sort((a, b) => a.account.localeCompare(b.account))
      : [...out].sort((a, b) => b.n - a.n || a.account.localeCompare(b.account))
  }, [accounts, chanQuery, chanSort, chanHidden, chanSeen])

  const chanLinksShown = chanShown.reduce((n, a) => n + a.n, 0)

  /** Merge one channel from the modal, without the list jumping under you. */
  async function mergeOneChannel(account: string) {
    if (chanBusy) return
    setChanBusy(account)
    try {
      await mergeChannels([account])
    } finally {
      setChanBusy('')
    }
  }

  // Switching the filter changes what lands on every page, so jump back to page 0.
  // No explicit re-fetch: changing titleFilter gives fetchPage a new identity, and
  // the effect above re-runs on it — so this always costs exactly one request.
  function changeTitleFilter(next: 'all' | 'has' | 'none') {
    setTitleFilter(next)
    setPage(0)
  }

  // Back to page 0 for the same reason the title filter does: page 7 of the
  // old filter is rarely a page of the new one, and landing on an empty page
  // reads as "there are none" rather than "you are past the end".
  function changePlatform(next: string) {
    setPlatform(next)
    setPage(0)
  }

  // Back to page 0 when the switch moves: page 4 of the humanizer list is not
  // page 4 of anything else, and landing past the end looks like an empty list.
  useEffect(() => { setPage(0) }, [genre])

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  /**
   * The page in reading order after "Mark unrelated": three blocks.
   *
   *   1. what the classifier called unrelated — the ones to look at and block
   *   2. the rest WITHOUT a title
   *   3. the rest with a title
   *
   * Block 2 is second because those links were never classified at all: Mark
   * only sends rows that have a title (see markUnrelated), so an untitled link
   * has had no verdict and is the one still needing a human. Leaving them mixed
   * in among hundreds of judged rows is how they got missed.
   *
   * Original order is kept inside each block, which keeps a channel's links
   * together there — the headings come from runs of the same account, so
   * reordering inside a block rather than across one is what stops a channel
   * being split into several headings.
   *
   * Block 1 follows the live selection; holdScroll keeps the view still as rows move.
   */
  const displayRows = useMemo(() => {
    // Untouched until the page has been through Mark. Before that the query's
    // own channel-grouped order is the only one that means anything.
    if (!classifiedThisPage) return rows
    const pinned: VRow[] = []
    const untitled: VRow[] = []
    const titled: VRow[] = []
    for (const r of rows) {
      // LIVE, not the Mark snapshot: ticking a row moves it into the selected
      // block and unticking moves it out. The view is held still across the
      // move by holdScroll (below), which is what the snapshot used to buy.
      if (selected.has(r.url)) pinned.push(r)
      else if (!r.title || !r.title.trim()) untitled.push(r)
      else titled.push(r)
    }
    return [...pinned, ...untitled, ...titled]
    // NOT pinnedUrls ALONE. Blocking the unrelated links clears the snapshot -
    // those rows have left the page - and keying the whole order on it would
    // take the untitled ones back out of the top at the exact moment they
    // become the only thing left to review. classifiedThisPage survives a
    // block and is reset by a fresh page, which is the life this order wants.
  }, [rows, selected, classifiedThisPage])

  // Consecutive rows of the same channel, so the table can print one heading per
  // channel instead of repeating the account on every line. The query already
  // returns each channel's links in one run (see getVerifyLinks); this only has
  // to notice where a run starts and ends.
  //
  // Built from displayRows, not rows: with "Mark unrelated" pinning selections
  // to the top the display order is what the reader sees, and a heading that
  // disagreed with it would be worse than none.
  const rowGroups = useMemo(() => {
    const out: {
      account: string | null
      platform: string | null
      bio: string | null
      // A channel's links all share its genre, so it belongs on the group.
      genre: string
      rows: VRow[]
    }[] = []
    for (const r of displayRows) {
      const key = (r.account || '').toLowerCase()
      const last = out[out.length - 1]
      if (last && (last.account || '').toLowerCase() === key) last.rows.push(r)
      else out.push({ account: r.account, platform: r.platform, bio: r.bio, genre: r.genre, rows: [r] })
    }
    return out
  }, [displayRows])

  /** How many links this channel has staged in TOTAL, not just on this page. */
  const stagedFor = (account: string | null) =>
    accounts.find((a) => a.account.toLowerCase() === (account || '').toLowerCase())?.n ?? null

  /**
   * Keep the view still while ticked rows move between the selected and the
   * unselected block.
   *
   * Before the change: the first row on screen that is NOT moving, and where it
   * sits. After React has re-rendered, but before the browser paints, scroll by
   * however far that row was pushed — so what is under the cursor stays put and
   * only the moved rows disappear from view. The table opts out of the browser's
   * own scroll anchoring (overflow-anchor: none) so the two never both correct.
   */
  const anchorRef = useRef<{ url: string; top: number } | null>(null)
  const holdScroll = (moving: Set<string>) => {
    anchorRef.current = null
    const els = document.querySelectorAll<HTMLElement>('[data-vrow]')
    const vh = window.innerHeight
    for (let i = 0; i < els.length; i++) {
      const el = els[i]
      const url = el.dataset.vrow || ''
      if (moving.has(url)) continue
      const top = el.getBoundingClientRect().top
      if (top >= 0 && top < vh) { anchorRef.current = { url, top }; return }
    }
  }
  useLayoutEffect(() => {
    const a = anchorRef.current
    if (!a) return
    anchorRef.current = null
    const els = document.querySelectorAll<HTMLElement>('[data-vrow]')
    for (let i = 0; i < els.length; i++) {
      if (els[i].dataset.vrow === a.url) {
        const delta = els[i].getBoundingClientRect().top - a.top
        if (delta) window.scrollBy(0, delta)
        return
      }
    }
  }, [displayRows])
  const changeSelection = (urls: string[], next: Set<string>) => {
    holdScroll(new Set(urls))
    setSelected(next)
  }

  const toggle = (url: string) => {
    const n = new Set(selected)
    if (n.has(url)) n.delete(url); else n.add(url)
    changeSelection([url], n)
  }
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.url))
  const toggleAll = () =>
    changeSelection(rows.map((r) => r.url), allSelected ? new Set() : new Set(rows.map((r) => r.url)))

  // ── Upload a channel_videos CSV (parsed in-browser, sent in chunks) ─────────
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading('reading file…')
    try {
      const text = await file.text()
      const table = parseCsv(text)
      if (table.length < 2) { alert('CSV looks empty.'); return }
      const header = table[0].map((h) => h.trim().toLowerCase())
      const idx = (name: string) => header.indexOf(name)
      const iUrl = idx('url'), iAcc = idx('account'), iView = idx('view_count'),
        iHeart = idx('heart_count'), iCom = idx('comment_count'), iShare = idx('share_count'),
        iDate = idx('posted_date'), iTitle = idx('title'), iBio = idx('bio'),
        iState = idx('state')
      if (iUrl < 0) { alert('CSV has no "url" column.'); return }
      // Only take rows whose state is "NEW"; skip "DONE" (already-processed) rows.
      // If the CSV has no state column, every row is taken (backward compatible).
      const httpRows = table.slice(1).filter((r) => (r[iUrl] || '').startsWith('http'))
      const newRows = iState < 0
        ? httpRows
        : httpRows.filter((r) => (r[iState] || '').trim().toUpperCase() === 'NEW')
      const skipped = httpRows.length - newRows.length
      if (newRows.length === 0) {
        alert(iState < 0 ? 'No links found in the CSV.' : `No "NEW" links to upload (skipped ${skipped} "DONE").`)
        return
      }
      const parsed = newRows.map((r) => ({
        url: r[iUrl], account: iAcc >= 0 ? r[iAcc] : '',
        view_count: iView >= 0 ? r[iView] : 0, heart_count: iHeart >= 0 ? r[iHeart] : 0,
        comment_count: iCom >= 0 ? r[iCom] : 0, share_count: iShare >= 0 ? r[iShare] : 0,
        posted_date: iDate >= 0 ? r[iDate] : '', title: iTitle >= 0 ? r[iTitle] : '',
        // Channel bio — the scraper stamps it on every one of that channel's rows.
        bio: iBio >= 0 ? r[iBio] : '',
        // Staged into the genre the switch is on: a CSV uploaded while on
        // Website builder is website-builder intake.
        genre,
      }))
      let saved = 0
      for (let i = 0; i < parsed.length; i += UPLOAD_CHUNK) {
        setUploading(`uploading ${i}/${parsed.length}…`)
        const res = await fetch('/api/admin/verify-links/upload', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: parsed.slice(i, i + UPLOAD_CHUNK) }),
        })
        const d = await res.json().catch(() => ({}))
        if (res.ok) saved += Number(d?.saved ?? 0)
        else { alert(d?.error || 'Upload failed.'); break }
      }
      alert(`Uploaded ${saved} "NEW" link(s) into the verify list${skipped ? ` (skipped ${skipped} "DONE").` : '.'}`)
      setPage(0)
      await fetchPage(0)
    } finally {
      setUploading('')
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // ── Mark humanizer-UNRELATED (classify page titles in up to 5 Groq batches) ─
  /**
   * What the marker is about to judge these links against.
   *
   * Taken from the GENRES ON THE PAGE, not from the filter: with the filter on
   * "All genres" the page can hold website and humanizer links together, and
   * each is judged against its own. The button has to say which, because
   * "unrelated" means nothing without naming what it is unrelated TO — and
   * the old label said "humanizer" while marking a page of website links.
   */
  const pageGenres = useMemo(() => {
    const seen = new Set<string>()
    for (const r of rows) if (r.title) seen.add(isGenre(r.genre) ? r.genre : DEFAULT_GENRE)
    return GENRES.filter((g) => seen.has(g))
  }, [rows])
  const markLabel =
    pageGenres.length === 0
      ? 'nothing to mark'
      : pageGenres.length === 1
        ? (GENRE_LABELS[pageGenres[0]] ?? pageGenres[0])
        : `${pageGenres.length} genres, each against its own`

  async function markUnrelated() {
    // The genre travels with each row: the page can show several at once, and
    // what counts as "related" is a different question for each of them.
    const items = rows
      .filter((r) => r.title)
      .map((r) => ({ url: r.url, title: r.title as string, genre: r.genre }))
    if (items.length === 0) {
      // Nothing to classify on this page → count it as reviewed so merge can proceed.
      setClassifiedThisPage(true)
      alert('No titles on this page to classify — you can merge it as-is.')
      return
    }
    setClassifying(true)
    try {
      // CAPPED, not just divided. Five batches of a 500-row page is 100 each,
      // which fits under the endpoint's limit by arithmetic rather than by
      // intent — raise PAGE_SIZE and the batches silently grow past it.
      const batchSize = Math.min(
        CLASSIFY_BATCH,
        Math.max(1, Math.ceil(items.length / CLASSIFY_BATCHES))
      )
      const related = new Set<string>()
      for (let i = 0; i < items.length; i += batchSize) {
        const res = await fetch('/api/admin/links/classify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: items.slice(i, i + batchSize) }),
        })
        const d = await res.json().catch(() => ({}))
        if (res.ok && Array.isArray(d.related)) d.related.forEach((u: string) => related.add(u))
        else if (!res.ok) { alert(d?.error || 'Classification failed.'); return }
      }
      const unrelated = items.filter((it) => !related.has(it.url)).map((it) => it.url)
      setSelected(new Set(unrelated))
      // Frozen here and nowhere else, so the order holds still while the page is
      // reviewed.
      setPinnedUrls(new Set(unrelated))
      setClassifiedThisPage(true) // this page is now reviewed → merge is allowed
      alert(
        `Selected ${unrelated.length} unrelated link(s) of ${items.length} ` +
          `(${markLabel}) — floated to the top. Review, then Block.`
      )
    } finally {
      setClassifying(false)
    }
  }

  // ── Block selected (no backfill — the page just shrinks) ────────────────────
  // A link judged unrelated is BLOCKED, not just dropped from this list: blocking
  // is recorded per URL and survives re-uploads, so the next channel scrape or
  // videos.json upload can't quietly re-introduce it for you to judge again.
  async function blockSelected() {
    const urls = Array.from(selected)
    if (urls.length === 0) return
    if (!confirm(
      `Block ${urls.length} selected link(s)?

` +
      `They're removed from the verify list AND permanently blocked, so they stay ` +
      `hidden from every user even if a future upload re-adds them. (Not a delete — ` +
      `you can unblock from the main Links page.)`
    )) return
    setDeleting(true)
    try {
      const res = await fetch('/api/admin/verify-links', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, block: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Block failed.'); return }
      const gone = new Set(urls)
      setRows((prev) => prev.filter((r) => !gone.has(r.url))) // local removal, NO backfill
      const goneCount = d?.removed ?? urls.length
      setTotal((t) => Math.max(0, t - goneCount))
      setTotalAll((t) => Math.max(0, t - goneCount))
      setSelected(new Set())
      setPinnedUrls(new Set())
      alert(`Blocked ${d?.blocked ?? urls.length} link(s) and removed them from the verify list.`)
    } finally {
      setDeleting(false)
    }
  }

  // ── Clean: wipe the ENTIRE verify list ──────────────────────────────────────
  async function cleanAll() {
    if (totalAll === 0) { alert('The verify list is already empty.'); return }
    // Clean ignores the Title filter — it wipes the whole list, so it must warn
    // with the UNFILTERED count, not the (possibly much smaller) filtered one.
    if (!confirm(`Clean the WHOLE verify list?\n\nThis permanently removes ALL ${totalAll.toLocaleString()} link(s) from the "Links to verify" list${
      titleFilter !== 'all' || platform || genre
        ? (() => {
            // Named one by one, and pluralised by how many are actually on:
            // this sentence is the only warning that Clean ignores the filters,
            // so it has to list all of them rather than the two it knew about
            // when it was written.
            const on = [platform && 'Platform', genre && 'Genre', titleFilter !== 'all' && 'Title']
              .filter(Boolean)
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1')
            const many = [platform, genre, titleFilter !== 'all'].filter(Boolean).length > 1
            return ` — including the ones the ${on} filter${many ? 's are' : ' is'} currently hiding`
          })()
        : ''
    }. It does NOT touch the main links list.`)) return
    setCleaning(true)
    try {
      const res = await fetch('/api/admin/verify-links', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Clean failed.'); return }
      setRows([]); setTotal(0); setTotalAll(0); setSelected(new Set()); setPinnedUrls(new Set()); setPage(0)
      alert(`Cleaned ${d?.removed ?? 0} link(s) from the verify list.`)
    } finally {
      setCleaning(false)
    }
  }

  // ── Channels added by hand ─────────────────────────────────────────────────
  //
  // Every other channel on this page is INFERRED from links already in the pool,
  // which is a closed loop: a channel with no links is not in the ranking, so
  // the extract pass never visits it, so it never gets links. This is the way
  // in for a channel nobody has scraped yet.
  interface ExtraChannel {
    site: string
    handle: string
    note: string | null
    /** Which pool its videos join when merged. Never '' - the server defaults it. */
    genre: string
    addedAt: string
  }
  const [addOpen, setAddOpen] = useState(false)
  const [addInput, setAddInput] = useState('')
  const [addSite, setAddSite] = useState('')
  // WHICH POOL THIS CHANNEL'S VIDEOS JOIN. Picked once per channel rather than
  // per video: every link extracted from it inherits this, and the merge files
  // them in that genre's pool. Adding a cocodly channel is the whole of telling
  // the system that its videos are cocodly videos.
  const [addGenre, setAddGenre] = useState<string>(genre || DEFAULT_GENRE)
  useEffect(() => { setAddGenre(genre || DEFAULT_GENRE) }, [genre])
  const [addNote, setAddNote] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addMsg, setAddMsg] = useState('')
  const [addErr, setAddErr] = useState('')
  const [extras, setExtras] = useState<ExtraChannel[] | null>(null)
  // Set when the channel just added is real and ranked but filtered off the
  // screen — which is the one case where the add succeeded and the extract
  // button still will not touch it.
  const [addHidden, setAddHidden] = useState<{ site: string; handle: string } | null>(null)

  /**
   * The site a pasted link names, read in the browser as well as on the server.
   *
   * Only so the dropdown can lock itself and stop asking a question the link has
   * already answered. The server parses it again and its answer is the one that
   * counts — this is a convenience, not a validation.
   */
  const siteFromInput = (raw: string): string => {
    const u = raw.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '')
    if (/^(?:m\.|vm\.)?tiktok\.com\/@/i.test(u)) return 'tiktok'
    if (/^(?:m\.)?youtube\.com\/@/i.test(u)) return 'youtube'
    if (/^instagram\.com\/(?!p\/|reel|explore|stories|tv\/|accounts|direct)/i.test(u)) return 'instagram'
    return ''
  }
  const detectedSite = siteFromInput(addInput)

  async function loadExtras() {
    try {
      const res = await fetch('/api/admin/verify-links/channels')
      const d = await res.json().catch(() => ({}))
      if (res.ok) setExtras(Array.isArray(d.channels) ? d.channels : [])
    } catch {
      /* the panel simply shows nothing rather than an error nobody can act on */
    }
  }

  async function addChannel() {
    if (!addInput.trim()) return
    setAddBusy(true)
    setAddMsg('')
    setAddErr('')
    try {
      const res = await fetch('/api/admin/verify-links/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: addInput,
          site: detectedSite || addSite,
          note: addNote,
          genre: addGenre,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setAddErr(d?.error || 'Could not add that channel.')
        return
      }
      // What actually happened, in the words that distinguish the cases: added,
      // already there, and added-but-nothing-listed are three different things
      // and only the first is a success.
      const where = `@${d.handle} on ${d.site}`
      setAddMsg(
        !d.added
          ? `${where} was already on the list.`
          : d.listed === null
            ? `${where} added. Its posts cannot be listed from here — export the handles and scrape it locally.`
            : d.listed > 0
              ? `${where} added — TikTok lists ${d.listed} video(s). It is now first in the ranked list; press ⬇ Extract new videos to stage them.`
              : `${where} added, but TikTok listed nothing for it. Check the spelling, or the account may be private or new.`
      )
      setAddInput('')
      setAddNote('')
      setAddHidden(null)
      await loadExtras()
      // ALWAYS re-rank, not only when a ranking is already on screen.
      //
      // ⬇ Extract new videos is disabled until the channels have been ranked —
      // it walks that list, in that order — so adding a channel without ranking
      // left the button dead next to a message telling you to press it. Adding
      // a channel IS a reason to rank: the list has just changed.
      const list = await rankChannels()
      if (list) {
        // And it has to be VISIBLE. Extraction runs over exactly the rows the
        // filters leave on screen, so a "min links" filter — which a channel we
        // hold no links from can never pass — hides the very channel that was
        // just added and takes it out of the run without saying so.
        const row = list.find((c) => c.platform === d.site && c.handle === d.handle)
        if (!row) {
          setAddErr(
            `@${d.handle} was saved but is not in the ranked list. Press 📊 Rank channels again; ` +
              'if it still does not appear, something is wrong with the ranking rather than the add.'
          )
        } else if (!passesChannelFilters(row)) {
          setAddHidden({ site: d.site, handle: d.handle })
        }
      }
    } catch {
      setAddErr('Network error.')
    } finally {
      setAddBusy(false)
    }
  }

  /**
   * Extract from the hand-added channels and nothing else.
   *
   * Ranks first and reads the returned list, rather than trusting what is on
   * screen: this is usually pressed seconds after an add, when the table may
   * not have caught up. The filter is set to match so the table shows what is
   * actually being worked on — a run over a set the screen disagrees with is
   * how you end up unable to say what was extracted.
   */
  async function extractAdded() {
    const list = (await rankChannels()) ?? ranked
    if (!list) return
    setOnlyAdded(true)
    setRankSite('')
    setRankQuery('')
    setFLinks(['', '']); setFHearts(['', '']); setFRate(['', ''])
    setFActive(['', '']); setFLast(['', '']); setFScore(['', ''])
    const mine = list.filter((c) => c.added)
    if (mine.length === 0) {
      setExNote('No channels have been added by hand, so there is nothing to extract from.')
      return
    }
    await extractNew(mine.filter((c) => c.platform === 'tiktok'))
  }

  async function removeChannel(site: string, handle: string) {
    try {
      await fetch(
        `/api/admin/verify-links/channels?site=${encodeURIComponent(site)}&handle=${encodeURIComponent(handle)}`,
        { method: 'DELETE' }
      )
      await loadExtras()
      if (ranked) await rankChannels()
    } catch {
      /* leave the row; the next load will show the truth */
    }
  }

  // ── Merge the current page's remaining links into the main pool ─────────────
  // Rank every channel from data we already hold — no network, so it returns at
  // once. Nothing is fetched from TikTok until the extract button is pressed.
  /**
   * Rank every channel from data we already hold, and RETURN the list.
   *
   * Returned as well as stored because a caller that has just changed the set
   * of channels needs to look at the result now: setRanked schedules a render,
   * so reading `ranked` on the next line still gives the old list.
   */
  async function rankChannels(): Promise<ChannelRank[] | null> {
    setRanking(true)
    setExNote('')
    try {
      const res = await fetch('/api/admin/verify-links/extract')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not rank channels.'); return null }
      const list: ChannelRank[] = Array.isArray(d.channels) ? d.channels : []
      setRanked(list)
      setUnattributed(d.unattributed ?? null)
      setShowRanked(true)
      return list
    } finally {
      setRanking(false)
    }
  }

  // ── Ranked-channel filters ─────────────────────────────────────────────────
  // One min/max pair per numeric column, plus the handle search. Extraction runs
  // over exactly what these leave on screen, so narrowing the table is how you
  // choose which channels to fetch from — the alternative was all 2,320 or none.
  const [fLinks, setFLinks] = useState<[string, string]>(['', ''])
  const [fHearts, setFHearts] = useState<[string, string]>(['', ''])
  const [fRate, setFRate] = useState<[string, string]>(['', ''])
  const [fActive, setFActive] = useState<[string, string]>(['', ''])
  const [fLast, setFLast] = useState<[string, string]>(['', ''])
  const [fScore, setFScore] = useState<[string, string]>(['', ''])

  function clearChannelFilters() {
    setOnlyAdded(false)
    setRankQuery('')
    setFLinks(['', '']); setFHearts(['', '']); setFRate(['', ''])
    setFActive(['', '']); setFLast(['', '']); setFScore(['', ''])
  }

  /**
   * Does a value pass a min/max pair?
   *
   * A null value (never posted twice, no channel ratio) fails as soon as EITHER
   * bound is set — an unknown cannot be shown to be "at least 50", and letting
   * unknowns through a filter is how you end up extracting from channels you
   * meant to exclude.
   */
  function inRange(v: number | null, [lo, hi]: [string, string]): boolean {
    const min = lo.trim() === '' ? null : Number(lo)
    const max = hi.trim() === '' ? null : Number(hi)
    if (min === null && max === null) return true
    if (v === null || !Number.isFinite(v)) return false
    if (min !== null && Number.isFinite(min) && v < min) return false
    if (max !== null && Number.isFinite(max) && v > max) return false
    return true
  }

  // ── Auto-merge spec (lib/autoMerge.ts) ─────────────────────────────────────
  // The filters above, saved per genre: every staged link of a channel meeting
  // them is merged into the main links on each hourly harvest pass, with no
  // related check. Shown and saved from under the ranked table.
  type AmBound = [number | null, number | null]
  interface AmSpec {
    enabled: boolean
    platform: '' | 'tiktok' | 'instagram' | 'youtube'
    links: AmBound; hearts: AmBound; rate: AmBound; active: AmBound; last: AmBound; score: AmBound
  }
  const [amSpec, setAmSpec] = useState<AmSpec | null>(null)
  const [amCover, setAmCover] = useState<{ links: number; channels: number } | null>(null)
  const [amBusy, setAmBusy] = useState('')
  const loadAutoMerge = useCallback(() => {
    fetch('/api/admin/verify-links/auto-merge', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.spec) return
        setAmSpec(d.spec)
        // Only a preview carries the count; a plain read leaves the last one.
        if (d.links !== undefined) setAmCover({ links: Number(d.links) || 0, channels: Number(d.channels) || 0 })
      })
      .catch(() => {})
  }, [])
  const [amCounting, setAmCounting] = useState(false)
  async function countAutoMerge() {
    setAmCounting(true)
    try {
      const res = await fetch('/api/admin/verify-links/auto-merge?preview=1', { cache: 'no-store' })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d?.spec) setAmCover({ links: Number(d.links) || 0, channels: Number(d.channels) || 0 })
      else alert(d?.error || 'Could not count what the spec covers.')
    } finally {
      setAmCounting(false)
    }
  }
  useEffect(() => { loadAutoMerge() }, [loadAutoMerge])

  const toBound = ([lo, hi]: [string, string]): AmBound => [
    lo.trim() === '' || !Number.isFinite(Number(lo)) ? null : Number(lo),
    hi.trim() === '' || !Number.isFinite(Number(hi)) ? null : Number(hi),
  ]
  const fromBound = (b: AmBound): [string, string] => [b[0] === null ? '' : String(b[0]), b[1] === null ? '' : String(b[1])]
  const specFromFilters = (enabled: boolean): AmSpec => ({
    enabled,
    platform: (rankSite as AmSpec['platform']) || '',
    links: toBound(fLinks), hearts: toBound(fHearts), rate: toBound(fRate),
    active: toBound(fActive), last: toBound(fLast), score: toBound(fScore),
  })
  const specText = (sp: AmSpec): string => {
    const part = (label: string, [lo, hi]: AmBound, unit = '') =>
      lo === null && hi === null ? '' : lo !== null && hi !== null ? `${label} ${lo}–${hi}${unit}`
        : lo !== null ? `${label} ≥ ${lo}${unit}` : `${label} ≤ ${hi}${unit}`
    return [
      sp.platform ? sp.platform : '',
      part('links', sp.links), part('avg hearts', sp.hearts), part('posts/day', sp.rate),
      part('active', sp.active, '%'), part('last post', sp.last, 'd'), part('score', sp.score),
    ].filter(Boolean).join(' · ') || 'no filters'
  }
  async function saveAutoMerge(spec: AmSpec, label: string) {
    setAmBusy(label)
    try {
      const res = await fetch('/api/admin/verify-links/auto-merge', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not save the auto-merge spec.'); return }
      setAmSpec(d.spec)
      setAmCover({ links: Number(d.links) || 0, channels: Number(d.channels) || 0 })
    } finally {
      setAmBusy('')
    }
  }
  async function runAutoMerge() {
    if (!confirm(
      'Merge every staged link of the channels meeting the auto-merge spec now' +
      (amCover ? ` (${amCover.links} link(s) from ${amCover.channels} channel(s))` : '') +
      '? No related check.'
    )) return
    setAmBusy('run')
    try {
      const res = await fetch('/api/admin/verify-links/auto-merge', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Auto-merge failed.'); return }
      alert(
        `Merged ${d.added ?? 0} link(s) from ${d.channels ?? 0} channel(s) into the main list` +
        (d.skippedBlocked ? `, skipped ${d.skippedBlocked} already-blocked` : '') +
        ` (removed ${d.removed ?? 0} from verify).`
      )
      loadAutoMerge(); loadAccounts(); fetchPage(0)
    } finally {
      setAmBusy('')
    }
  }

  const needle = rankQuery.trim().replace(/^@/, '').toLowerCase()
  /**
   * Does this channel survive the filters currently on screen?
   *
   * One definition, used by the table AND by the add form, because extraction
   * runs over exactly what the table leaves: a channel that fails this is a
   * channel the ⬇ button will not visit, whatever else the page says.
   */
  const passesChannelFilters = (c: ChannelRank): boolean =>
    (!onlyAdded || c.added) &&
    (rankSite === '' || c.platform === rankSite) &&
    (needle === '' || c.handle.includes(needle)) &&
    inRange(c.links, fLinks) &&
    inRange(c.avgHearts, fHearts) &&
    inRange(c.perDay, fRate) &&
    inRange(c.activePct, fActive) &&
    inRange(c.lastPostDays, fLast) &&
    inRange(c.score, fScore)

  const visibleChannels = (ranked ?? [])
    .map((c, i) => ({ ...c, rank: i + 1 }))
    .filter(passesChannelFilters)
  const channelsFiltered = (ranked?.length ?? 0) !== visibleChannels.length
  // Channels that match the handle search but were removed by the SITE chip.
  //
  // Searching a handle you know is there and getting "no channel matches" reads
  // as a missing channel, not as a filter — the site chip is at the other end
  // of the toolbar and easy to forget. So the empty state names the site the
  // handle is actually on.
  const hiddenBySite =
    rankSite && needle
      ? (ranked ?? []).filter((c) => c.platform !== rankSite && c.handle.includes(needle))
      : []
  // Only TikTok channels can have their recent posts listed — Instagram has no
  // unauthenticated route to a profile's posts, and a YouTube Shorts URL carries
  // no handle to ask about. Counted here so the button offers the number it can
  // really check rather than promising all of them and reporting the shortfall
  // afterwards.
  const extractable = visibleChannels.filter((c) => c.platform === 'tiktok')
  const unlistable = visibleChannels.length - extractable.length

  // How many ranked channels each site has, so the chips can say so and an
  // empty one is visibly empty rather than a filter that returns nothing.
  const addedCount = (ranked ?? []).filter((c) => c.added).length
  const siteCounts = (ranked ?? []).reduce<Record<string, number>>((acc, c) => {
    acc[c.platform] = (acc[c.platform] ?? 0) + 1
    return acc
  }, {})

  /**
   * Download the channels on screen as a profile-URL list.
   *
   * This is what makes the ranked table useful for the sites the ⬇ button
   * cannot reach. Instagram gives no unauthenticated way to list a profile's
   * posts, but 1_tiktok_search_scraper CAN — it drives a real signed-in browser
   * — and its load_accounts() reads exactly this format: one profile URL per
   * line, blank lines and # comments ignored.
   *
   *   python scrape_channels.py --accounts channels-instagram.txt --platform instagram
   *
   * then upload the resulting results/instagram_videos_*.csv back to this page.
   *
   * The FILTERED set, not the whole list, for the same reason extraction uses
   * it: narrowing the table is how a subset gets chosen.
   */
  function exportHandles() {
    if (visibleChannels.length === 0) return
    const stamp = new Date().toISOString().slice(0, 10)
    const site = rankSite || 'all'
    const header = [
      `# ${visibleChannels.length} channel(s) from the ranked list, ${stamp}`,
      `# site: ${site}${channelsFiltered ? ' (filtered)' : ''}`,
      '#',
      '# Scrape these with 1_tiktok_search_scraper, then upload the CSV here:',
      `#   python scrape_channels.py --accounts ${`channels-${site}-${stamp}.txt`}` +
        (rankSite ? ` --platform ${rankSite}` : ''),
      '',
    ]
    const lines = visibleChannels.map((c) => channelUrl(c.handle, c.platform)).filter(Boolean)
    const blob = new Blob([[...header, ...lines].join('\n') + '\n'], {
      type: 'text/plain;charset=utf-8',
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `channels-${site}-${stamp}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  // Walk the ranked channels in order, staging each one's new videos. Each POST
  // works ~40s and says where to resume; this loop drives the progress bar.
  /**
   * Check channels for videos we do not hold yet and stage them in this list.
   *
   * With no argument it uses exactly the channels left on screen — filtering the
   * table IS how a subset is chosen, so extraction follows it rather than the
   * full list.
   *
   * `subset` is for a caller that already knows which channels it means and
   * cannot wait for the table to agree: setRanked only schedules a render, so
   * "add a channel, then extract from it" would otherwise read the list as it
   * was before the add.
   */
  async function extractNew(subset?: ChannelRank[]) {
    if (extracting) { stopExtract.current = true; return }
    if (!subset && (!ranked || ranked.length === 0)) return
    const pick = subset ?? extractable
    const handles = pick.map((c) => c.handle)
    const narrowed = subset ? true : channelsFiltered
    const cannotList = subset ? subset.filter((c) => c.platform !== 'tiktok').length : unlistable
    // Never a silent return. A button press that produces nothing at all is
    // indistinguishable from a broken button, and this is the one path where
    // the set can legitimately be empty.
    if (handles.length === 0) {
      setExNote(
        cannotList
          ? `Nothing to check: all ${cannotList.toLocaleString()} channel(s) in this selection are ` +
            'Instagram or YouTube, whose posts cannot be listed from here. Use 📄 Export handles ' +
            'and the local scraper.'
          : 'Nothing to check: no TikTok channel is in this selection. Clear the filters above the ' +
            'ranked table, or press 📊 Rank channels first.'
      )
      return
    }
    if (!confirm(
      `Check ${handles.length.toLocaleString()}` +
      `${narrowed ? ' filtered' : ''} TikTok channel(s) for new videos?\n\n` +
      (cannotList
        ? `${cannotList.toLocaleString()} channel(s) on screen are not TikTok and cannot be ` +
          'checked: Instagram exposes no way to list a profile\u2019s posts without a login, ' +
          'and a YouTube Shorts link carries no handle. Scrape those with ' +
          '1_tiktok_search_scraper and upload the CSV here.\n\n'
        : '') +
      'New videos are added to THIS verify list only — nothing goes into the main ' +
      'links until you merge it yourself. TikTok exposes only about a dozen recent ' +
      'videos per channel, so this catches up recent posts, not old backlogs.'
    )) return

    stopExtract.current = false
    setExtracting(true)
    setExDone(0); setExNew(0); setExFailed(0)
    setExTotal(handles.length)
    setExNote('Starting…')
    let offset = 0, found = 0, failed = 0
    // Which channels answered with nothing, so a small hand-picked run can say
    // which one rather than how many.
    const emptyHandles: string[] = []
    // Channels TikTok would not answer for. Kept apart from the empty ones
    // because the two call for opposite things: an empty channel is finished
    // with, a refused one has not been looked at and the run wants pressing
    // again.
    let throttled = 0
    const throttledHandles: string[] = []
    // Listed videos the channel had posted BEFORE the newest one we already
    // hold. Shown because a big number here is the back catalogue that used
    // to be staged as if it were new.
    let older = 0
    try {
      for (;;) {
        if (stopExtract.current) { setExNote('Stopped — everything found so far is staged.'); break }
        const res = await fetch('/api/admin/verify-links/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offset, handles }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setExNote(d?.error || 'Extract failed.'); break }
        offset = Number(d.nextOffset) || offset
        found += Number(d.newLinks) || 0
        failed += Number(d.failed) || 0
        older += Number(d.olderSkipped) || 0
        for (const h of (Array.isArray(d.failedHandles) ? d.failedHandles : []) as string[]) {
          if (!emptyHandles.includes(h) && emptyHandles.length < 40) emptyHandles.push(h)
        }
        throttled += Number(d.throttled) || 0
        for (const h of (Array.isArray(d.throttledHandles) ? d.throttledHandles : []) as string[]) {
          if (!throttledHandles.includes(h) && throttledHandles.length < 40) throttledHandles.push(h)
        }
        setExDone(offset); setExNew(found); setExFailed(failed)
        setExTotal(Number(d.total) || handles.length)
        setExNote(
          `${found.toLocaleString()} new link(s) staged so far` +
          (older ? ` — ${older.toLocaleString()} older one(s) passed over` : '') +
          (throttled ? ` — ${throttled.toLocaleString()} refused by TikTok so far` : '') +
          '.'
        )
        if (d.done) {
          const skipped = Number(d.skippedOtherSites) || 0
          setExNote(
            `Done — ${found.toLocaleString()} new link(s) added to this list` +
            (older
              ? `, and ${older.toLocaleString()} older than what we already had were skipped.`
              : '.') +
            (skipped
              ? ` ${skipped.toLocaleString()} channel(s) were not checked: fetching new videos ` +
                'works for TikTok only — scrape Instagram and YouTube channels with ' +
                '1_tiktok_search_scraper and upload the CSV here.'
              : '') +
            // Named, not counted. Over a handful of hand-picked channels
            // "1 returned nothing" is useless and "@ace_the_page returned
            // nothing" is the whole answer.
            (emptyHandles.length
              ? ` ${emptyHandles.length === failed ? '' : `${failed.toLocaleString()} `}` +
                `channel(s) answered with no videos: ` +
                emptyHandles.slice(0, 8).map((h) => `@${h}`).join(', ') +
                (emptyHandles.length > 8 ? `, and ${emptyHandles.length - 8} more` : '') +
                '. Either the handle is wrong or the account is gone or private — open the ' +
                'profile to tell which.'
              : '') +
            // NOT THE SAME AS EMPTY, and this is the message that was missing.
            // TikTok answers a burst with "overload-protect triggered"; those
            // channels were never read, so the run simply wants pressing again.
            (throttled
              ? ` ${throttled.toLocaleString()} channel(s) were NOT checked — TikTok refused ` +
                'the listing (it throttles bursts): ' +
                throttledHandles.slice(0, 8).map((h) => `@${h}`).join(', ') +
                (throttledHandles.length > 8 ? `, and ${throttledHandles.length - 8} more` : '') +
                '. Press ⬇ again in a moment; nothing about them has been decided.'
              : '')
          )
          break
        }
        if (!Number(d.channelsChecked)) { setExNote('No responses — stopped. Try again later.'); break }
      }
      fetchPage(0)
      loadAccounts()
    } finally {
      setExtracting(false)
      stopExtract.current = false
    }
  }

  async function mergeToMain() {
    const urls = rows.map((r) => r.url)
    if (urls.length === 0) { alert('Nothing on this page to merge.'); return }
    if (!confirm(`Merge these ${urls.length} link(s) into the MAIN links list?\nThey'll cluster by posted date only (no search rank), and leave the verify list.`)) return
    setMerging(true)
    try {
      const res = await fetch('/api/admin/verify-links/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Merge failed.'); return }
      const upd = Number(d.updated ?? 0)
      const skipped = Number(d.skippedBlocked ?? 0)
      alert(
        `Merged ${d.added ?? 0} link(s) into the main list` +
        (upd ? `, refreshed the like/view count of ${upd} already-listed link(s)` : '') +
        (skipped ? `, skipped ${skipped} already-blocked link(s)` : '') +
        ` (removed ${d.removed ?? 0} from verify).`
      )
      const mergedOut = d?.removed ?? urls.length
      setTotal((t) => Math.max(0, t - mergedOut))
      setTotalAll((t) => Math.max(0, t - mergedOut))
      // The whole page is merged out — reload to show the next batch.
      await fetchPage(page)
    } finally {
      setMerging(false)
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-4 pb-8">
      {/* Everything above the table is pinned: the toolbar, filters and pager stay
          reachable while a 500-row page scrolls underneath. The page background is
          set explicitly so rows can't show through when it is stuck. */}
      <div className="sticky top-0 z-20 bg-[#09090b] pt-6 sm:pt-8 pb-3 mb-3 border-b border-zinc-800">
      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <h1 className="text-xl font-bold text-white">Links to verify</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Independent staging list ({total.toLocaleString()} link{total === 1 ? '' : 's'}
            {mergeAccounts.size > 0 &&
              ` from ${mergeAccounts.size === 1 ? `@${Array.from(mergeAccounts)[0]}` : `${mergeAccounts.size} channels`}`}
            {platform && ` on ${CLICK_PLATFORM_LABELS[platform] ?? platform}`}
            {genre && ` in ${GENRE_LABELS[genre] ?? genre}`}
            {titleFilter !== 'all' &&
              ` ${titleFilter === 'has' ? 'with' : 'without'} a title`}
            {(mergeAccounts.size > 0 || titleFilter !== 'all' || !!platform || !!genre) &&
              `, of ${totalAll.toLocaleString()}`}
            ). Upload a
            channel CSV, mark &amp; block the humanizer-unrelated ones, then merge the rest into the main list.
          </p>
        </div>
        <Link href="/admin/links" className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors shrink-0">
          Main links →
        </Link>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 my-4">
        <label className="text-sm text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg px-3 py-1.5 cursor-pointer transition-colors">
          {uploading || '⬆ Upload channel CSV'}
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} disabled={!!uploading} className="hidden" />
        </label>
        <button
          type="button" onClick={markUnrelated} disabled={classifying || rows.length === 0}
          title={
            `Classify this page's titles and select the ones that are NOT about ` +
            `${markLabel}. Each link is judged against its own genre, so a page ` +
            `holding more than one is asked a different question per genre.`
          }
          className="text-sm text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {classifying
            ? 'Analyzing…'
            : pageGenres.length === 1
              ? `🤖 Mark ${GENRE_LABELS[pageGenres[0]] ?? pageGenres[0]} unrelated`
              : '🤖 Mark unrelated'}
        </button>
        <button
          type="button" onClick={blockSelected} disabled={deleting || selected.size === 0}
          title="Permanently block these links and drop them from the verify list — they stay hidden even if a future upload re-adds them"
          className="text-sm text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {deleting ? 'Blocking…' : `⛔ Block selected${selected.size ? ` (${selected.size})` : ''}`}
        </button>
        <button
          type="button"
          onClick={mergeToMain}
          // Blocked while rows are selected: a page merge takes EVERY row on the
          // page, so merging with links still ticked would push the very ones you
          // marked as unrelated into the main list. Block them (or untick) first.
          disabled={merging || rows.length === 0 || !classifiedThisPage || selected.size > 0}
          title={
            selected.size > 0
              ? `${selected.size} link(s) are selected — block them (or clear the selection) before merging the page, otherwise they would be merged too.`
              : !classifiedThisPage
                ? "Run the '🤖 Mark unrelated' button on this page first, then you can merge it."
                : 'Merge the links currently on this page into the main links list (date-only clustering)'
          }
          className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {merging ? 'Merging…' : `🔀 Merge this page into main links${rows.length ? ` (${rows.length})` : ''}`}
        </button>
        <button
          type="button"
          onClick={() => setChannelsOpen(true)}
          title="List every staged channel so you can open each one, check it, and merge all of its videos"
          className="text-sm text-white bg-teal-700 hover:bg-teal-600 border border-teal-600 rounded-lg px-3 py-1.5 transition-colors"
        >
          📋 Review channels{accounts.length ? ` (${accounts.length})` : ''}
        </button>
        <button
          type="button"
          onClick={() => {
            setAddOpen((v) => !v)
            if (extras === null) void loadExtras()
          }}
          title={
            'Add a channel that no link in the list belongs to.\n\n' +
            'Every channel here is otherwise worked out from links already held, so a channel ' +
            'nobody has scraped can never be reached: no links means no place in the ranking, ' +
            'which means the extract pass never visits it. This is the way in.'
          }
          className={`text-sm rounded-lg px-3 py-1.5 border transition-colors ${
            addOpen
              ? 'text-white bg-teal-700 border-teal-600'
              : 'text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border-zinc-700'
          }`}
        >
          ➕ Add channel{extras && extras.length ? ` (${extras.length})` : ''}
        </button>
        <button
          type="button"
          onClick={rankChannels}
          disabled={ranking || extracting}
          title="Order every channel by links, average hearts, posting frequency and active/blocked ratio (25% each). Uses data we already hold — nothing is fetched from TikTok."
          className="text-sm text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {ranking ? 'Ranking…' : `📊 Rank channels${ranked ? ` (${ranked.length})` : ''}`}
        </button>
        <button
          type="button"
          onClick={() => void extractNew()}
          disabled={!ranked || extractable.length === 0}
          title={
            !ranked
              ? 'Rank the channels first — extraction follows that order.'
              : channelsFiltered
              ? `Check the ${extractable.length.toLocaleString()} filtered TikTok channel(s) for videos we do not have yet, and stage them in this list.` +
                (unlistable
                  ? ` ${unlistable.toLocaleString()} non-TikTok channel(s) on screen cannot be checked — there is no way to list their posts without a login.`
                  : '')
              : 'Check each channel in ranked order for videos we do not have yet, and stage them in this list. Nothing is added to the main links.'
          }
          className={`text-sm rounded-lg px-3 py-1.5 border transition-colors disabled:opacity-40 ${
            extracting
              ? 'text-amber-200 bg-amber-600/20 border-amber-500/40 hover:bg-amber-600/30'
              : 'text-white bg-zinc-800 hover:bg-zinc-700 border-zinc-700'
          }`}
        >
          {extracting
            ? '■ Stop extracting'
            // A greyed button with "(0)" on it looks broken. When the reason is
            // the site rather than an empty table, the label says the reason.
            : extractable.length === 0 && visibleChannels.length > 0
              ? '⬇ Extract — TikTok only'
              : `⬇ Extract new videos${ranked ? ` (${extractable.length})` : ''}`}
        </button>
        {/* The way in for every site the button above cannot reach. */}
        <button
          type="button"
          onClick={exportHandles}
          disabled={!ranked || visibleChannels.length === 0}
          title={
            'Download the channels on screen as a profile-URL list, ready for ' +
            '1_tiktok_search_scraper.\n\n' +
            'This is how Instagram channels get extracted: the scraper drives a ' +
            'real signed-in browser, which is the only thing that can list an ' +
            'Instagram profile. Scrape, then upload the CSV back to this page.'
          }
          className={`text-sm border disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors ${
            // Highlighted exactly when it is the only one of the two that can
            // do anything — on a site whose profiles cannot be listed.
            extractable.length === 0 && visibleChannels.length > 0
              ? 'text-white bg-teal-700 hover:bg-teal-600 border-teal-600'
              : 'text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border-zinc-700'
          }`}
        >
          📄 Export handles{ranked && visibleChannels.length ? ` (${visibleChannels.length})` : ''}
        </button>
        <label
          className="flex items-center gap-1.5 text-sm text-zinc-400"
          title={
            'Filter the list by platform.\n\n' +
            'Read from each link\u2019s URL, not from the platform it was uploaded ' +
            'as \u2014 an Instagram link mislabelled tiktok still lists under Instagram.'
          }
        >
          Platform:
          <select
            value={platform}
            onChange={(e) => changePlatform(e.target.value)}
            disabled={loading}
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-40"
          >
            <option value="">All platforms</option>
            {CLICK_PLATFORMS.map((k) => {
              const n = platformCounts[k] ?? 0
              return (
                <option key={k} value={k} disabled={n === 0 && platform !== k}>
                  {CLICK_PLATFORM_LABELS[k] ?? k}
                  {n > 0 ? ` (${n.toLocaleString()})` : ' — none'}
                </option>
              )
            })}
          </select>
        </label>
        <label
          className="flex items-center gap-1.5 text-sm text-zinc-400"
          title="Filter the list by whether a link has a title. “Has title” hides every link with no title yet."
        >
          Title:
          <select
            value={titleFilter}
            onChange={(e) => changeTitleFilter(e.target.value as 'all' | 'has' | 'none')}
            disabled={loading}
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-40"
          >
            <option value="all">All</option>
            <option value="has">Has title</option>
            <option value="none">No title</option>
          </select>
        </label>
        {/* Merge a WHOLE channel (every page), judged from its bio + output.
            Searchable: the list runs to hundreds of channels. */}
        <div ref={channelBoxRef} className="relative flex items-center gap-1.5 text-sm text-zinc-400">
          Channel:
          <input
            value={channelMenuOpen ? channelQuery : channelLabel}
            onChange={(e) => { setChannelQuery(e.target.value); setChannelMenuOpen(true) }}
            onFocus={() => setChannelMenuOpen(true)}
            disabled={merging || accounts.length === 0}
            placeholder={accounts.length ? `Search ${accounts.length} channel(s)…` : 'No channels'}
            readOnly={!channelMenuOpen}
            title="Merge every link this channel still has in the verify list"
            className="w-[190px] bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 disabled:opacity-40"
          />
          {mergeAccounts.size > 0 && !channelMenuOpen && (
            <button
              type="button"
              onClick={() => { setPicked(new Set()); setChannelQuery('') }}
              title="Clear the selected channels"
              className="absolute right-1 text-zinc-500 hover:text-white text-xs px-1"
            >
              ✕
            </button>
          )}
          {channelMenuOpen && (
            <div className="absolute top-full left-0 z-30 mt-1 w-[280px] rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl p-1">
              <div className="flex items-center justify-between gap-2 px-1 pb-1 mb-1 border-b border-zinc-800">
                <span className="text-[10px] text-zinc-500">
                  {mergeAccounts.size
                    ? `${mergeAccounts.size} picked · ${pickedLinkCount.toLocaleString()} links`
                    : 'none picked'}
                </span>
                <div className="flex items-center gap-2">
                  {channelMatches.length > 0 && (
                    <button
                      type="button"
                      onClick={toggleAllMatches}
                      className="text-[10px] text-zinc-400 hover:text-white"
                    >
                      {allMatchesPicked ? 'Unpick shown' : `Pick all ${channelMatches.length}`}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPicked(new Set())}
                    disabled={mergeAccounts.size === 0}
                    className="text-[10px] text-zinc-400 hover:text-white disabled:opacity-40"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {channelMatches.length === 0 ? (
                  <div className="px-1 py-3 text-center text-[11px] text-zinc-500">
                    {accounts.length === 0 ? 'No channels staged.' : 'No channel matches that search.'}
                  </div>
                ) : (
                  channelMatches.map((a) => (
                    <label
                      key={a.account}
                      className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-zinc-800 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={mergeAccounts.has(a.account)}
                        onChange={() => {
                          const next = new Set<string>(mergeAccounts)
                          if (next.has(a.account)) next.delete(a.account)
                          else next.add(a.account)
                          setPicked(next)
                        }}
                        className="accent-teal-500"
                      />
                      <span className="flex-1 min-w-0 truncate text-[11px] text-zinc-300">
                        @{a.account}
                      </span>
                      {channelUrl(a.account, a.platform) && (
                        <a
                          href={channelUrl(a.account, a.platform) as string}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title={`Open @${a.account} on ${a.platform || 'tiktok'}`}
                          className="shrink-0 text-[10px] text-zinc-500 hover:text-emerald-400"
                        >
                          ↗
                        </a>
                      )}
                      <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums">
                        {a.n.toLocaleString()}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      </div>


      {/* Add a channel nothing in the list names. */}
      {addOpen && (
        <div className="rounded-xl border border-teal-800/60 bg-teal-950/20 p-3 mb-3">
          <p className="text-sm text-zinc-200 mb-1">Scrape a channel that is not in the list</p>
          <p className="text-[11px] text-zinc-500 mb-2 max-w-3xl">
            Paste the channel&apos;s profile link — that names its site, so there is nothing to
            choose. A bare handle needs the site picked, because the same name exists on more than
            one and guessing would send the scraper to a stranger.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={addInput}
              onChange={(e) => { setAddInput(e.target.value); setAddErr(''); setAddMsg('') }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !addBusy) void addChannel() }}
              placeholder="https://www.tiktok.com/@studyexpert6   or   studyexpert6"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-[18rem] bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
            />
            {/* THE SWITCH'S GENRE, not a choice here: a channel added while
                looking at Website is a website channel. To add one to another
                genre, move the switch at the top first. */}
            <span
              title={
                "This channel's videos join the genre the switch at the top is on.\n\n" +
                'Every video extracted from it inherits it, and only that ' +
                "genre's comments are ever served on them. Move the switch to add " +
                'a channel to another genre.'
              }
              className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-400"
            >
              {GENRE_LABELS[addGenre] ?? addGenre}
            </span>
            <select
              value={detectedSite || addSite}
              onChange={(e) => setAddSite(e.target.value)}
              disabled={!!detectedSite}
              title={detectedSite ? 'The link says which site this is' : 'Which site is this handle on?'}
              className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-200 disabled:opacity-60 focus:outline-none focus:border-emerald-500"
            >
              <option value="">Site…</option>
              <option value="tiktok">TikTok</option>
              <option value="instagram">Instagram</option>
              <option value="youtube">YouTube</option>
            </select>
            <input
              value={addNote}
              onChange={(e) => setAddNote(e.target.value)}
              placeholder="Why? (optional)"
              className="w-56 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
            />
            <button
              type="button"
              onClick={() => void addChannel()}
              disabled={addBusy || !addInput.trim()}
              className="text-sm text-white bg-teal-700 hover:bg-teal-600 border border-teal-600 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
            >
              {addBusy ? 'Checking…' : 'Add'}
            </button>
            {/* The usual next step, without having to find the filter first:
                rank, narrow to the added channels, and extract from those
                alone. */}
            <button
              type="button"
              onClick={() => void extractAdded()}
              disabled={extracting || ranking || (extras !== null && extras.length === 0)}
              title={
                'Check ONLY the channels added by hand for videos we do not hold, and stage ' +
                'them in this list.\n\n' +
                'The ranked table is narrowed to the same set, so what is on screen is what ' +
                'is being worked on.'
              }
              className="text-sm text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
            >
              {extracting
                ? '■ Stop extracting'
                : ranking
                  ? 'Ranking…'
                  : `⬇ Extract from the added channel(s)${extras && extras.length ? ` (${extras.length})` : ''}`}
            </button>
          </div>
          {addErr && <p className="text-xs text-rose-400 mt-2">{addErr}</p>}
          {addMsg && <p className="text-xs text-emerald-300 mt-2">{addMsg}</p>}
          {/* The add worked, the channel is ranked, and the filters on the table
              are hiding it — so ⬇ Extract would walk straight past it. Said
              here, next to the message that promised extraction, rather than
              left to be worked out from a button that looks broken. */}
          {addHidden && (
            <p className="text-xs text-amber-300 mt-2 flex flex-wrap items-center gap-2">
              <span>
                …but the ranked table&apos;s filters are hiding @{addHidden.handle}, and
                extraction only visits what is on screen.
                {fLinks[0] ? ' A minimum-links filter is set, and a channel we hold no links from cannot pass it.' : ''}
              </span>
              <button
                type="button"
                onClick={() => {
                  clearChannelFilters()
                  setRankSite('')
                  setAddHidden(null)
                }}
                className="text-[11px] text-white bg-amber-700 hover:bg-amber-600 border border-amber-600 rounded px-2 py-0.5"
              >
                Clear the filters and show it
              </button>
            </p>
          )}
          <p className="text-[11px] text-zinc-500 mt-2">
            <span className="text-zinc-400">⬇ Extract from the added channel(s)</span> checks these
            and nothing else — it narrows the ranked table to them first, so what is on screen is
            what is being worked on. (The same thing by hand: the{' '}
            <span className="text-zinc-400">Added by hand</span> chip above the table, then{' '}
            <span className="text-zinc-400">⬇ Extract new videos</span>.) A channel added here also
            goes to the TOP of the full ranked list until it has links of its own, so an ordinary
            extraction reaches it first rather than behind four thousand others. Instagram and
            YouTube cannot be listed from here at all —{' '}
            <span className="text-zinc-400">📄 Export handles</span> and the local scraper.
          </p>

          {extras && extras.length > 0 && (
            <div className="mt-3 border-t border-teal-800/40 pt-2">
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">
                {extras.length} channel(s) added by hand
              </p>
              {extras.map((c) => (
                <div key={`${c.site}:${c.handle}`} className="flex items-center gap-3 text-xs py-0.5">
                  {/* Named per row: a channel filed under the wrong genre stages
                      its videos into the wrong pool, and re-adding it with the
                      right one is the fix — which nobody can do without being
                      able to see what it is now. */}
                  <span
                    className={
                      c.genre === DEFAULT_GENRE ? 'text-zinc-600 shrink-0' : 'text-amber-300/80 shrink-0'
                    }
                    title={`Its videos join the ${GENRE_LABELS[c.genre] ?? c.genre} pool. Re-add the channel to change this.`}
                  >
                    {GENRE_LABELS[c.genre] ?? c.genre}
                  </span>
                  <a
                    href={channelUrl(c.handle, c.site) as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-56 truncate text-zinc-300 hover:text-emerald-400"
                  >
                    @{c.handle}
                    <span className="ml-1.5 text-[10px] text-zinc-600">{c.site}</span>
                  </a>
                  <span className="flex-1 truncate text-zinc-500">{c.note || ''}</span>
                  <span className="text-[10px] text-zinc-600 tabular-nums">
                    {new Date(c.addedAt).toLocaleDateString()}
                  </span>
                  <button
                    type="button"
                    onClick={() => void removeChannel(c.site, c.handle)}
                    title={
                      'Stop treating this as a channel you asked for.\n\n' +
                      'Links already scraped from it stay in the pool and it keeps its place in ' +
                      'the ranking on their strength \u2014 this removes the request, not the work.'
                    }
                    className="text-zinc-600 hover:text-rose-400 px-1"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Ranked channels — the order extraction follows. Filters below each
          column narrow it, and extraction uses exactly what survives them. */}
      {ranked && showRanked && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 mb-3">
          <div className="flex flex-wrap items-center gap-2 p-3 border-b border-zinc-800">
            <span className="text-sm text-zinc-200">
              {ranked.length.toLocaleString()} channels, best first
              <span className="text-zinc-500 font-normal">
                {' '}· links, avg hearts, post rate and active% weighted 25% each
              </span>
              {/* Every link we hold is either attributed to a channel above or
                  counted here. Without this, links whose channel cannot be read
                  look like channels missing from the list. */}
              {unattributed && unattributed.total > 0 && (
                <span
                  className="ml-2 text-[11px] text-amber-400/80 font-normal"
                  title={
                    'Links whose channel cannot be worked out, so they belong to no row above.\n\n' +
                    Object.entries(unattributed.byPlatform)
                      .sort((a, b) => b[1] - a[1])
                      .map(([p, n]) => `${p}: ${n.toLocaleString()}`)
                      .join('\n') +
                    '\n\nA YouTube Shorts URL is /shorts/<id> and names nobody. An Instagram ' +
                    'post is /p/<code>/ and only names its account when the scrape stored one.'
                  }
                >
                  {unattributed.total.toLocaleString()} link(s) have no readable channel
                </span>
              )}
            </span>
            <button
              onClick={() => setShowRanked(false)}
              className="ml-auto text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-2 py-0.5"
            >
              hide
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            <div className="sticky top-0 bg-zinc-900 border-b border-zinc-800">
              <div className="flex items-center gap-3 px-3 pt-1.5 text-[11px] text-zinc-500">
                <span className="w-12 shrink-0 text-right">#</span>
                <span className="flex-1 min-w-0">channel</span>
                <span className="w-16 shrink-0 text-right">links</span>
                <span className="w-20 shrink-0 text-right">avg ♥</span>
                <span className="w-20 shrink-0 text-right">posts/day</span>
                <span className="w-28 shrink-0 text-right">active %</span>
                <span className="w-20 shrink-0 text-right">last post</span>
                <span className="w-16 shrink-0 text-right">score</span>
              </div>
              {/* One min/max pair per column. Extraction runs over exactly what
                  survives these, so this is how a subset is chosen. */}
              {/* Site chips. Ranking works for every platform — it reads only
                  data we already hold — so this is what makes the Instagram
                  channels reachable. Extraction is a separate question, marked
                  on each chip. */}
              <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
                {/* Extraction runs over exactly what these filters leave, so
                    this IS "extract from the added channels only" — the same
                    mechanism as every other narrowing, rather than a second
                    one beside it. */}
                {addedCount > 0 && (
                  <button
                    onClick={() => setOnlyAdded((v) => !v)}
                    title={
                      'Show only the channels you added by hand.\n\n' +
                      'Extraction visits exactly the channels on screen, so with this on ' +
                      '↓ Extract new videos checks those and nothing else.'
                    }
                    className={`text-[11px] rounded px-2 py-0.5 border transition-colors ${
                      onlyAdded
                        ? 'bg-teal-600 border-teal-500 text-white'
                        : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    Added by hand ({addedCount})
                  </button>
                )}
                {([
                  ['', 'All'],
                  ['tiktok', 'TikTok'],
                  ['instagram', 'Instagram'],
                  ['youtube', 'YouTube'],
                ] as const).map(([key, label]) => {
                  const n = key === '' ? (ranked?.length ?? 0) : siteCounts[key] ?? 0
                  const listable = key === '' || key === 'tiktok'
                  return (
                    <button
                      key={key || 'all'}
                      type="button"
                      onClick={() => setRankSite(key)}
                      disabled={n === 0 && rankSite !== key}
                      title={
                        listable
                          ? 'Rank and extract both work here'
                          : 'Ranking works here. Extracting does not: this site gives no way ' +
                            'to list a profile’s posts without a login. Use “Export handles” ' +
                            'and scrape them with 1_tiktok_search_scraper instead.'
                      }
                      className={`text-[11px] rounded px-2 py-0.5 border transition-colors disabled:opacity-30 ${
                        rankSite === key
                          ? 'bg-teal-600 text-white border-teal-500'
                          : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:bg-zinc-800'
                      }`}
                    >
                      {label} {n.toLocaleString()}
                      {!listable && n > 0 && (
                        <span className="ml-1 text-amber-400/80">export to scrape</span>
                      )}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-3 px-3 pb-1.5 pt-1">
                <span className="w-12 shrink-0" />
                <span className="flex-1 min-w-0">
                  <input
                    value={rankQuery}
                    onChange={(e) => setRankQuery(e.target.value)}
                    placeholder="handle…"
                    className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
                  />
                </span>
                {([
                  [fLinks, setFLinks, 'w-16'],
                  [fHearts, setFHearts, 'w-20'],
                  [fRate, setFRate, 'w-20'],
                  [fActive, setFActive, 'w-28'],
                  [fLast, setFLast, 'w-20'],
                  [fScore, setFScore, 'w-16'],
                ] as const).map(([val, set, w], i) => (
                  <span key={i} className={`${w} shrink-0 flex items-center gap-0.5`}>
                    <input
                      value={val[0]}
                      onChange={(e) => set([e.target.value, val[1]])}
                      placeholder="min"
                      inputMode="decimal"
                      className="w-full min-w-0 bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-right text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
                    />
                    <input
                      value={val[1]}
                      onChange={(e) => set([val[0], e.target.value])}
                      placeholder="max"
                      inputMode="decimal"
                      className="w-full min-w-0 bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-right text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
                    />
                  </span>
                ))}
              </div>
            </div>
            {visibleChannels.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-zinc-500">
                No channel matches these filters.
                {hiddenBySite.length > 0 && (
                  <>
                    <br />
                    <span className="text-zinc-400">
                      {hiddenBySite.length === 1
                        ? `@${hiddenBySite[0].handle} is on ${hiddenBySite[0].platform}`
                        : `${hiddenBySite.length} matching channel(s) are on other sites`}
                      {' — '}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRankSite('')}
                      className="text-teal-400 underline hover:text-teal-300"
                    >
                      show all sites
                    </button>
                  </>
                )}
              </div>
            ) : (
              visibleChannels.map((c) => (
                <div
                  // Site AND handle: 98 handles exist on two sites, and a
                  // duplicate key makes React reuse the wrong row.
                  key={`${c.platform}:${c.handle}`}
                  className="flex items-center gap-3 px-3 py-1 text-xs border-b border-zinc-800/50 hover:bg-zinc-800/40"
                >
                  <span className="w-12 shrink-0 text-right text-zinc-600 tabular-nums">{c.rank}</span>
                  <a
                    href={channelUrl(c.handle, c.platform) as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open @${c.handle} on ${c.platform}`}
                    className="flex-1 min-w-0 truncate text-zinc-300 hover:text-emerald-400"
                  >
                    @{c.handle}
                    {/* Which site this handle is on. The same name can exist on
                        two of them, and the row is otherwise identical. */}
                    <span
                      className={`ml-1.5 text-[10px] ${
                        c.platform === 'tiktok' ? 'text-zinc-600' : 'text-amber-400/70'
                      }`}
                      title={
                        c.platform === 'tiktok'
                          ? 'Can be ranked and extracted'
                          : 'Ranked only — its posts cannot be listed without a login'
                      }
                    >
                      {c.platform}
                    </span>
                    {/* A row with no links and no history looks like a fault
                        unless it says why it is there. */}
                    {c.added && (
                      <span
                        className="ml-1.5 text-[10px] text-teal-300"
                        title={
                          c.links === 0
                            ? 'Added by hand, and we hold no links from it yet \u2014 so it is first in line for the next extraction.'
                            : 'Added by hand. It has links of its own now, so it ranks on them like every other channel.'
                        }
                      >
                        added
                      </span>
                    )}
                  </a>
                  <span className="w-16 shrink-0 text-right text-zinc-400 tabular-nums">
                    {c.links.toLocaleString()}
                  </span>
                  <span className="w-20 shrink-0 text-right text-zinc-400 tabular-nums">
                    {c.avgHearts === null ? '—' : Math.round(c.avgHearts).toLocaleString()}
                  </span>
                  <span className="w-20 shrink-0 text-right text-zinc-400 tabular-nums">
                    {c.perDay === null ? '—' : c.perDay.toFixed(2)}
                  </span>
                  <span
                    className="w-28 shrink-0 text-right text-zinc-400 tabular-nums"
                    title={`${c.active.toLocaleString()} active, ${c.blocked.toLocaleString()} blocked (including links no longer in the pool)`}
                  >
                    {c.activePct === null ? '—' : `${c.activePct}%`}
                    <span className="text-zinc-600">
                      {' '}{c.active.toLocaleString()}/{c.blocked.toLocaleString()}
                    </span>
                  </span>
                  <span
                    className="w-20 shrink-0 text-right text-zinc-400 tabular-nums"
                    title="Days since the most recent post we know of"
                  >
                    {c.lastPostDays === null ? '—' : `${c.lastPostDays}d`}
                  </span>
                  <span className="w-16 shrink-0 text-right text-emerald-400 tabular-nums">
                    {c.score.toFixed(3)}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="flex items-center gap-2 px-3 py-2 text-xs border-t border-zinc-800">
            <span className="text-zinc-600">
              {channelsFiltered
                ? `${visibleChannels.length.toLocaleString()} of ${ranked.length.toLocaleString()} channels — extraction uses these only`
                : `all ${ranked.length.toLocaleString()} channels — extraction walks them in this order`}
            </span>
            {channelsFiltered && (
              <button
                onClick={clearChannelFilters}
                className="ml-auto text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-2 py-0.5"
              >
                Clear filters
              </button>
            )}
          </div>
          {/* AUTO-MERGE SPEC: these filters, saved for this genre. */}
          <div className={`px-3 py-2.5 text-xs border-t border-zinc-800 ${amSpec?.enabled ? 'bg-emerald-950/20' : ''}`}>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-zinc-200 font-medium cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-emerald-500"
                  checked={!!amSpec?.enabled}
                  disabled={!amSpec || amBusy !== ''}
                  onChange={(e) => amSpec && saveAutoMerge({ ...amSpec, enabled: e.target.checked }, 'toggle')}
                />
                Auto-merge channels meeting the spec
              </label>
              <span className="text-zinc-500">
                ({GENRE_LABELS[genre] ?? genre}) spec: <span className="text-zinc-300">{amSpec ? specText(amSpec) : '…'}</span>
              </span>
              {amCover && amSpec ? (
                <span className="text-zinc-500">
                  · covers <span className="text-zinc-300 tabular-nums">{amCover.links.toLocaleString()}</span> staged
                  link(s) from <span className="text-zinc-300 tabular-nums">{amCover.channels.toLocaleString()}</span> channel(s) now
                </span>
              ) : amSpec ? (
                <button
                  type="button"
                  onClick={countAutoMerge}
                  disabled={amCounting}
                  className="text-zinc-400 hover:text-zinc-200 underline decoration-dotted disabled:opacity-50"
                >
                  {amCounting ? 'counting… (ranks every channel, up to a minute)' : 'count what it covers'}
                </button>
              ) : null}
              <span className="ml-auto flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={amBusy !== ''}
                  onClick={() => saveAutoMerge(specFromFilters(!!amSpec?.enabled), 'save')}
                  title="Save the site chip and the min/max filters above as this genre's auto-merge spec"
                  className="text-zinc-200 border border-zinc-700 hover:bg-zinc-800 rounded px-2 py-0.5 disabled:opacity-40"
                >
                  {amBusy === 'save' ? 'Saving…' : 'Save filters as spec'}
                </button>
                <button
                  type="button"
                  disabled={!amSpec}
                  onClick={() => {
                    if (!amSpec) return
                    setRankSite(amSpec.platform)
                    setFLinks(fromBound(amSpec.links)); setFHearts(fromBound(amSpec.hearts)); setFRate(fromBound(amSpec.rate))
                    setFActive(fromBound(amSpec.active)); setFLast(fromBound(amSpec.last)); setFScore(fromBound(amSpec.score))
                  }}
                  title="Put the saved spec into the filters, to see which channels it covers"
                  className="text-zinc-400 border border-zinc-700 hover:bg-zinc-800 rounded px-2 py-0.5 disabled:opacity-40"
                >
                  Show spec's channels
                </button>
                <button
                  type="button"
                  disabled={!amSpec?.enabled || amBusy !== '' || (amCover !== null && !amCover.links)}
                  onClick={runAutoMerge}
                  title="Merge what the spec covers now instead of waiting for the next hourly harvest"
                  className="text-white bg-emerald-600 hover:bg-emerald-500 rounded px-2 py-0.5 disabled:opacity-40"
                >
                  {amBusy === 'run' ? 'Merging…' : 'Run now'}
                </button>
              </span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-600 leading-relaxed">
              On, every staged link of a channel that meets the spec is merged into the main links on each
              hourly harvest pass — whether the harvest or Extract staged it — <b className="text-zinc-500">without
              the related check</b>, so off-topic videos from those channels go in too. Instagram has no
              Active %, so an Active % bound leaves Instagram channels out.
            </p>
          </div>
        </div>
      )}


      {/* Table */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden" style={{ overflowAnchor: 'none' }}>
      {/* Header and rows in ONE scroller, at a fixed minimum width, so a
          search that narrows the rows cannot take the scroll away. */}
      <ScrollX min={860}>
        <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-xs text-zinc-400 font-medium">
          <span className="w-6 flex justify-center">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-teal-500 cursor-pointer" />
          </span>
          <span className="w-28 shrink-0">Account / Bio</span>
          <span className="flex-1 min-w-0">Title / URL</span>
          <span className="w-40 shrink-0 text-right">Views · Hearts</span>
          <span className="w-24 shrink-0 text-right">Posted</span>
          <span
            className="w-28 shrink-0 text-right"
            title="Share of this channel's links that are still active (not blocked), with the active/blocked counts behind it. Instagram has none: its post links do not name the channel, so its blocked links cannot be counted."
          >
            {statsState === 'loading' ? (
              'Active % …'
            ) : statsState === 'failed' ? (
              <button
                type="button"
                onClick={loadChannelStats}
                title="The Active % numbers could not be loaded. Press to try again."
                className="text-rose-400 hover:text-rose-300 underline decoration-dotted"
              >
                Active % ⚠ retry
              </button>
            ) : (
              'Active %'
            )}
          </span>
        </div>
        {loading ? (
          <p className="text-sm text-zinc-500 text-center py-12">Loading…</p>
        ) : displayRows.length === 0 ? (
          <p className="text-sm text-zinc-500 text-center py-12">No links. Upload a channel CSV to begin.</p>
        ) : (
          rowGroups.map((g) => {
            const staged = stagedFor(g.account)
            const href = channelUrl(g.account, g.platform)
            const groupUrls = g.rows.map((r) => r.url)
            const allPicked = groupUrls.every((u) => selected.has(u))
            return (
            <div key={`${g.account ?? 'none'}-${g.rows[0].url}`}>
            {/* One heading per channel. A channel is judged as a whole, so its
                name, bio and controls belong once above its links rather than
                repeated on every row. */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/70 border-y border-zinc-800 sticky top-0 z-10">
              <span className="w-6 shrink-0 flex justify-center">
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={() => {
                    const n = new Set(selected)
                    for (const u of groupUrls) allPicked ? n.delete(u) : n.add(u)
                    changeSelection(groupUrls, n)
                  }}
                  title={allPicked ? "Unselect this channel's links on this page" : "Select this channel's links on this page"}
                  className="accent-teal-500 cursor-pointer"
                />
              </span>
              <span className="min-w-0 flex items-center gap-1.5">
                <span className="text-sm text-zinc-100 truncate">@{g.account || 'no channel'}</span>
                {/* WHICH POOL THESE WILL JOIN. Worth seeing before pressing
                    Merge: it is the last moment the choice can be corrected,
                    and afterwards only the Links page says so. Dim for the
                    default, lit for anything else, so a mis-filed channel
                    catches the eye rather than having to be looked for. */}
                <span
                  className={
                    (g.genre && g.genre !== DEFAULT_GENRE
                      ? 'text-amber-300/90 border-amber-400/30'
                      : 'text-zinc-500 border-zinc-700') +
                    ' shrink-0 text-[10px] uppercase tracking-wide border rounded px-1 py-px'
                  }
                  title={`Merging these adds them to the ${GENRE_LABELS[g.genre] ?? g.genre} pool, where only that genre's comments are served.`}
                >
                  {GENRE_LABELS[g.genre] ?? g.genre}
                </span>
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open @${g.account} on ${g.platform || 'tiktok'} in a new tab`}
                    className="shrink-0 text-xs text-emerald-400 hover:text-emerald-300"
                  >
                    ↗
                  </a>
                )}
              </span>
              <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                {g.rows.length.toLocaleString()} here
                {staged !== null && staged !== g.rows.length && (
                  <span className="text-zinc-600"> · {staged.toLocaleString()} staged</span>
                )}
              </span>
              {g.bio && (
                <span className="flex-1 min-w-0 truncate text-[11px] text-zinc-600" title={g.bio}>
                  {g.bio}
                </span>
              )}
              {g.account && (
                <button
                  type="button"
                  disabled={merging}
                  onClick={() => mergeChannels([g.account as string])}
                  title={`Merge every link from @${g.account} into the main list — the whole channel, across all pages`}
                  className="ml-auto shrink-0 text-[11px] text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded px-2 py-0.5 transition-colors"
                >
                  🔀 merge channel
                </button>
              )}
            </div>
            {g.rows.map((r) => (
            <div key={r.url} data-vrow={r.url} className={`flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 text-sm ${selected.has(r.url) ? 'bg-amber-500/15 border-l-4 border-l-amber-400 pl-2' : ''}`}>
              <span className="w-6 shrink-0 flex justify-center">
                <input type="checkbox" checked={selected.has(r.url)} onChange={() => toggle(r.url)} className="accent-teal-500 cursor-pointer" />
              </span>
              <span className="w-28 shrink-0 min-w-0">
                <span className="flex items-center gap-1 min-w-0">
                  <span className="truncate text-xs text-zinc-400" title={r.account || ''}>{r.account || '—'}</span>
                  {channelUrl(r.account, r.platform) && (
                    <a
                      href={channelUrl(r.account, r.platform) as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open @${r.account} in a new tab`}
                      aria-label={`Open the channel @${r.account} in a new tab`}
                      // Row clicks toggle selection; keep that from firing here.
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 text-zinc-600 hover:text-emerald-400 transition-colors leading-none"
                    >
                      ↗
                    </a>
                  )}
                  {r.account && (
                    <button
                      type="button"
                      disabled={merging}
                      onClick={(e) => { e.stopPropagation(); mergeChannels([r.account as string]) }}
                      title={`Merge every link from @${r.account} into the main list (the whole channel, not just this row)`}
                      aria-label={`Merge the whole channel @${r.account} into the main links`}
                      className="shrink-0 text-zinc-600 hover:text-emerald-400 disabled:opacity-40 transition-colors leading-none"
                    >
                      🔀
                    </button>
                  )}
                </span>
                {/* The channel's bio: usually the clearest signal of whether the
                    account is humanizer-related, without opening the video. */}
                <span
                  className="block truncate text-[10px] text-zinc-600 leading-tight"
                  title={r.bio || 'no bio'}
                >
                  {r.bio || '—'}
                </span>
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-zinc-200 text-xs leading-tight line-clamp-2" title={r.title || ''}>{r.title || '—'}</span>
                <a href={r.url} target="_blank" rel="noopener noreferrer" className="block text-[11px] text-zinc-500 hover:text-emerald-400 truncate">{r.url}</a>
              </span>
              <span className="w-40 shrink-0 text-right text-xs text-zinc-400 tabular-nums">{fmt(r.view_count)} · {fmt(r.heart_count)}</span>
              <span className="w-24 shrink-0 text-right text-xs text-zinc-500">{r.posted_date || '—'}</span>
              {(() => {
                const st = r.account ? channelStats?.[r.account.toLowerCase()] : null
                const tot = st ? st.active + st.blocked : 0
                const pct = tot > 0 ? Math.round((st!.active / tot) * 100) : null
                return (
                  <span
                    className={`w-28 shrink-0 text-right text-xs tabular-nums ${
                      pct === null ? 'text-zinc-600'
                        : pct >= 80 ? 'text-emerald-400'
                        : pct >= 50 ? 'text-amber-400'
                        : 'text-rose-400'
                    }`}
                    title={
                      st
                        ? `@${r.account}: ${st.active.toLocaleString()} active, ` +
                          `${st.blocked.toLocaleString()} blocked (including links no longer ` +
                          `in the pool) = ${pct}% active`
                        : r.platform === 'instagram'
                          ? 'Not available for Instagram: its post links do not name the channel, so blocked ones cannot be traced back to it'
                          : statsState === 'failed'
                            ? 'The Active % numbers could not be loaded — press retry in the column header'
                            : statsState === 'loading'
                              ? 'Loading…'
                              : 'This channel has no links in the main list yet'
                    }
                  >
                    {pct === null || !st ? (
                      '—'
                    ) : (
                      <>
                        {pct}%
                        <span className="text-zinc-600">
                          {' '}{st.active.toLocaleString()}/{st.blocked.toLocaleString()}
                        </span>
                      </>
                    )}
                  </span>
                )
              })()}
            </div>
            ))}
            </div>
          )})
        )}
      </ScrollX>
      </div>
      {/* Every staged channel, to be reviewed one at a time */}
      {channelsOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center p-0 sm:p-4 overflow-y-auto"
          onClick={() => setChannelsOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl mt-0 sm:mt-6 rounded-none sm:rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-zinc-800">
              <div>
                <h2 className="text-sm font-semibold text-white">Channels staged for review</h2>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  Open a channel, decide, then merge all of its videos or set it aside.
                  Merging takes the channel in full, across every page.
                </p>
              </div>
              <button
                onClick={() => setChannelsOpen(false)}
                className="text-zinc-500 hover:text-white text-lg leading-none"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="p-4">
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <input
                  value={chanQuery}
                  onChange={(e) => setChanQuery(e.target.value)}
                  placeholder="Find a channel…"
                  className="flex-1 min-w-[10rem] bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
                />
                <select
                  value={chanSort}
                  onChange={(e) => setChanSort(e.target.value as 'links' | 'name')}
                  className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500"
                >
                  <option value="links">Most links first</option>
                  <option value="name">By name</option>
                </select>
                {chanHidden.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setChanHidden(new Set())}
                    title="Bring back the channels you set aside this session"
                    className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg px-2 py-1.5"
                  >
                    show {chanHidden.size} set aside
                  </button>
                )}
              </div>
              <p className="text-[11px] text-zinc-500 mb-2">
                {chanShown.length.toLocaleString()} channel(s) · {chanLinksShown.toLocaleString()} link(s)
                {chanSeen.size > 0 && <> · {chanSeen.size.toLocaleString()} opened</>}
              </p>

              {chanShown.length === 0 ? (
                <p className="text-sm text-zinc-500 py-10 text-center">
                  {accounts.length === 0
                    ? 'No channels staged. Upload a channel CSV first.'
                    : 'Nothing matches — clear the search, or bring back the ones you set aside.'}
                </p>
              ) : (
                <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-zinc-800 divide-y divide-zinc-800/60">
                  {chanShown.map((a) => {
                    const href = channelUrl(a.account, a.platform)
                    const seen = chanSeen.has(a.account)
                    return (
                      <div
                        key={a.account}
                        className={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-900/60 ${
                          seen ? 'bg-zinc-900/40' : ''
                        }`}
                      >
                        <span className="w-16 shrink-0 text-right text-xs text-zinc-500 tabular-nums">
                          {a.n.toLocaleString()}
                        </span>
                        <span className="w-20 shrink-0 text-[10px] text-zinc-600">{a.platform}</span>
                        <span className="flex-1 min-w-0 truncate text-zinc-200">
                          @{a.account}
                          {seen && <span className="ml-1.5 text-[10px] text-zinc-600">opened</span>}
                        </span>
                        {href && (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            // Opening IS the review step, so it marks the row —
                            // 2,000 channels is far too many to hold in your head.
                            onClick={() =>
                              setChanSeen((prev) => new Set(prev).add(a.account))
                            }
                            title={`Open @${a.account} on ${a.platform || 'tiktok'} in a new tab`}
                            className="shrink-0 text-xs text-emerald-400 hover:text-emerald-300 border border-emerald-500/30 rounded-lg px-2 py-1"
                          >
                            ↗ view
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => void mergeOneChannel(a.account)}
                          disabled={merging || chanBusy !== ''}
                          title={`Merge all ${a.n.toLocaleString()} of @${a.account}'s staged links into the main list`}
                          className="shrink-0 text-xs text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg px-2 py-1 transition-colors"
                        >
                          {chanBusy === a.account ? 'Merging…' : '🔀 merge all'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setChanHidden((prev) => new Set(prev).add(a.account))
                          }
                          title="Set aside for now — hidden until you reopen this page. Nothing is deleted or blocked."
                          className="shrink-0 text-xs text-zinc-500 hover:text-zinc-200 border border-zinc-700 rounded-lg px-2 py-1"
                        >
                          skip
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
