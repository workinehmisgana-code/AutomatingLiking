// Automatic channel extraction, on and off per platform.
//
// The pipeline's harvest stage looks at channels for videos nobody has seen and
// merges what it judges related. That is the one thing in the dashboard that
// adds links WITHOUT anyone asking, so it needs a switch — per platform, because
// the platforms are not equally worth harvesting.
//
// What the switch must and must not do:
//
//   * ON is the default, everywhere, so nothing changes until it is turned off;
//   * OFF stops that platform's channels being visited at all — no listing
//     fetch, no staging, no merge;
//   * OFF changes NOTHING else: links already in the pool are still served, and
//     the platform's hourly and retirement switches are untouched;
//   * YouTube Shorts and YouTube Videos share channels, so a YouTube channel is
//     visited while either of the two is on.
//
// Runs against the real database, on the real rows, and puts every switch back
// the way it found it.
//
//   node scripts/check-harvest-switch.mjs
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const PLATFORMS = ['tiktok', 'youtube_shorts', 'youtube_videos', 'instagram']

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

// The column is created by ensurePlatformLimitTable() on first use; do the same
// thing here so this can run before the app has ever touched the table.
await db.query(
  `ALTER TABLE platform_limit
     ADD COLUMN IF NOT EXISTS harvest_enabled BOOLEAN NOT NULL DEFAULT true`
)

const before = new Map(
  (await q('SELECT platform, enabled, retire_enabled, harvest_enabled FROM platform_limit')).map(
    (r) => [r.platform, r]
  )
)

try {
  console.log('the switch is stored per platform, and defaults on:')
  const col = (
    await q(
      `SELECT column_default AS d, is_nullable AS n FROM information_schema.columns
        WHERE table_name = 'platform_limit' AND column_name = 'harvest_enabled'`
    )
  )[0]
  check('  the column exists', !!col, true)
  check('  defaulting to true', String(col?.d ?? '').includes('true'), true)
  check('  and never null', col?.n, 'NO')

  // Flip one platform off and read every row back.
  await db.query(
    `INSERT INTO platform_limit (platform, hourly_limit, window_ms, harvest_enabled, updated_at)
     VALUES ('instagram', 20, 3600000, false, now())
     ON CONFLICT (platform) DO UPDATE SET harvest_enabled = false, updated_at = now()`
  )
  const rows = new Map(
    (await q('SELECT platform, enabled, retire_enabled, harvest_enabled FROM platform_limit')).map(
      (r) => [r.platform, r]
    )
  )
  console.log('\nturning one platform off leaves the others alone:')
  check('  instagram is off', rows.get('instagram')?.harvest_enabled, false)
  for (const p of PLATFORMS.filter((x) => x !== 'instagram')) {
    // A platform with no saved row is on by default, which is the same answer.
    const r = rows.get(p)
    check(`  ${p} is still on`, r ? r.harvest_enabled !== false : true, true)
  }

  console.log('\nand its OTHER switches are untouched:')
  const ig = rows.get('instagram')
  const igBefore = before.get('instagram')
  if (igBefore) {
    check('  hourly', ig?.enabled, igBefore.enabled)
    check('  retire', ig?.retire_enabled, igBefore.retire_enabled)
  } else {
    check('  hourly still defaults on', ig?.enabled, true)
    check('  retire still defaults on', ig?.retire_enabled, true)
  }
} finally {
  // Put every row back exactly as it was; delete the one we created.
  if (before.has('instagram')) {
    const r = before.get('instagram')
    await db.query('UPDATE platform_limit SET harvest_enabled = $2 WHERE platform = $1', [
      'instagram',
      r.harvest_enabled,
    ])
  } else {
    await db.query("DELETE FROM platform_limit WHERE platform = 'instagram'")
  }
  await db.end()
}

// ── the harvest actually reads it ──────────────────────────────────────────
const harvest = read('lib/channelHarvest.ts')
const config = read('lib/config.ts')
const route = read('app/api/admin/limits/route.ts')
const ui = read('components/PlatformLimits.tsx')

console.log('\nthe harvest reads the switch on every slice:')
check('  it asks the database', /getHarvestPlatforms\(\)/.test(harvest), true)
check('  not a cached constant', /const \[ranked, on\] = await Promise\.all/.test(harvest), true)
check('  and filters the channels by it', /qualified\.filter\(\(c\) => siteIsOn\(c\.platform\)\)/.test(harvest), true)
check(
  '  a channel is only visited when its site is on',
  /\(CHANNEL_SITE_PLATFORMS\[site\] \?\? \[\]\)\.some\(\(p\) => on\.has\(p\)\)/.test(harvest),
  true
)
check('  it reports what it skipped', /offPlatform: qualified\.length - eligible\.length/.test(harvest), true)

console.log('\nyoutube channels answer to both youtube switches:')
const map = config.slice(config.indexOf('CHANNEL_SITE_PLATFORMS'))
check('  tiktok maps to tiktok', /tiktok: \['tiktok'\]/.test(map), true)
check('  instagram to instagram', /instagram: \['instagram'\]/.test(map), true)
check('  youtube to both', /youtube: \['youtube_shorts', 'youtube_videos'\]/.test(map), true)

console.log('\nthe admin can flip it:')
check('  the api accepts it', /typeof b\?\.harvestEnabled === 'boolean'/.test(route), true)
check('  and writes only that column', /setPlatformHarvestEnabled\(platformArg, b\.harvestEnabled\)/.test(route), true)
check('  the panel has a switch per platform', /savePlatformFlag\(p, 'harvestEnabled', !cur\.harvestEnabled\)/.test(ui), true)
check('  with its own column header', /<span className="text-right" title="Automatically extract new videos/.test(ui), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
