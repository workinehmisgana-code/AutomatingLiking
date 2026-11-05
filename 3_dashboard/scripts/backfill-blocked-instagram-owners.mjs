// Fill in who posted every Instagram link that is missing an owner, in the two
// database tables that need it:
//
//   blocked_link.account   blocked Instagram links (the Active % blocked count)
//   verify_link.account    staged Instagram links with no account name
//
// WHY. An Instagram post URL is /p/<code>/ and names nobody, and blocking a link
// removes it from the pool, so a blocked Instagram link could never be charged
// to its channel. New blocks now record the owner (lib/db.ts blockLinks); this
// script does the same for everything blocked or staged before that.
//
// WHERE THE OWNER COMES FROM, cheapest first:
//   1. the URL itself, for the rarer /<handle>/p/<code>/ form
//   2. the staged row (verify_link.account) for the same URL
//   3. the pool row's `author` in videos.json
//   4. the post's embed page, instagram.com/p/<code>/embed/ — one request
//      each, ~1 s, measured at 14/14 on live posts
//      (scripts/backfill-instagram-authors.mjs)
//
// WHAT CANNOT BE FILLED. A deleted or private post serves a fixed shell with no
// owner in it ("gone" below). Nothing names its owner from anywhere, so those
// stay NULL and are reported. Everything else that fails (429, timeouts) is
// retried on the next run — the script only touches rows still missing an owner.
//
// SAFE TO RE-RUN, and writes as it goes (every 200 resolved), so stopping it
// halfway keeps what it found.
//
//   node scripts/backfill-blocked-instagram-owners.mjs --dry-run
//   node scripts/backfill-blocked-instagram-owners.mjs --limit 500
//   node scripts/backfill-blocked-instagram-owners.mjs            # all of them
//
// Run scripts/backfill-instagram-authors.mjs too: it fills `author` on POOL
// rows, which is what the ACTIVE side of an Instagram channel's ratio counts.
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  const n = i >= 0 ? Number(args[i + 1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : Infinity
})()
/** Embeds in flight. Instagram tolerates this; higher starts returning 429. */
const CONCURRENCY = 6
const FLUSH_EVERY = 200

// ── Owner parsing: mirrors lib/igOwner.ts ────────────────────────────────────
const NOT_A_HANDLE = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'about', 'developer', 'stories'])
const SHORTCODE = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i
const OWNER_PATTERNS = [
  /instagram\.com\/([A-Za-z0-9._]{1,30})\/\?utm/,
  /class="[^"]*UsernameText[^"]*"[^>]*>([A-Za-z0-9._]{1,30})</,
]

function normHandle(v) {
  const h = String(v ?? '').trim().replace(/^@/, '').toLowerCase()
  return /^[a-z0-9._]{1,30}$/.test(h) ? h : null
}
function handleFromUrl(url) {
  const h = String(url || '').match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel|tv)\//i)?.[1]?.toLowerCase()
  return h && !NOT_A_HANDLE.has(h) ? normHandle(h) : null
}
function ownerOf(html) {
  for (const re of OWNER_PATTERNS) {
    const h = re.exec(html)?.[1]?.toLowerCase()
    if (h && !NOT_A_HANDLE.has(h)) return normHandle(h)
  }
  return null
}
async function lookup(url) {
  const code = SHORTCODE.exec(url)?.[1]
  if (!code) return { state: 'no-code' }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://www.instagram.com/p/${code}/embed/`, {
        headers: { 'User-Agent': 'facebookexternalhit/1.1' },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
        continue
      }
      if (!res.ok) return { state: 'http', detail: res.status }
      const html = await res.text()
      const owner = ownerOf(html)
      if (owner) return { state: 'ok', owner }
      return { state: /"media_id"\s*:\s*"?\d/.test(html) ? 'unparsed' : 'gone' }
    } catch (e) {
      if (attempt === 2) return { state: 'error', detail: String(e).slice(0, 60) }
    }
  }
  return { state: 'http', detail: 429 }
}

// ── Load what needs an owner ─────────────────────────────────────────────────
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
})
// The column the app adds on its next start; added here too so the script can
// run before the deploy.
await db.query('ALTER TABLE blocked_link ADD COLUMN IF NOT EXISTS account TEXT')

const { rows: blockedRows } = await db.query(
  `SELECT DISTINCT url FROM blocked_link
    WHERE account IS NULL AND url ~* 'instagram\\.com/'`
)
const { rows: stagedRows } = await db.query(
  `SELECT url FROM verify_link
    WHERE coalesce(nullif(trim(account), ''), '') = ''
      AND (platform = 'instagram' OR url ~* 'instagram\\.com/')`
)
const blockedNeed = new Set(blockedRows.map((r) => r.url))
const stagedNeed = new Set(stagedRows.map((r) => r.url))
console.log(`${blockedNeed.size.toLocaleString()} blocked Instagram link(s) with no owner`)
console.log(`${stagedNeed.size.toLocaleString()} staged Instagram link(s) with no account`)

const all = Array.from(new Set([...blockedNeed, ...stagedNeed]))
const found = new Map() // url -> handle
const from = { url: 0, staged: 0, pool: 0, embed: 0 }

for (const u of all) {
  const h = handleFromUrl(u)
  if (h) { found.set(u, h); from.url++ }
}

