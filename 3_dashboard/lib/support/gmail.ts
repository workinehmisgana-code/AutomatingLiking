import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import type { GmailAccount } from "./projects";
import { resolveHost } from "./resolve";

export type MailAddress = { name: string; address: string };

export type EmailSummary = {
  uid: number;
  messageId: string | null;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  date: string;
  seen: boolean;
  answered: boolean;
  snippet: string;
  hasAttachments: boolean;
  /** Carries mailing-list or auto-responder headers — never a person typing. */
  bulk: boolean;
};

export type EmailDetail = EmailSummary & {
  text: string;
  html: string | null;
  attachments: { filename: string; size: number; contentType: string }[];
  references: string[];
};

/**
 * Headers that only appear on mailing-list, marketing or auto-generated mail.
 * Someone typing a reply in their own mail client sets none of them.
 */
function looksBulk(parsed: ParsedMail | null): boolean {
  if (!parsed) return false;
  const h = parsed.headers;
  if (h.has("list-unsubscribe") || h.has("list-id") || h.has("feedback-id")) return true;
  if (h.has("x-auto-response-suppress")) return true;

  const precedence = String(h.get("precedence") ?? "").toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;

  const auto = String(h.get("auto-submitted") ?? "").toLowerCase();
  return auto !== "" && auto !== "no";
}

/** Gmail app passwords are displayed in groups of four; the spaces are cosmetic. */
function cleanPassword(password: string): string {
  return password.replace(/\s+/g, "");
}

const IMAP_HOST = "imap.gmail.com";
const SMTP_HOST = "smtp.gmail.com";

async function imapClient(account: GmailAccount): Promise<ImapFlow> {
  // Connect by IP, but keep the hostname for SNI and certificate validation,
  // so a momentary DNS failure can't take the mailbox down. See lib/resolve.ts.
  const host = await resolveHost(IMAP_HOST);
  return new ImapFlow({
    host,
    servername: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: account.user, pass: cleanPassword(account.password) },
    logger: false,
    // Gmail is occasionally slow to greet; give it room before failing.
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
}

/**
 * Network faults that say nothing about the mailbox — a dropped Wi-Fi link, a
 * router that briefly stops resolving DNS, a connection reset mid-handshake.
 * They clear on their own, so they are worth retrying rather than surfacing.
 */
function isTransientNetwork(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    ["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH"].includes(code) ||
    /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|socket close|Connection not available|timed out/i.test(
      message,
    )
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  retryable: (error: unknown) => boolean,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!retryable(error) || attempt === attempts) throw error;
      // 600ms, 2.4s, 5.4s — a dropped Wi-Fi link is usually back inside that.
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt ** 2));
    }
  }
  throw last;
}

/**
 * Run `fn` against a locked INBOX and always tear the connection down.
 * Reads are idempotent, so a transient network fault is retried rather than
 * failing the whole account's fetch.
 */
async function withInbox<T>(
  account: GmailAccount,
  fn: (client: ImapFlow) => Promise<T>,
  mailbox = "INBOX",
): Promise<T> {
  return withRetry(
    async () => {
      const client = await imapClient(account);
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      try {
        return await fn(client);
      } finally {
        lock.release();
        await client.logout().catch(() => client.close());
      }
    },
    4,
    isTransientNetwork,
  );
}

function toAddress(input: unknown): MailAddress {
  const first = (input as { name?: string; address?: string }[] | undefined)?.[0];
  return {
    name: first?.name?.trim() ?? "",
    address: first?.address?.toLowerCase() ?? "",
  };
}

function toAddressList(input: unknown): MailAddress[] {
  const list = (input as { name?: string; address?: string }[] | undefined) ?? [];
  return list.map((a) => ({
    name: a.name?.trim() ?? "",
    address: a.address?.toLowerCase() ?? "",
  }));
}

