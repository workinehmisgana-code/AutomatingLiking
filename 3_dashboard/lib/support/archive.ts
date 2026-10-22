import { pool } from '@/lib/db'

/**
 * Snapshot everything known about a product user before the row is deleted
 * from that product's database. Deletion cascades to humanizer history, API
 * keys and projects, so this record is the only evidence left if a chargeback
 * or dispute follows.
 *
 * IN THIS DASHBOARD'S DATABASE, not on disk. The standalone Support Desk wrote
 * a JSON file into archives/<project>/; a Vercel function has no disk that
 * outlives the request, and a public blob is the wrong place for a customer's
 * whole account. A table is private, durable and queryable.
 *
 * Returns a reference to the stored archive ("support_archive #<id>").
 */
let ensured: Promise<unknown> | null = null
function ensureTable() {
  ensured ??= pool.query(`
    CREATE TABLE IF NOT EXISTS support_archive (
      id          BIGSERIAL PRIMARY KEY,
      project     TEXT NOT NULL,
      email       TEXT NOT NULL,
      reason      TEXT,
      data        JSONB NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS support_archive_email_idx ON support_archive (lower(email));
  `)
  return ensured
}

export async function archiveUser(payload: {
  email: string
  project: string
  reason: string
  data: unknown
}): Promise<string> {
  await ensureTable()
  const record = {
    archivedAt: new Date().toISOString(),
    project: payload.project,
    email: payload.email,
    reason: payload.reason,
    ...(payload.data as Record<string, unknown>),
  }
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO support_archive (project, email, reason, data) VALUES ($1, $2, $3, $4) RETURNING id',
    [payload.project, payload.email, payload.reason, JSON.stringify(record)]
  )
  return `support_archive #${rows[0].id}`
}
