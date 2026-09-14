// Paging on the user dashboard's link list.
//
// The list is grouped into clusters but PAGED OVER THE FLATTENED ORDER, so
// cluster 1 opens the first page whether it holds three links or three hundred,
// and a cluster wider than a page continues onto the next under the same
// heading. This mirrors the arithmetic in ClusterList and checks the properties
// that make a page correct: nothing lost, nothing repeated, order kept, and the
// "21-40 of 300" run labels honest.
//
//   node scripts/check-dashboard-paging.mjs

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

const PER = 20

/** Exactly what ClusterList does, in plain data. */
function paginate(clusters, page) {
  const flat = []
  clusters.forEach((c, ci) => { for (const v of c.items) flat.push({ v, ci }) })
  const pageCount = Math.max(1, Math.ceil(flat.length / PER))
  const cur = Math.min(page, pageCount - 1)
  const start = cur * PER
  const slice = flat.slice(start, start + PER)
  const runs = []
  slice.forEach((r, i) => {
    const last = runs[runs.length - 1]
    if (last && last.ci === r.ci) last.items.push(r.v)
    else {
      let clusterStart = start + i
      while (clusterStart > 0 && flat[clusterStart - 1].ci === r.ci) clusterStart--
      runs.push({ ci: r.ci, from: start + i - clusterStart, items: [r.v] })
    }
  })
  return { flat, pageCount, cur, start, slice, runs }
}

const build = (sizes) =>
  sizes.map((n, ci) => ({
    label: `Cluster ${ci + 1}`,
    items: Array.from({ length: n }, (_, i) => `c${ci + 1}-${i + 1}`),
  }))

// A realistic shape: a few small best clusters, then wide ones.
const shapes = {
  'even 30x7': Array(30).fill(7),
  'one huge first': [300, 12, 8, 40, 5],
  'tiny firsts': [1, 2, 3, 250, 4],
  'single cluster': [200],
  'shorter than a page': [3, 4],
  'exact multiple': [20, 20, 20],
}

for (const [name, sizes] of Object.entries(shapes)) {
  const clusters = build(sizes)
  const total = sizes.reduce((a, b) => a + b, 0)
  const { flat, pageCount } = paginate(clusters, 0)
  console.log(`\n${name}: ${total} link(s) over ${sizes.length} cluster(s) -> ${pageCount} page(s)`)

  // 1. the first page opens on cluster 1
  const first = paginate(clusters, 0)
  check('  page 1 starts with cluster 1', first.runs[0].ci, 0)
  check('  and with its very first link', first.slice[0].v, flat[0].v)

  // 2. every link appears exactly once, in order
  const seen = []
  for (let p = 0; p < pageCount; p++) for (const r of paginate(clusters, p).slice) seen.push(r.v)
  check('  every link is on exactly one page', seen.length, total)
  check('  none is repeated', new Set(seen).size, total)
  check('  and the order is unchanged', seen.join() === flat.map((r) => r.v).join(), true)

  // 3. no page is over the cap, and only the last is short
  const lens = Array.from({ length: pageCount }, (_, p) => paginate(clusters, p).slice.length)
  check('  no page exceeds the cap', lens.filter((n) => n > PER).length, 0)
  check('  only the last page is short', lens.slice(0, -1).filter((n) => n !== PER).length, 0)

  // 4. a run's "from" is its true offset inside its own cluster
  let bad = 0
  for (let p = 0; p < pageCount; p++) {
    for (const run of paginate(clusters, p).runs) {
      const items = clusters[run.ci].items
      for (let k = 0; k < run.items.length; k++) {
        if (items[run.from + k] !== run.items[k]) bad++
      }
    }
  }
  check('  every run label points at the right slice of its cluster', bad, 0)
}

// Opening links shortens the list under you: the page must clamp, not blank.
console.log('\nas links are opened:')
const clusters = build([300, 12, 8])
const shrunk = clusters.map((c) => ({ ...c, items: c.items.slice(0, 2) }))
const p = paginate(shrunk, 9) // was page 10 of 16, now there is only one page
check('  a page past the end clamps to the last one', p.cur, p.pageCount - 1)
check('  and still shows links', p.slice.length > 0, true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
