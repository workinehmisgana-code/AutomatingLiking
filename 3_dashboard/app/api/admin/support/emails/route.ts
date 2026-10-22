import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { classifyIntent, extractEmails, looksLikePerson } from "@/lib/support/classify";
import { listInbox, type EmailSummary } from "@/lib/support/gmail";
import { activeProjects } from "@/lib/support/projects";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export type InboxRow = EmailSummary & {
  key: string;
  projectId: string;
  intent: ReturnType<typeof classifyIntent>;
  /** Sent by an individual rather than an organisation or a robot. */
  isPerson: boolean;
  mentionedEmails: string[];
};

/**
 * Reads every configured project's inbox in parallel and merges them into one
 * newest-first list. A single failing account degrades to an entry in `errors`
 * rather than taking the whole inbox down — one bad app password shouldn't
 * hide the other four sites' mail.
 */
export async function GET(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 40) || 40, 150);
  const only = searchParams.get("project");

  const projects = activeProjects().filter((project) => !only || project.id === only);

  if (projects.length === 0) {
    return NextResponse.json({
      messages: [],
      errors: [
        {
          projectId: null,
          message:
            "No product has Gmail credentials yet. Add <PROJECT>_GMAIL_APP_PASSWORD to the dashboard's environment (e.g. PURIFYTEXT_GMAIL_APP_PASSWORD).",
        },
      ],
    });
  }

  const settled = await Promise.allSettled(
    projects.map(async (project) => {
      const messages = await listInbox(project.gmail!, limit);
      return messages.map<InboxRow>((message) => ({
        ...message,
        key: `${project.id}:${message.uid}`,
        projectId: project.id,
        intent: classifyIntent(message.subject, message.snippet, message.from.address),
        isPerson: looksLikePerson(message.from, message.bulk),
        mentionedEmails: extractEmails(`${message.subject} ${message.snippet}`),
      }));
    }),
  );

  const messages: InboxRow[] = [];
  const errors: { projectId: string; message: string }[] = [];

  settled.forEach((result, index) => {
    const project = projects[index]!;
    if (result.status === "fulfilled") {
      messages.push(...result.value);
    } else {
      errors.push({
        projectId: project.id,
        message: `${project.label}: ${describeMailError(result.reason, project.gmail!.user)}`,
      });
    }
  });

  messages.sort((a, b) => +new Date(b.date) - +new Date(a.date));

  return NextResponse.json({ messages, errors });
}

function describeMailError(error: unknown, account: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(message)) {
    return `Gmail rejected the login for ${account}. The password must be a 16-character App Password from https://myaccount.google.com/apppasswords, with 2-Step Verification enabled on that account.`;
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/i.test(message)) {
    return `Could not reach imap.gmail.com — check your network. (${message})`;
  }
  return message;
}
