// Does the "did the empty links gain a comment?" comparison count correctly?
//
// Two traps.
//
// 1. Links the LATER cycle has not reached. Counting those as "did not gain"
//    would report the scan's own progress as a failure to place comments — the
//    number would look terrible for reasons unrelated to comments. Only links
//    both cycles read may be compared.
//
// 2. The two dimensions report differently on purpose: search rank as ONE
//    figure across all thirty clusters, posted date one row per cluster.
//
//   node scripts/check-coverage.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await pool.query(sql, p)).rows

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(
    `   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
  )
}

const [{ id: prev }] = await q('INSERT INTO pipeline_cycle DEFAULT VALUES RETURNING id')
const [{ id: cur }] = await q('INSERT INTO pipeline_cycle DEFAULT VALUES RETURNING id')

const put = (cycle, rows) =>
  q(
    `INSERT INTO pipeline_scan (cycle_id, url, our_count, read_count, rank_cluster, date_cluster)
     SELECT $1, u, o, r, rc, dc
       FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::int[]) AS x(u,o,r,rc,dc)`,
    [
      cycle,
      rows.map((r) => r[0]),
      rows.map((r) => r[1]),
      rows.map(() => 20),
      rows.map((r) => r[2]),
      rows.map((r) => r[3]),
    ]
  )

// url, ourCount, rankCluster, dateCluster
await put(prev, [
  ['a', 0, 1, 1], // empty before
  ['b', 0, 1, 1], // empty before
  ['c', 0, 2, null], // empty before, another rank cluster
  ['d', 3, 1, 1], // already had ours
  ['e', 0, 2, null], // empty before — the later cycle never reaches it
])
await put(cur, [
  ['a', 2, 1, 1], // GAINED
  ['b', 0, 1, 1], // still empty
  ['c', 1, 2, null], // GAINED
  ['d', 3, 1, 1], // still has ours, was never lacking
  ['f', 0, 1, 1], // brand new link, nothing to compare against
])

// Mirrors getCycleCoverage: rank ungrouped, date grouped.
const coverage = (by) => {
  const perCluster = by === 'date'
  return q(
    `SELECT ${perCluster ? `cur.${by}_cluster` : 'NULL::int'} AS cluster,
            COUNT(*) FILTER (WHERE prev.url IS NOT NULL)::int                     AS compared,
            COUNT(*) FILTER (WHERE prev.our_count = 0)::int                       AS lacked,
            COUNT(*) FILTER (WHERE prev.our_count = 0 AND cur.our_count > 0)::int AS gained,
            COUNT(*)::int                                                         AS read,
            COUNT(*) FILTER (WHERE cur.our_count > 0)::int                        AS with_ours
       FROM pipeline_scan cur
       LEFT JOIN pipeline_scan prev ON prev.url = cur.url AND prev.cycle_id = $1
      WHERE cur.cycle_id = $2 AND cur.${by}_cluster IS NOT NULL
      ${perCluster ? `GROUP BY cur.${by}_cluster ORDER BY cur.${by}_cluster` : ''}`,
    [prev, cur]
  )
}

console.log('search-rank clusters, as ONE figure:')
const rank = await coverage('rank')
check('one row, not one per cluster', rank.length, 1)
const R = rank[0]
console.log(
  `   read ${R.read}, carry ours ${R.with_ours}, lacked before ${R.lacked}, gained ${R.gained}`
)
// Rank-clustered in the later cycle: a, b, c, d, f — five links.
//   a  lacked before, has ours now  -> gained
//   b  lacked before, still empty
//   c  lacked before, has ours now  -> gained
//   d  already had ours, so never "lacked"
//   f  brand new: read now, nothing to compare against
//   e  earlier cycle only — never re-read, so absent entirely
check('lacked before, across every rank cluster', R.lacked, 3)
check('gained, across every rank cluster', R.gained, 2)
check('a link that already had ours is not counted as lacking', R.with_ours, 3)
check('compared covers only links seen in both cycles', R.compared, 4)
check('read now counts the brand-new link too', R.read, 5)
check('a link the later cycle never reached is absent', R.read < 6, true)

console.log('\nposted-date clusters, one by one:')
const date = await coverage('date')
for (const r of date) {
  console.log(
    `   cluster ${r.cluster}: read ${r.read}, lacked before ${r.lacked}, gained ${r.gained}`
  )
}
check('only links carrying a date cluster appear', date.length, 1)
check('date cluster 1 lacked before', date[0].lacked, 2)
check('date cluster 1 gained', date[0].gained, 1)

await q('DELETE FROM pipeline_scan WHERE cycle_id = ANY($1::bigint[])', [[prev, cur]])
await q('DELETE FROM pipeline_cycle WHERE id = ANY($1::bigint[])', [[prev, cur]])
console.log('\ntest rows removed.')

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
await pool.end()
process.exit(fails === 0 ? 0 : 1)
