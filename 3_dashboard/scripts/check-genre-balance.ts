// No DB: balanceGenreWeights brings the team's predicted shares to the mix.
//   node scripts/run-ts-check.mjs scripts/check-genre-balance.ts
import { balanceGenreWeights, withoutGenres } from '../lib/config'

let bad = 0
const check = (name: string, ok: boolean, detail: unknown) => {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}
const r = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1000) / 10]))

/** Team shares if every group keeps its click volume, with its pauses applied. */
function predict(w: Record<string, number>, groups: { paused: string[]; clicks: number }[]) {
  const out: Record<string, number> = {}
  let total = 0
  for (const x of groups) {
    const mine = withoutGenres(w, x.paused)
    const s = Object.values(mine).reduce((a, b) => a + b, 0)
    if (s <= 0) continue
    total += x.clicks
    for (const [g, v] of Object.entries(mine)) out[g] = (out[g] ?? 0) + (x.clicks * v) / s
  }
  for (const g of Object.keys(out)) out[g] /= total
  return out
}

const target = { humanizer: 0.5, website: 0, slides: 0.25, 'study-helper': 0.25 }

// Nobody paused → unchanged.
check('no pauses: mix untouched', balanceGenreWeights(target, [{ paused: [], clicks: 100 }]) === target, '')

// Reachable: 30% of clicks from humanizer-paused workers.
const g1 = [{ paused: [], clicks: 70 }, { paused: ['humanizer'], clicks: 30 }]
const before1 = predict(target, g1)
const p1 = predict(balanceGenreWeights(target, g1), g1)
check('30% paused: before', true, r(before1))
check('30% paused: humanizer reaches 50%', Math.abs(p1.humanizer - 0.5) < 0.01, r(p1))
check('30% paused: slides = study', Math.abs(p1.slides - p1['study-helper']) < 0.01, '')

// Last week's real shape: ~64% of clicks from humanizer-paused workers.
const g2 = [{ paused: [], clicks: 10524 }, { paused: ['humanizer'], clicks: 18378 }]
const w2 = balanceGenreWeights(target, g2)
const p2 = predict(w2, g2)
check('64% paused: before', true, r(predict(target, g2)))
check('64% paused: as close as the bound allows', p2.humanizer > 0.33, { weights: r(w2), predicted: r(p2) })
check('unpaused workers still get every genre', w2.slides > 0 && w2['study-helper'] > 0, '')
check('website stays at 0', w2.website === 0, '')

console.log(bad ? `${bad} failed` : 'all good')
process.exit(bad ? 1 : 0)
