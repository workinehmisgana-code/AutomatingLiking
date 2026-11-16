// The harvest's title-check status: a failure is remembered (since when, how
// many links left unsorted) across slices, and a success clears it. Restores
// whatever was stored before.
//   node scripts/run-ts-check.mjs scripts/check-classify-status.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const db = await import('../lib/db')
  const h = await import('../lib/channelHarvest')
  const KEY = 'channel_harvest_classify_status'
  const before = await db.getAppState(KEY).catch(() => null)
  let bad = 0
  const check = (name: string, ok: boolean) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`)
    if (!ok) bad++
  }
  try {
    await h.recordClassify('', 5)
    check('a success reads ok', (await h.getClassifyStatus())?.ok === true)
    await h.recordClassify('Gemini 401: API key not valid', 30)
    const f1 = await h.getClassifyStatus()
    check('a failure reads failing, with the error', f1?.ok === false && /401/.test(f1?.error ?? ''))
    check('  and 30 left unsorted', f1?.unsorted === 30)
    await new Promise((r) => setTimeout(r, 1100))
    await h.recordClassify('Gemini 401: API key not valid', 12)
    const f2 = await h.getClassifyStatus()
    check('a second failure adds up (42)', f2?.unsorted === 42)
    check('  and keeps when it started', f2?.since === f1?.since && f2?.at !== f1?.at)
    await h.recordClassify('', 8)
    check('a success clears it', (await h.getClassifyStatus())?.ok === true)
  } finally {
    if (before === null) await db.pool.query(`DELETE FROM app_kv WHERE key = $1`, [KEY]).catch(() => {})
    else await db.setAppState(KEY, before)
  }
  console.log(bad ? `${bad} FAILED` : 'all correct')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
