import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { accountFacts, loadCustomerProfile } from "@/lib/support/customer";
import { draftReply } from "@/lib/support/groq";
import { getProject } from "@/lib/support/projects";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

type Body = {
  projectId?: string;
  instruction?: string;
  customerEmail?: string;
  customerName?: string | null;
  subject?: string;
  originalBody?: string;
  actionsTaken?: string[];
  tone?: "warm" | "neutral" | "firm";
  /** Pull plan/payment facts from the project's billing + database. */
  includeAccountFacts?: boolean;
};

export async function POST(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const body = (await request.json()) as Body;

  const project = body.projectId ? getProject(body.projectId) : null;
  if (!project) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  if (!body.instruction?.trim()) {
    return NextResponse.json(
      { error: "Say in a few words what you want to reply." },
      { status: 400 },
    );
  }
  if (!body.customerEmail?.trim()) {
    return NextResponse.json({ error: "customerEmail is required" }, { status: 400 });
  }

  try {
    let facts: string[] | undefined;
    if (body.includeAccountFacts) {
      const profile = await loadCustomerProfile(project.id, body.customerEmail).catch(() => null);
      if (profile) facts = accountFacts(profile);
    }

    const draft = await draftReply({
      instruction: body.instruction.trim(),
      customerEmail: body.customerEmail.trim(),
      customerName: body.customerName ?? null,
      originalSubject: body.subject ?? "",
      originalBody: body.originalBody ?? "",
      actionsTaken: body.actionsTaken,
      accountFacts: facts,
      tone: body.tone,
      brand: { label: project.label, site: project.site },
    });

    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
