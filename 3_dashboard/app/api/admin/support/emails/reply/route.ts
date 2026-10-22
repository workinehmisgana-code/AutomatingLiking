import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { sendReply, setFlags } from "@/lib/support/gmail";
import { getProject } from "@/lib/support/projects";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

type Body = {
  projectId?: string;
  uid?: number;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  inReplyTo?: string | null;
  references?: string[];
};

export async function POST(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const body = (await request.json()) as Body;

  // The reply always goes out from the account that received it, so the
  // customer sees the same address they wrote to.
  const project = body.projectId ? getProject(body.projectId) : null;
  if (!project?.gmail) {
    return NextResponse.json(
      { error: `No Gmail credentials configured for "${body.projectId ?? "(missing project)"}"` },
      { status: 400 },
    );
  }
  if (!body.to?.trim()) {
    return NextResponse.json({ error: "Recipient is required" }, { status: 400 });
  }
  if (!body.text?.trim()) {
    return NextResponse.json({ error: "Reply body is empty" }, { status: 400 });
  }

  try {
    const result = await sendReply(project.gmail, {
      to: body.to.trim(),
      cc: body.cc?.trim(),
      subject: body.subject?.trim() || `Your ${project.label} request`,
      text: body.text.trim(),
      inReplyTo: body.inReplyTo ?? null,
      references: body.references ?? [],
    });

    if (body.uid) {
      await setFlags(project.gmail, body.uid, ["\\Answered", "\\Seen"]).catch(() => undefined);
    }

    return NextResponse.json({ ok: true, messageId: result.messageId, sentFrom: project.gmail.user });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: /Username and Password not accepted|BadCredentials/i.test(message)
          ? `Gmail rejected the SMTP login for ${project.gmail.user}. That project's app password must be a 16-character App Password.`
          : message,
      },
      { status: 502 },
    );
  }
}
