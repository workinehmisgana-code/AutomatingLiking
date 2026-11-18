// Does "retire by our comment share" catch every genre's links? Per genre:
// scanned TikTok pool links over the share, and whether the feed retires them.
//   node scripts/run-ts-check.mjs scripts/probe-ratio-retire.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  await (await import('../lib/genreStore')).ensureGenreRegistry(true)
  const { pool, getOurRatioRetirePct, ourRatioRetiredSet } = await import('../lib/db')
  const { loadVideosJson } = await import('../lib/videos')
  const { genreOfRow, PRODUCTS, PRODUCT_GENRE } = await import('../lib/config')
  const pct = await getOurRatioRetirePct()
  console.log(`retire share: ${pct}%`)
  console.log('products:', PRODUCTS.map((p) => `${p}(${PRODUCT_GENRE[p]})`).join(' '))
  const videos = await loadVideosJson()
  const retired = await ourRatioRetiredSet(videos)
  const { rows } = await pool.query<{ url: string; our_count: number; read_count: number; total_count: number | null; hits: number; prods: string | null }>(
    `SELECT s.url, s.our_count, s.read_count, s.total_count,
            (SELECT count(*)::int FROM link_product_comment p WHERE p.url = s.url) AS hits,
            (SELECT string_agg(DISTINCT p.product, ',') FROM link_product_comment p WHERE p.url = s.url) AS prods
       FROM link_comment_scan s`)
  const scan = new Map(rows.map((r) => [r.url, r]))
  const stat: Record<string, { tiktok: number; scanned: number; over: number; overRetired: number; examples: string[] }> = {}
  for (const v of videos) {
    const g = genreOfRow(v)
    const st = (stat[g] ??= { tiktok: 0, scanned: 0, over: 0, overRetired: 0, examples: [] })
    const url = String(v.url)
    if (!/tiktok\.com/.test(url)) continue
    st.tiktok++
    const s = scan.get(url)
    if (!s) continue
    st.scanned++
    const denom = Math.max(s.total_count ?? 0, s.read_count, s.our_count, 1)
    const share = (s.our_count * 100) / denom
    if (share >= pct && s.our_count > 0) {
      st.over++
      if (retired.has(url)) st.overRetired++
      else if (st.examples.length < 5) st.examples.push(`${url} platform=${v.platform} our=${s.our_count}/${denom}`)
    }
    // links where stored product hits exceed our_count (counted on a stale product list)
    if (s.hits > s.our_count && st.examples.length < 8) st.examples.push(`HITS>OUR ${url} our=${s.our_count} hits=${s.hits} ${s.prods}`)
  }
  for (const [g, st] of Object.entries(stat)) {
    console.log(`\n${g}: ${st.tiktok} tiktok, ${st.scanned} scanned, ${st.over} over ${pct}%, ${st.overRetired} of those retired`)
    st.examples.forEach((e) => console.log('   ', e))
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
