// Live, read-only: look up real customers the way the support desk's right-hand
// panel does — the product database (plain pg now, not Prisma) and billing.
//
//   node scripts/run-ts-check.mjs scripts/check-support-lookup.ts
//
// Takes the newest few emails from real people in each inbox and loads their
// profile. Nothing is written anywhere.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

async function main() {
  const { activeProjects } = await import('../lib/support/projects')
  const { listInbox } = await import('../lib/support/gmail')
  const { looksLikePerson } = await import('../lib/support/classify')
  const { loadCustomerProfile } = await import('../lib/support/customer')
  for (const p of activeProjects()) {
    const people = (await listInbox(p.gmail!, 60).catch(() => [])).filter((m) => looksLikePerson(m.from, m.bulk))
    const emails = Array.from(new Set(people.map((m) => m.from.address))).slice(0, 4)
    let withAccount = 0
    let withBilling = 0
    const errs = new Set<string>()
    for (const e of emails) {
      const prof = await loadCustomerProfile(p.id, e)
      if (prof.neon) withAccount++
      if (prof.billing) withBilling++
      prof.errors.forEach((x) => errs.add(`${x.source}: ${x.message.slice(0, 120)}`))
    }
    console.log(`${p.label.padEnd(13)} ${emails.length} sender(s) · ${withAccount} found in database · ${withBilling} found in billing`)
    errs.forEach((x) => console.log('   ', x))
  }
  process.exit(0)
}
main()