// The staged rows that DO have an account, for blocked links of the same URL.
{
  const want = all.filter((u) => !found.has(u))
  if (want.length) {
    const { rows } = await db.query(
      'SELECT url, account FROM verify_link WHERE url = ANY($1::text[])',
      [want]
    )
    for (const r of rows) {
      const h = normHandle(r.account)
      if (h && !found.has(r.url)) { found.set(r.url, h); from.staged++ }
    }
  }
}

// The pool's author field.
{
  const want = new Set(all.filter((u) => !found.has(u)))
  if (want.size) {
    try {
      const { list } = await import('@vercel/blob')
      const { blobs } = await list({ prefix: 'videos.json' })
      const poolRows = await (
        await fetch(blobs[0].url, {
          headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
          cache: 'no-store',
        })
      ).json()
      for (const v of poolRows) {
        const u = String(v?.url ?? '')
        if (!want.has(u)) continue
        const h = normHandle(v.author)
        if (h) { found.set(u, h); from.pool++ }
      }
    } catch (e) {
      console.log(`   (could not read videos.json, skipping the pool step: ${String(e).slice(0, 80)})`)
    }
  }
}
console.log(
  `already known: ${(from.url + from.staged + from.pool).toLocaleString()} ` +
    `(url ${from.url}, staged row ${from.staged}, pool author ${from.pool})`
)

// ── Writes ───────────────────────────────────────────────────────────────────
let written = 0
const pending = new Map()
async function flush() {
  if (DRY || pending.size === 0) { pending.clear(); return }
  const urls = [...pending.keys()]
  const handles = urls.map((u) => pending.get(u))
  pending.clear()
  const b = await db.query(
    `UPDATE blocked_link b SET account = x.account
       FROM unnest($1::text[], $2::text[]) AS x(url, account)
      WHERE b.url = x.url AND b.account IS NULL`,
    [urls, handles]
  )
  const s = await db.query(
    `UPDATE verify_link v SET account = x.account
       FROM unnest($1::text[], $2::text[]) AS x(url, account)
      WHERE v.url = x.url AND coalesce(nullif(trim(v.account), ''), '') = ''`,
    [urls, handles]
  )
  written += (b.rowCount ?? 0) + (s.rowCount ?? 0)
}
for (const [u, h] of found) pending.set(u, h)
await flush()

// ── The network step, for what nothing we hold could name ────────────────────
const todoAll = all.filter((u) => !found.has(u))
const todo = todoAll.slice(0, LIMIT === Infinity ? todoAll.length : LIMIT)
console.log(
  `\nlooking up ${todo.length.toLocaleString()} owner(s) from Instagram` +
    (todo.length < todoAll.length ? ` (of ${todoAll.length.toLocaleString()}; --limit)` : '') +
    (DRY ? ' — dry run, nothing will be written' : '')
)
const counts = { ok: 0, gone: 0, unparsed: 0, http: 0, error: 0, 'no-code': 0 }
const gone = []
let done = 0
let next = 0
const started = Date.now()
const worker = async () => {
  for (;;) {
    const i = next++
    if (i >= todo.length) return
    const u = todo[i]
    const r = await lookup(u)
    counts[r.state] = (counts[r.state] ?? 0) + 1
    if (r.state === 'ok') {
      found.set(u, r.owner)
      from.embed++
      pending.set(u, r.owner)
      if (pending.size >= FLUSH_EVERY) await flush()
    } else if (r.state === 'gone') {
      gone.push(u)
    }
    done++
    if (done % 100 === 0 || done === todo.length) {
      const rate = done / ((Date.now() - started) / 1000)
      const left = Math.round((todo.length - done) / Math.max(rate, 0.01) / 60)
      process.stdout.write(
        `  ${done}/${todo.length} · ${from.embed} resolved · ${counts.gone} gone · ` +
          `${rate.toFixed(1)}/s · ~${left} min left\n`
      )
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
await flush()

// ── Report ───────────────────────────────────────────────────────────────────
console.log('\nembed lookups:')
for (const [k, n] of Object.entries(counts)) if (n) console.log(`   ${k.padEnd(10)} ${n.toLocaleString()}`)
const stillBlocked = [...blockedNeed].filter((u) => !found.has(u)).length
const stillStaged = [...stagedNeed].filter((u) => !found.has(u)).length
console.log(
  `\nresolved ${found.size.toLocaleString()} of ${all.length.toLocaleString()} link(s) ` +
    `across ${new Set(found.values()).size.toLocaleString()} channel(s)`
)
console.log(`   blocked still without an owner: ${stillBlocked.toLocaleString()}`)
console.log(`   staged still without an account: ${stillStaged.toLocaleString()}`)
if (gone.length) {
  console.log(
    `   ${gone.length.toLocaleString()} of those are deleted/private posts — Instagram no longer ` +
      'says who posted them, so they cannot be attributed from anywhere.'
  )
}
const retryable = counts.http + counts.error + counts.unparsed
if (retryable) console.log(`   ${retryable.toLocaleString()} failed to load and will be retried on the next run.`)
console.log(DRY ? '\ndry run — nothing written.' : `\n${written.toLocaleString()} row(s) updated.`)
await db.end()
