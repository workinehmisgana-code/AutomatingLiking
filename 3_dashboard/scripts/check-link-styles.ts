// Styles spread over one link: a style verified there is not served again until
// every other style the bank offers has been used on it.
//   node scripts/run-ts-check.mjs scripts/check-link-styles.ts
export {}
async function main(): Promise<void> {
  const { styleKey, pickForLink } = await import('../lib/commentStyleSig')
  let bad = 0
  const ok = (c: boolean, w: string) => { console.log((c ? 'ok     ' : 'FAILED ') + w); if (!c) bad++ }
  const P = 'purifytext'

  console.log('reading the style off the text:')
  const read: [string, string][] = [
    ['i use purify text now', 'split'],
    ['i use purifytext now', 'plain'],
    ['i use "purify text" now 🙌', 'quoted+split+emoji'],
    ['why does nothing else pass like purifytext?', 'question'],
    ['what made you switch to “purifytext”? 🤔', 'quoted+emoji+question'],
    ['i use ρυrіfуtеxt now', 'plain'],
    ['nothing about the product here', 'unnamed'],
  ]
  for (const [t, want] of read) ok(styleKey(t, P) === want, `${JSON.stringify(t)} -> ${styleKey(t, P)}`)

  const bank = [
    'i use purify text now', 'mine passed with purify text',            // split
    'i use purifytext now', 'mine passed with purifytext',              // plain
    'i use "purify text" now', 'mine passed with "purify text"',        // quoted+split
  ].map((text) => ({ text }))

  console.log('\nchoosing for a link:')
  const verified = ['honestly purify text saved my essay']                // split is on the link
  for (let i = 0; i < 30; i++) {
    const r = pickForLink(bank, P, verified, [])!
    if (r.style === 'split') { ok(false, `served a style already verified on the link (${r.pick.text})`); break }
  }
  ok(true, 'a style verified on the link is not served while others are unused (30 draws)')

  // Simulate a link filling up: each serve is verified before the next.
  const onLink: string[] = []
  const order: string[] = []
  for (let i = 0; i < 6; i++) {
    const r = pickForLink(bank, P, onLink, [])!
    order.push(r.style)
    onLink.push(r.pick.text)
  }
  const firstRound = new Set(order.slice(0, 3))
  ok(firstRound.size === 3, `the first three comments are three different styles: ${order.slice(0, 3).join(', ')}`)
  ok(new Set(order.slice(3)).size === 3, `then the round starts again, still all different: ${order.slice(3).join(', ')}`)

  // Served-but-not-yet-verified breaks ties, so users between scans differ too.
  const served = ['i use purifytext now']
  for (let i = 0; i < 30; i++) {
    const r = pickForLink(bank, P, [], served)!
    if (r.style === 'plain') { ok(false, 'served the style just handed out, with others untouched'); break }
  }
  ok(true, 'between scans, a style just handed out waits for the others (30 draws)')

  // A product whose bank has one style: nothing to spread, serving unchanged.
  const single = pickForLink([{ text: 'i use purifytext now' }], P, ['i use purifytext daily'], [])!
  ok(single.pick.text === 'i use purifytext now', 'a one-style bank still serves (nothing to exhaust)')
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
