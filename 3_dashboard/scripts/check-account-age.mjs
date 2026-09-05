// Can we tell when a TikTok account was created, from its profile link alone?
//
// Three candidates, tested against real profiles rather than assumed:
//
//   1. a createTime field on the user object in the embed page's JSON
//   2. the numeric user id — TikTok ids are snowflakes, and a video id carries
//      its creation time in the top 32 bits; if user ids do too, the id alone
//      dates the account
//   3. the oldest video the profile still shows — a floor, not the truth, but
//      one that needs nothing TikTok does not already hand over
//
//   node scripts/check-account-age.mjs [@handle ...]
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36'

const STATE_RE = /<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/

/** Seconds since the epoch encoded in a TikTok snowflake id, or null. */
function idTime(id) {
  try {
    const n = BigInt(String(id))
    if (n <= 0n) return null
    const secs = Number(n >> 32n)
    // TikTok launched in 2016; nothing is created in the future.
    if (secs < 1451606400 || secs * 1000 > Date.now() + 86_400_000) return null
    return secs
  } catch {
    return null
  }
}

/** Every key anywhere in an object whose name smells like a timestamp. */
function timeish(obj, path = '', out = []) {
  if (!obj || typeof obj !== 'object' || out.length > 40) return out
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k
    if (v && typeof v === 'object') {
      timeish(v, p, out)
    } else if (/time|created|since|regist/i.test(k) && v) {
      out.push([p, v])
    }
  }
  return out
}

const handles = process.argv.slice(2).length
  ? process.argv.slice(2).map((h) => h.replace(/^@/, ''))
  : ['samuelfafiolu', 'joewritesbetter', 'lily.collegetips']

for (const handle of handles) {
  console.log(`\n=== @${handle} ===`)
  let html = ''
  try {
    const res = await fetch(`https://www.tiktok.com/embed/@${handle}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    })
    if (!res.ok) {
      console.log(`  embed page returned HTTP ${res.status}`)
      continue
    }
    html = await res.text()
  } catch (e) {
    console.log('  could not fetch:', String(e).slice(0, 80))
    continue
  }

  const m = STATE_RE.exec(html)
  if (!m) {
    console.log('  no embedded state on the page')
    continue
  }
  let state
  try {
    state = JSON.parse(m[1])
  } catch {
    console.log('  embedded state did not parse')
    continue
  }

  const data = state.source?.data ?? {}
  const key = Object.keys(data).find((k) => k.toLowerCase().startsWith('/embed/@'))
  const payload = key ? data[key] : null
  if (!payload) {
    console.log('  no profile payload')
    continue
  }

  // 1. Anything that looks like a creation time.
  const stamps = timeish(payload.userInfo ?? payload)
  console.log(`  timestamp-ish fields: ${stamps.length ? '' : 'none'}`)
  for (const [k, v] of stamps.slice(0, 12)) console.log(`     ${k} = ${v}`)

  // 2. The user id, decoded as a snowflake.
  const uid =
    payload.userInfo?.user?.id ?? payload.user?.id ?? payload.userInfo?.user?.uid ?? null
  if (uid) {
    const secs = idTime(uid)
    console.log(
      `  user id ${uid} -> ${
        secs ? new Date(secs * 1000).toISOString().slice(0, 10) + ' (if ids are snowflakes)' : 'no plausible date'
      }`
    )
  } else {
    console.log('  no user id in the payload')
  }

  // 3. The oldest video still listed, and what its id decodes to.
  const list = Array.isArray(payload.videoList) ? payload.videoList : []
  const ids = list.map((v) => String(v.id ?? '')).filter(Boolean)
  const dated = ids.map((id) => idTime(id)).filter((s) => s !== null)
  if (dated.length) {
    const oldest = Math.min(...dated)
    const newest = Math.max(...dated)
    console.log(
      `  ${ids.length} video(s) listed · oldest ${new Date(oldest * 1000)
        .toISOString()
        .slice(0, 10)} · newest ${new Date(newest * 1000).toISOString().slice(0, 10)}`
    )
  } else {
    console.log(`  ${ids.length} video(s) listed, none with a decodable id`)
  }
}
