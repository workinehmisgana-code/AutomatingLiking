// The keyword safety net respects word boundaries.
//   node scripts/run-ts-check.mjs scripts/check-keyword-boundaries.ts
export {}
async function main(): Promise<void> {
  const { classifyChunkWithReasons } = await import('../lib/titleClassify')
  // No model key: only the keyword net can make a title related here.
  process.env.GEMINI_API_KEY = ''
  const cases: [string, boolean][] = [
    ["One photo. Claude can turn it into something you'd normally spend HOURS doing", false],
    ['can you turn it in on time', false],
    ['passed #turnitin finally', true],
    ['best AI-detectors ranked', true],
    ['AI detector test', true],
    ['#bestaihumanizer 2025', true],
    ['humanized my essay', true],
    ['turn it in to get checked', false],
    ['walter writes ai review', true],
    ['gpt zero vs originality ai', true],
    ['my favourite pasta recipe', false],
  ]
  const out = await classifyChunkWithReasons(
    cases.map(([title], i) => ({ url: `https://www.tiktok.com/@x/video/${i}`, title })), 'humanizer' as never)
  let bad = 0
  out.forEach((v, i) => {
    const hit = v.rule === 'keyword'
    const good = hit === cases[i][1]
    if (!good) bad++
    console.log(`${good ? 'ok    ' : 'FAILED'} ${hit ? `keyword ${v.ruleText}` : 'no keyword'}  ${cases[i][0]}`)
  })
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
