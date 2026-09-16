'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import ScrollX from '@/components/ScrollX'
import { CLICK_PLATFORMS, CLICK_PLATFORM_LABELS } from '@/lib/config'

const PAGE_SIZE = 500
const UPLOAD_CHUNK = 500 // rows per upload request
const CLASSIFY_BATCHES = 5 // split a page's titles into up to this many Groq batches

interface VRow {
  url: string
  account: string | null
  platform: string
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
}

export default function VerifyLinks() {
  const [rows, setRows] = useState<VRow[]>([])
  const [total, setTotal] = useState(0)          // count matching the active filter
  const [totalAll, setTotalAll] = useState(0)    // count for the whole list, filter ignored
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pinSelected, setPinSelected] = useState(false)
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
      } else {
        alert(d?.error || 'Could not load the verify list.')
      }
    } finally {
      setSelected(new Set())
      setPinSelected(false)
      setClassifiedThisPage(false) // a freshly-loaded page must be re-classified before merge
      setLoading(false)
    }
  }, [titleFilter, platform, mergeAccounts])

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
  useEffect(() => {
    fetch('/api/admin/links/channel-stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.stats) setChannelStats(d.stats) })
      .catch(() => {})
  }, [])

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

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Selected rows float to the top of the page after "Mark unrelated".
  const displayRows = useMemo(() => {
    if (!pinSelected || selected.size === 0) return rows
    const sel: VRow[] = []
    const rest: VRow[] = []
    for (const r of rows) (selected.has(r.url) ? sel : rest).push(r)
    return [...sel, ...rest]
  }, [rows, pinSelected, selected])

  // Consecutive rows of the same channel, so the table can print one heading per
  // channel instead of repeating the account on every line. The query already
  // returns each channel's links in one run (see getVerifyLinks); this only has
  // to notice where a run starts and ends.
  //
  // Built from displayRows, not rows: with "Mark unrelated" pinning selections
  // to the top the display order is what the reader sees, and a heading that
  // disagreed with it would be worse than none.
  const rowGroups = useMemo(() => {
    const out: { account: string | null; platform: string | null; bio: string | null; rows: VRow[] }[] = []
    for (const r of displayRows) {
      const key = (r.account || '').toLowerCase()
      const last = out[out.length - 1]
      if (last && (last.account || '').toLowerCase() === key) last.rows.push(r)
      else out.push({ account: r.account, platform: r.platform, bio: r.bio, rows: [r] })
    }
    return out
  }, [displayRows])

  /** How many links this channel has staged in TOTAL, not just on this page. */
  const stagedFor = (account: string | null) =>
    accounts.find((a) => a.account.toLowerCase() === (account || '').toLowerCase())?.n ?? null

  const toggle = (url: string) =>
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(url)) n.delete(url); else n.add(url)
      return n
    })
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.url))
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.url)))

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
  async function markUnrelated() {
    const items = rows.filter((r) => r.title).map((r) => ({ url: r.url, title: r.title as string }))
    if (items.length === 0) {
      // Nothing to classify on this page → count it as reviewed so merge can proceed.
      setClassifiedThisPage(true)
      alert('No titles on this page to classify — you can merge it as-is.')
      return
    }
    setClassifying(true)
    try {
      const batchSize = Math.max(1, Math.ceil(items.length / CLASSIFY_BATCHES))
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
      setPinSelected(true)
      setClassifiedThisPage(true) // this page is now reviewed → merge is allowed
      alert(`Selected ${unrelated.length} humanizer-unrelated link(s) of ${items.length} — floated to the top. Review, then Block.`)
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
      setPinSelected(false)
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
      titleFilter !== 'all' || platform
        ? ` — including the ones the ${[platform && 'Platform', titleFilter !== 'all' && 'Title']
            .filter(Boolean)
            .join(' and ')} filter${platform && titleFilter !== 'all' ? 's are' : ' is'} currently hiding`
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
      setRows([]); setTotal(0); setTotalAll(0); setSelected(new Set()); setPinSelected(false); setPage(0)
      alert(`Cleaned ${d?.removed ?? 0} link(s) from the verify list.`)
    } finally {
      setCleaning(false)
    }
  }

  // ── Merge the current page's remaining links into the main pool ─────────────
  // Rank every channel from data we already hold — no network, so it returns at
  // once. Nothing is fetched from TikTok until the extract button is pressed.
  async function rankChannels() {
    setRanking(true)
    setExNote('')
    try {
      const res = await fetch('/api/admin/verify-links/extract')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not rank channels.'); return }
      setRanked(Array.isArray(d.channels) ? d.channels : [])
      setUnattributed(d.unattributed ?? null)
      setShowRanked(true)
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

  const needle = rankQuery.trim().replace(/^@/, '').toLowerCase()
  const visibleChannels = (ranked ?? [])
    .map((c, i) => ({ ...c, rank: i + 1 }))
    .filter(
      (c) =>
        (rankSite === '' || c.platform === rankSite) &&
        (needle === '' || c.handle.includes(needle)) &&
        inRange(c.links, fLinks) &&
        inRange(c.avgHearts, fHearts) &&
        inRange(c.perDay, fRate) &&
        inRange(c.activePct, fActive) &&
        inRange(c.lastPostDays, fLast) &&
        inRange(c.score, fScore)
    )
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
  async function extractNew() {
    if (extracting) { stopExtract.current = true; return }
    if (!ranked || ranked.length === 0) return
    // Exactly the channels left on screen. Filtering the table IS the way to
    // choose a subset, so extraction must follow it rather than the full list.
    const handles = extractable.map((c) => c.handle)
    if (handles.length === 0) return
    if (!confirm(
      `Check ${handles.length.toLocaleString()}` +
      `${channelsFiltered ? ' filtered' : ''} TikTok channel(s) for new videos?\n\n` +
      (unlistable
        ? `${unlistable.toLocaleString()} channel(s) on screen are not TikTok and cannot be ` +
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
        setExDone(offset); setExNew(found); setExFailed(failed)
        setExTotal(Number(d.total) || handles.length)
        setExNote(
          `${found.toLocaleString()} new link(s) staged so far` +
          (older ? ` — ${older.toLocaleString()} older one(s) passed over.` : '.')
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
            {titleFilter !== 'all' &&
              ` ${titleFilter === 'has' ? 'with' : 'without'} a title`}
            {(mergeAccounts.size > 0 || titleFilter !== 'all' || !!platform) &&
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
          title="Classify this page's titles with Groq (5 batches) and select the humanizer-unrelated ones"
          className="text-sm text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {classifying ? 'Analyzing…' : '🤖 Mark humanizer unrelated'}
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
                ? "Run '🤖 Mark humanizer unrelated' on this page first, then you can merge it."
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
          onClick={rankChannels}
          disabled={ranking || extracting}
          title="Order every channel by links, average hearts, posting frequency and active/blocked ratio (25% each). Uses data we already hold — nothing is fetched from TikTok."
          className="text-sm text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {ranking ? 'Ranking…' : `📊 Rank channels${ranked ? ` (${ranked.length})` : ''}`}
        </button>
        <button
          type="button"
          onClick={extractNew}
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
        </div>
      )}


      {/* Table */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
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
            title="Share of this channel's links that are still active (not blocked), with the active/blocked counts behind it"
          >
            Active %
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
                  onChange={() =>
                    setSelected((prev) => {
                      const n = new Set(prev)
                      for (const u of groupUrls) allPicked ? n.delete(u) : n.add(u)
                      return n
                    })
                  }
                  title={allPicked ? "Unselect this channel's links on this page" : "Select this channel's links on this page"}
                  className="accent-teal-500 cursor-pointer"
                />
              </span>
              <span className="min-w-0 flex items-center gap-1.5">
                <span className="text-sm text-zinc-100 truncate">@{g.account || 'no channel'}</span>
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
            <div key={r.url} className={`flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 text-sm ${selected.has(r.url) ? 'bg-amber-500/15 border-l-4 border-l-amber-400 pl-2' : ''}`}>
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
          className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setChannelsOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
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
