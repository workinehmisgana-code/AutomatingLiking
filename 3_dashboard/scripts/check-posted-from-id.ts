// tiktokPostedDate: the upload date read from a TikTok video id.
//   node scripts/run-ts-check.mjs scripts/check-posted-from-id.ts
export {}

async function main(): Promise<void> {
  const { tiktokPostedDate } = await import('../lib/linkStats')
  const cases: [string, string][] = [
    ['7708476080708947218', '2026-11-15'],
    ['7702434238624189727', '2026-10-30'],
    ['not-an-id', ''],
    ['123', ''],
  ]
  let bad = 0
  for (const [id, want] of cases) {
    const got = tiktokPostedDate(id)
    const ok = got === want
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${id} -> ${JSON.stringify(got)}${ok ? '' : ` (want ${want})`}`)
  }
  console.log(bad ? `${bad} FAILED` : 'all correct')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
