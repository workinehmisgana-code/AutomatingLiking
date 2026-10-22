import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { archiveUser } from "@/lib/support/archive";
import { loadCustomerProfile } from "@/lib/support/customer";
import { findUserByEmail, q, withDbRetry } from "@/lib/support/db";
import { getProject } from "@/lib/support/projects";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Body = {
  projectId?: string;
  email?: string;
  /** Must equal the email — typed by hand in the UI. */
  confirm?: string;
  reason?: string;
};

const TEXT_CAP = 500;

export async function POST(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const body = (await request.json()) as Body;
  const email = body.email?.trim().toLowerCase();

  const project = body.projectId ? getProject(body.projectId) : null;
  if (!project) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  if (!project.databaseUrl) {
    return NextResponse.json(
      { error: `${project.label} has no DATABASE_URL configured, so there is nothing to delete.` },
      { status: 400 },
    );
  }
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  if (body.confirm?.trim().toLowerCase() !== email) {
    return NextResponse.json(
      { error: "Typed confirmation does not match the account email" },
      { status: 400 },
    );
  }

  const url = project.databaseUrl;

  try {
    const found = await findUserByEmail(url, email);
    // Everything the delete will take with it, read first so the archive is
    // complete. Explicit tables and columns: the products share these.
    const [apiKeys, projects, ownedTeams, userActivities, humanizerHistory] = found
      ? await Promise.all([
          withDbRetry(() => q<{ key: string } & Record<string, unknown>>(url, `SELECT * FROM api_key WHERE "userId" = $1`, [found.id])),
          withDbRetry(() => q(url, `SELECT * FROM project WHERE "userId" = $1`, [found.id])),
          withDbRetry(() => q(url, `SELECT * FROM team WHERE "ownerId" = $1`, [found.id])),
          withDbRetry(() => q(url, `SELECT * FROM user_activity WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 500`, [found.id])).catch(() => []),
          withDbRetry(() =>
            q<{ originalText: string; humanizedText: string } & Record<string, unknown>>(
              url, `SELECT * FROM humanizer_history WHERE "userId" = $1 ORDER BY "createdAt" DESC`, [found.id],
            ),
          ),
        ])
      : [[], [], [], [], []];
    const user = found ? { ...found, apiKeys, projects, ownedTeams, userActivities, humanizerHistory } : null;

    if (!user) {
      return NextResponse.json(
        { error: `No user in the ${project.label} database with the email ${email}` },
        { status: 404 },
      );
    }

    // Authoritative billing snapshot at the moment of deletion.
    const profile = await loadCustomerProfile(project.id, email).catch(() => null);

    const archivePath = await archiveUser({
      email,
      project: project.id,
      reason: body.reason?.trim() || "Refund processed via support dashboard",
      data: {
        site: project.site,
        provider: project.provider,
        databaseUser: {
          ...user,
          apiKeys: user.apiKeys.map((k) => ({ ...k, key: `${k.key.slice(0, 8)}…redacted` })),
          humanizerHistory: user.humanizerHistory.map((h) => ({
            ...h,
            originalText: truncate(h.originalText),
            humanizedText: truncate(h.humanizedText),
            textTruncated: h.originalText.length > TEXT_CAP || h.humanizedText.length > TEXT_CAP,
          })),
        },
        billingSnapshot: profile?.billing ?? null,
        usageSummary: profile?.neon?.usage ?? null,
      },
    });

    // Cascades to api_key, project, humanizer_history and owned teams;
    // user_activity rows keep their history with a null user reference.
    // `select` is not optional here: delete() and update() return the row by
    // default, which makes Prisma ask for every column in its schema —
    // including the polar* ids that AcousticText's database does not have.
    await withDbRetry(() => q(url, `DELETE FROM "user" WHERE id = $1`, [user.id]));

    return NextResponse.json({
      ok: true,
      archivePath,
      deleted: {
        id: user.id,
        email: user.email,
        project: project.label,
        humanizerRuns: user.humanizerHistory.length,
        apiKeys: user.apiKeys.length,
        projects: user.projects.length,
        ownedTeams: user.ownedTeams.length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

function truncate(value: string): string {
  return value.length > TEXT_CAP ? `${value.slice(0, TEXT_CAP)}…` : value;
}
