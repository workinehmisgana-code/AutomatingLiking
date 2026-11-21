// Mixed style switches: a batch comes out about half and half on every mixed
// feature, the unmixed ones stay as set, and combinations vary.
//   node scripts/run-ts-check.mjs scripts/check-style-mix.ts
export {}
async function main(): Promise<void> {
  const { sanitize } = await import('../lib/commentGen')
  const { DEFAULT_COMMENT_STYLE, normaliseMix, resolveMix } = await import('../lib/config')
  const lines = Array.from({ length: 40 }, (_, i) =>
    `honestly my ${['essay', 'draft', 'paper', 'report'][i % 4]} number ${i + 1} came back fine after PurifyText this week`)
  const style = {
    ...DEFAULT_COMMENT_STYLE, voice: 'recommendation' as const,
    emoji: true, splitBrand: true, quoteBrand: false, inSentence: false,
    mix: normaliseMix(['splitBrand', 'quoteBrand', 'emoji', 'nonsense']),
  }
  const out = sanitize('purifytext' as never, lines, { min: 5, max: 30 }, { style })
  const quoted = out.filter((s) => s.includes('"')).length
  const split = out.filter((s) => /purify text/.test(s)).length
  const EMOJI = new RegExp('\\p{Extended_Pictographic}', 'u')
  const emoji = out.filter((s) => EMOJI.test(s)).length
  const combos = new Set(out.map((s) => `${s.includes('"')}|${/purify text/.test(s)}|${EMOJI.test(s)}`))
  let bad = 0
  const ok = (c: boolean, w: string) => { console.log((c ? 'ok     ' : 'FAILED ') + w); if (!c) bad++ }
  console.log(out.slice(0, 6).map((s) => '   ' + s).join('\n'))
  ok(out.length === 40, `all 40 kept (${out.length})`)
  ok(style.mix.length === 3, 'unknown mix names are dropped')
  ok(Math.abs(quoted - 20) <= 1, `quoted about half: ${quoted}/40`)
  ok(Math.abs(split - 20) <= 1, `split about half: ${split}/40`)
  ok(Math.abs(emoji - 20) <= 1, `emoji about half: ${emoji}/40`)
  ok(combos.size >= 6, `the switches combine freely: ${combos.size} of 8 combinations seen`)
  const plain = sanitize('purifytext' as never, lines, { min: 5, max: 30 }, { style: { ...style, mix: [] } })
  ok(plain.every((s) => /purify text/.test(s) && !s.includes('"')), 'with no mix, the switches apply to every comment as before')
  const r = resolveMix({ ...style, mix: ['inSentence'] }, () => true)
  ok(r.inSentence === true && (r.mix ?? []).length === 0, 'resolveMix decides a feature and clears the mix')
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
