// "Quote the brand": how a generated comment's product name comes out.
//   node scripts/run-ts-check.mjs scripts/check-quote-brand.ts
export {}
async function main(): Promise<void> {
  const { canonicaliseMention } = await import('../lib/commentGen')
  const { DEFAULT_COMMENT_STYLE } = await import('../lib/config')
  const on = { ...DEFAULT_COMMENT_STYLE, quoteBrand: true, splitBrand: true }
  const off = { ...DEFAULT_COMMENT_STYLE, quoteBrand: false, splitBrand: true }
  const cases: [string, typeof on, string][] = [
    ['i use PurifyText now', on, 'i use "purify text" now'],
    ['i use "Purify Text" now', on, 'i use "purify text" now'],
    ['i use #purifytext now', on, 'i use "purify text" now'],
    ['been purifytexting all week', on, 'been "purify texting" all week'],
    ['i use "Purify Text" now', off, 'i use purify text now'],
    ['i use PurifyText now', { ...on, splitBrand: false }, 'i use "purifytext" now'],
  ]
  let bad = 0
  for (const [input, style, want] of cases) {
    const got = canonicaliseMention(input, 'purifytext' as never, style)
    const ok = got === want
    if (!ok) bad++
    console.log(`${ok ? 'ok    ' : 'FAILED'} ${JSON.stringify(input)} -> ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
