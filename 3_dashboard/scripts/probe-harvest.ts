// Is the automatic channel harvest working, and what does it do per genre?
//   node scripts/run-ts-check.mjs scripts/probe-harvest.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const store = await import('../lib/genreStore')
  await store.ensureGenreRegistry(true)
  const db = await import('../lib/db')
  const { pool } = db
  const { getLastHarvest, HARVEST_MIN_ACTIVE_PCT } = await import('../lib/channelHarvest')
  const { rankChannels } = await import('../lib/channelRank')
  const { CHANNEL_SITE_PLATFORMS } = await import('../lib/config')

  console.log('last harvest slice:', JSON.stringify(await getLastHarvest()))
  const kv = await pool.query(
    `SELECT key, left(value::text, 160) v FROM app_kv
      WHERE key ILIKE '%harvest%' OR key ILIKE 'pipeline_%' OR key ILIKE '%auto_merge%' OR key ILIKE '%automerge%'
      ORDER BY key`
  ).catch(async () => ({ rows: [] }))
  for (const r of kv.rows) console.log(`  kv ${r.key} = ${r.v}`)
  const on = await db.getHarvestPlatforms()
  console.log('harvest platforms on:', Array.from(on))

  const ranked = await rankChannels()
  const siteOn = (s: string) => (CHANNEL_SITE_PLATFORMS[s] ?? []).some((p) => on.has(p))
  const by: Record<string, { all: number; qualified: number; eligible: number; noRatio: number }> = {}
  for (const c of ranked) {
    const b = (by[c.genre] ??= { all: 0, qualified: 0, eligible: 0, noRatio: 0 })
    b.all++
    if (c.activePct === null) b.noRatio++
    const q = (c.added && c.links === 0) || (c.activePct !== null && c.activePct >= HARVEST_MIN_ACTIVE_PCT)
    if (q) b.qualified++
    if (q && siteOn(c.platform)) b.eligible++
  }
  console.log('channels by genre (all / >=50% active / eligible on switched-on platforms / no ratio):')
  for (const [g, b] of Object.entries(by)) console.log(`  ${g}: ${b.all} / ${b.qualified} / ${b.eligible} / ${b.noRatio}`)

  const cycles = await pool.query(
    `SELECT * FROM pipeline_cycle ORDER BY id DESC LIMIT 4`
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }))
  for (const c of cycles.rows) console.log('cycle', JSON.stringify(c).slice(0, 600))

  const vl = await pool.query(
    `SELECT coalesce(genre,'(null)') g, count(*)::int n, max(added_at) last FROM verify_link GROUP BY 1 ORDER BY 2 DESC`
  )
  console.log('verify list:', vl.rows)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
