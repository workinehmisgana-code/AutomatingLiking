// Live: read every product's support inbox the way the admin's 📥 button does.
//
//   node scripts/run-ts-check.mjs scripts/check-support-inbox.ts
//
// Reads .env, lists each configured product's newest 60 emails over IMAP and
// prints how many are unread and from a real person. Read-only: nothing is
// flagged, sent or changed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

async function main() {
  const { activeProjects, allProjects } = await import('../lib/support/projects')
  const { listInbox } = await import('../lib/support/gmail')
  const { looksLikePerson } = await import('../lib/support/classify')
  console.log('configured:', allProjects().map((p) => `${p.id}${p.active ? '' : ' (no gmail)'}${p.billingReady ? '' : ' (no billing)'}${p.databaseReady ? '' : ' (no db)'}`).join(', '))
  let total = 0
  for (const p of activeProjects()) {
    try {
      const list = await listInbox(p.gmail!, 60)
      const people = list.filter((m) => looksLikePerson(m.from, m.bulk))
      const unread = people.filter((m) => !m.seen)
      total += unread.length
      console.log(`${p.label.padEnd(13)} ${list.length} read · ${people.length} from people · ${unread.length} unread from people`)
    } catch (e) {
      console.log(`${p.label.padEnd(13)} FAILED: ${(e as Error).message}`)
    }
  }
  console.log('button would show:', total)
}
main()
