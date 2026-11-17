// What fetchVideoDetail returns for a staged link, and what the embed page holds.
//   node scripts/run-ts-check.mjs scripts/probe-video-detail.ts [url]
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const url = process.argv[2] || 'https://www.tiktok.com/@byallix/video/7708476080708947218'
  const { fetchVideoDetail } = await import('../lib/linkStats')
  console.log('detail:', JSON.stringify(await fetchVideoDetail(url)))
  const id = url.match(/\/video\/(\d+)/)?.[1]
  const res = await fetch(`https://www.tiktok.com/embed/v2/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
  })
  const html = await res.text()
  console.log('status', res.status, 'len', html.length)
  for (const k of ['createTime', 'create_time', 'createTimeISO', 'diggCount', 'playCount']) {
    const i = html.indexOf(k)
    console.log(k, i >= 0 ? html.slice(i, i + 60).replace(/\s+/g, ' ') : '(absent)')
  }
  // The id itself carries the upload time: its top 32 bits are Unix seconds.
  if (id) console.log('date from id:', new Date(Number(BigInt(id) >> BigInt(32)) * 1000).toISOString())
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
