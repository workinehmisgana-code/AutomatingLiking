import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { classifyIntent, extractEmails, looksLikePerson } from "@/lib/support/classify";
import { getMessage, setFlags } from "@/lib/support/gmail";
import { getProject } from "@/lib/support/projects";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function GET(
  request: Request,
  context: { params: { project: string; uid: string } },
) {
  const denied = await supportGuard();
  if (denied) return denied;
  const { project: projectId, uid } = context.params;
  const numericUid = Number(uid);

  const project = getProject(projectId);
  if (!project?.gmail) {
    return NextResponse.json(
      { error: `No Gmail credentials configured for "${projectId}"` },
      { status: 404 },
    );
  }
  if (!Number.isFinite(numericUid)) {
    return NextResponse.json({ error: "Invalid message id" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const markRead = searchParams.get("markRead") !== "false";

  try {
    const message = await getMessage(project.gmail, numericUid);
    if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });

    if (markRead && !message.seen) {
      // Non-fatal: reading the mail matters more than the flag sticking.
      await setFlags(project.gmail, numericUid, ["\\Seen"]).catch(() => undefined);
      message.seen = true;
    }

    const bodyText = message.text || message.snippet;

    return NextResponse.json({
      message: {
        ...message,
        key: `${project.id}:${message.uid}`,
        projectId: project.id,
        intent: classifyIntent(message.subject, bodyText, message.from.address),
        isPerson: looksLikePerson(message.from, message.bulk),
        mentionedEmails: extractEmails(`${message.subject} ${bodyText}`),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
