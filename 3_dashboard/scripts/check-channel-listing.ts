/**
 * Can we still list a TikTok channel's recent videos?
 *
 * WHY THIS EXISTS. "⬇ Extract from the added channel(s)" staged nothing and
 * reported the channels as having no new videos. They had not been read at all:
 * TikTok answers a burst to /embed/@handle with HTTP 503 and the body
 * "overload-protect triggered", and fetchChannelVideos returned an empty array
 * for every kind of failure — so a refusal was indistinguishable from a channel
 * with nothing on it. Six parallel requests (CHANNEL_CONCURRENCY) made the
 * refusal likely, and with only two channels in the run, both were refused.
 *
 * Measured at the time: three bare requests in twelve seconds gave 503, 503,
 * then 200 with the real 324 KB page. So the fix is to retry and to say which
 * happened, and this is what proves both.
 *
 * IT TOUCHES THE NETWORK, so it is not part of the ordinary sweep. Run it when
 * extraction looks broken:
 *
 *   node scripts/run-ts-check.mjs scripts/check-channel-listing.ts
 */
import { fetchChannelListing } from '../lib/linkStats'

const HANDLES = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const targets = HANDLES.length ? HANDLES : ['tiktok', 'typedbynelly', 'writewithmax5']

let fails = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(
    `   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}` +
      (ok ? '' : ` (want ${JSON.stringify(want)})`)
  )
}

async function main(): Promise<void> {
  // ── is the throttle real, and does a bare request hit it? ───────────────────
  console.log('a bare burst at the listing endpoint, to see the throttle:')
  const codes: number[] = []
  for (let i = 0; i < 3; i++) {
    const res = await fetch('https://www.tiktok.com/embed/@tiktok', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      cache: 'no-store',
    }).catch(() => null)
    codes.push(res?.status ?? 0)
  }
  console.log(`   three requests, no waiting: ${codes.join(', ')}`)
  console.log(
    codes.some((c) => c === 503)
      ? '   (503 = "overload-protect triggered" — the refusal this check is about)'
      : '   (no refusal this time; the retry below is what makes that not matter)'
  )

  // ── and does the retrying reader get through? ───────────────────────────────
  console.log('\nfetchChannelListing, which retries a refusal:')
  for (const handle of targets) {
    const { videos, throttled } = await fetchChannelListing(handle)
    console.log(
      `   @${handle}: ${videos.length} video(s), throttled=${throttled}` +
        (videos[0] ? ` — newest ${videos[0].id}` : '')
    )
    // The point of the whole change: these two states are now distinguishable, so
    // "TikTok would not answer" can never again reach the screen as "this channel
    // has nothing new".
    check(`  @${handle} is either read or reported refused`, videos.length > 0 || throttled, true)
  }

  const got = await Promise.all(targets.map((h) => fetchChannelListing(h)))
  const read = got.filter((g) => g.videos.length > 0).length
  console.log(`\n${read} of ${targets.length} channel(s) listed on a parallel run.`)
  if (read === 0) {
    console.log('Every one was refused. That is a throttle to wait out, not an empty channel —')
    console.log('the extract button will now say so instead of reporting no new videos.')
  }

  console.log(`\n${fails === 0 ? 'all correct' : `${fails} FAILED`}`)
  process.exitCode = fails === 0 ? 0 : 1
}

void main()