function makeSnippet(parsed: ParsedMail): string {
  const raw =
    parsed.text ??
    parsed.html?.toString().replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ") ??
    "";
  return raw
    .replace(/^\s*>.*$/gm, "") // drop quoted reply chains
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

/**
 * The newest `limit` messages, or with `unseenOnly` every UNREAD one (newest
 * `limit` of them). Only the first 16KB of each message is downloaded — enough
 * for headers plus a snippet, without pulling attachments for the list view.
 *
 * unseenOnly is for the top-bar count: "unread among the newest 60" misses a
 * customer email that is still waiting once 60 more have arrived after it.
 */
export async function listInbox(
  account: GmailAccount,
  limit = 40,
  mailbox = "INBOX",
  opts: { unseenOnly?: boolean } = {},
): Promise<EmailSummary[]> {
  return withInbox(account, async (client) => {
    const total = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox.exists : 0;
    if (!total) return [];

    let range: string;
    if (opts.unseenOnly) {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []) as number[];
      if (!uids.length) return [];
      range = uids.sort((a, b) => a - b).slice(-limit).join(",");
    } else {
      range = `${Math.max(1, total - limit + 1)}:*`;
    }
    const results: EmailSummary[] = [];

    for await (const msg of client.fetch(range, {
      uid: true,
      flags: true,
      envelope: true,
      source: { start: 0, maxLength: 16 * 1024 },
    }, { uid: !!opts.unseenOnly })) {
      let parsed: ParsedMail | null = null;
      try {
        if (msg.source) parsed = await simpleParser(msg.source);
      } catch {
        parsed = null;
      }

      const flags = msg.flags ?? new Set<string>();
      results.push({
        uid: msg.uid,
        messageId: msg.envelope?.messageId ?? null,
        subject: msg.envelope?.subject?.trim() || "(no subject)",
        from: toAddress(msg.envelope?.from),
        to: toAddressList(msg.envelope?.to),
        date: (msg.envelope?.date ?? new Date()).toISOString(),
        seen: flags.has("\\Seen"),
        answered: flags.has("\\Answered"),
        snippet: parsed ? makeSnippet(parsed) : "",
        hasAttachments: Boolean(parsed?.attachments?.length),
        bulk: looksBulk(parsed),
      });
    }

    return results.reverse(); // newest first
  }, mailbox);
}

/** Full message body for one UID. */
export async function getMessage(
  account: GmailAccount,
  uid: number,
  mailbox = "INBOX",
): Promise<EmailDetail | null> {
  return withInbox(account, async (client) => {
    const msg = await client.fetchOne(
      String(uid),
      { uid: true, flags: true, envelope: true, source: true },
      { uid: true },
    );
    if (!msg || !msg.source) return null;

    const parsed = await simpleParser(msg.source);
    const flags = msg.flags ?? new Set<string>();
    const references = Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : [];

    return {
      uid: msg.uid,
      messageId: msg.envelope?.messageId ?? parsed.messageId ?? null,
      subject: msg.envelope?.subject?.trim() || "(no subject)",
      from: toAddress(msg.envelope?.from),
      to: toAddressList(msg.envelope?.to),
      date: (msg.envelope?.date ?? parsed.date ?? new Date()).toISOString(),
      seen: flags.has("\\Seen"),
      answered: flags.has("\\Answered"),
      snippet: makeSnippet(parsed),
      hasAttachments: Boolean(parsed.attachments?.length),
      bulk: looksBulk(parsed),
      text: parsed.text ?? "",
      html: typeof parsed.html === "string" ? parsed.html : null,
      attachments: (parsed.attachments ?? []).map((a) => ({
        filename: a.filename ?? "attachment",
        size: a.size ?? 0,
        contentType: a.contentType ?? "application/octet-stream",
      })),
      references,
    };
  }, mailbox);
}

export async function setFlags(
  account: GmailAccount,
  uid: number,
  add: string[] = [],
  remove: string[] = [],
  mailbox = "INBOX",
): Promise<void> {
  await withInbox(
    account,
    async (client) => {
      if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });
    },
    mailbox,
  );
}

export type SendReplyInput = {
  to: string;
  subject: string;
  text: string;
  /** Message-Id of the email being answered; keeps the reply in the same Gmail thread. */
  inReplyTo?: string | null;
  references?: string[];
  cc?: string;
};

export async function sendReply(
  account: GmailAccount,
  input: SendReplyInput,
): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: await resolveHost(SMTP_HOST),
    port: 465,
    secure: true,
    // Connecting by IP, so the certificate is checked against the real name.
    tls: { servername: SMTP_HOST },
    auth: { user: account.user, pass: cleanPassword(account.password) },
  });

  const subject = /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`;

  const send = () =>
    transporter.sendMail({
      from: { name: account.fromName, address: account.user },
      to: input.to,
      cc: input.cc || undefined,
      subject,
      text: input.text,
      html: textToHtml(input.text),
      inReplyTo: input.inReplyTo ?? undefined,
      references: input.references?.length
        ? input.references.join(" ")
        : (input.inReplyTo ?? undefined),
    });

  // Only pre-connection faults are retried. A timeout or reset could mean the
  // message was already accepted, and sending it twice is worse than failing.
  const info = await withRetry(send, 3, (error) => {
    const code = (error as { code?: string } | null)?.code ?? "";
    const message = error instanceof Error ? error.message : String(error);
    return (
      ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code) ||
      /ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(message)
    );
  });

  return { messageId: info.messageId };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain-text draft → simple HTML so the reply looks right in every client. */
function textToHtml(text: string): string {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px">${para.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">${body}</div>`;
}
