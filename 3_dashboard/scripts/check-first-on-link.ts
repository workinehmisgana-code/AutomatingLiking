// First comment on a link: "purify text"; every later one: purifytext.
//   node scripts/run-ts-check.mjs scripts/check-first-on-link.ts
export {}
async function main(): Promise<void> {
  const { formNameForLink } = await import('../lib/serveComment')
  const { styleKey } = await import('../lib/commentStyleSig')
  let bad = 0
  const ok = (c: boolean, w: string) => { console.log((c ? 'ok     ' : 'FAILED ') + w); if (!c) bad++ }
  const cases: [string, boolean, string][] = [
    ['i use purifytext now 🙌', true, 'i use "purify text" now 🙌'],
    ['i use "Purify Text" now', true, 'i use "purify text" now'],
    ['i use purify text now', false, 'i use purifytext now'],
    ['i use "purify text" now', false, 'i use purifytext now'],
    ['been purify texting all week', true, 'been "purify texting" all week'],
    ['why does nothing pass like purifytext?', false, 'why does nothing pass like purifytext?'],
    ['i use ρυrіfуtеxt now', false, 'i use ρυrіfуtеxt now'],
  ]
  for (const [input, first, want] of cases) {
    const got = formNameForLink(input, 'purifytext', first)
    ok(got === want, `${first ? 'first ' : 'later '} ${JSON.stringify(input)} -> ${JSON.stringify(got)}`)
  }
  ok(styleKey('i use "purify text" now 🙌', 'purifytext', ['quoted', 'split']) === 'emoji',
     'with the link deciding the name, only emoji/question rotate')
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
