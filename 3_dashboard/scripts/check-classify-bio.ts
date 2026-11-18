// "Mark unrelated" with the channel bio: titles from channels that have a bio
// are judged, and the ones the bio decided ("Bio: ...") are printed beside the
// same titles judged with no bio at all.
//   node scripts/run-ts-check.mjs scripts/check-classify-bio.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  await (await import('../lib/genreStore')).ensureGenreRegistry(true)
  const { pool, getChannelBios } = await import('../lib/db')
  const { channelOf } = await import('../lib/dateScore')
  const { classifyChunkWithReasons } = await import('../lib/titleClassify')
  const bios = await getChannelBios()
  const { rows } = await pool.query<{ url: string; title: string }>(
    `SELECT url, title FROM link_title WHERE url LIKE '%tiktok.com/@%' AND length(title) > 0 ORDER BY random() LIMIT 4000`)
  const items = rows
    .map((r) => ({ ...r, bio: bios[channelOf(r.url)?.replace(/^[a-z]+:/, '') ?? ''] ?? '' }))
    .filter((r) => r.bio)
    .slice(0, 60)
  // Made-up cases with a known answer: a vague caption is related only through
  // the bio; a caption clearly about something else is not, bio or no bio.
  const HB = 'AI humanizer tips for students | make ChatGPT essays pass Turnitin & GPTZero'
  items.push(
    { url: 'https://www.tiktok.com/@x1/video/1', title: 'pov: finals week #fyp #college', bio: HB },
    { url: 'https://www.tiktok.com/@x2/video/2', title: 'this saved my semester fr', bio: HB },
    { url: 'https://www.tiktok.com/@x3/video/3', title: 'my favourite pasta recipe 🍝 #cooking', bio: HB },
    { url: 'https://www.tiktok.com/@x4/video/4', title: 'pov: finals week #fyp #college', bio: 'Dancer | Choreo | LA' },
  )
  console.log(`${items.length} titled links whose channel has a bio`)
  const [withBio, noBio] = await Promise.all([
    classifyChunkWithReasons(items, 'humanizer' as never),
    classifyChunkWithReasons(items.map(({ url, title }) => ({ url, title })), 'humanizer' as never),
  ])
  const before = new Map(noBio.map((v) => [v.url, v]))
  let flipped = 0
  withBio.forEach((v, i) => {
    const b = before.get(v.url)
    if (b && b.related !== v.related) {
      flipped++
      console.log(`\n${b.related ? 'related → UNRELATED' : 'unrelated → RELATED'}  ${v.url}`)
      console.log(`  title: ${items[i].title.slice(0, 120)}`)
      console.log(`  bio:   ${items[i].bio.slice(0, 120)}`)
      console.log(`  why:   ${v.reason}`)
    }
  })
  console.log('\nthe made-up cases (expected: RELATED, RELATED, no, no):')
  for (const v of withBio.slice(-4)) console.log(`  ${v.related ? 'RELATED' : 'no     '}  ${v.reason}`)
  const bioReasons = withBio.filter((v) => /^bio:/i.test(v.reason)).length
  console.log(`\nrelated: ${noBio.filter((v) => v.related).length} without bio, ${withBio.filter((v) => v.related).length} with bio`)
  console.log(`${flipped} verdict(s) changed, ${bioReasons} reason(s) start with "Bio:"`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
