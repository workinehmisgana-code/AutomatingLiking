export type Intent = "refund" | "cancel" | "billing" | "support" | "other";

const RULES: { intent: Intent; patterns: RegExp[] }[] = [
  {
    intent: "refund",
    patterns: [
      /\brefund(ed|ing|s)?\b/i,
      /\bmoney\s*back\b/i,
      /\breimburse/i,
      /\bcharge\s*back\b/i,
      /\bchargeback\b/i,
      /\breturn my (money|payment)\b/i,
      /\bwant.{0,20}\bmy money\b/i,
      /\bdispute (the|this) charge\b/i,
    ],
  },
  {
    intent: "cancel",
    patterns: [
      /\bcancel(l)?(ing|ation|led)?\b.{0,30}\b(subscription|plan|membership|account|billing)\b/i,
      /\b(subscription|plan|membership)\b.{0,30}\bcancel/i,
      /\bunsubscribe\b/i,
      /\bstop (the )?(billing|charging|payments?|subscription)\b/i,
      /\bdon'?t (want to )?(be )?(charged|renew)/i,
      /\bturn off auto.?renew/i,
    ],
  },
  {
    intent: "billing",
    patterns: [
      /\b(charged|billed) (twice|again|двa|double)\b/i,
      /\bdouble.?charg/i,
      /\binvoice\b/i,
      /\breceipt\b/i,
      /\bpayment (failed|declined|didn'?t go through)\b/i,
      /\bwrong amount\b/i,
      /\bcredits? (didn'?t|not|never) (arrive|added|credited|show)/i,
    ],
  },
  {
    intent: "support",
    patterns: [
      /\bnot working\b/i,
      /\berror\b/i,
      /\bbug\b/i,
      /\bcan'?t (log ?in|sign ?in|access)\b/i,
      /\bhelp\b/i,
      /\bissue\b/i,
      /\bhow (do|can) i\b/i,
    ],
  },
];

/**
 * Machine-generated mail that will never be a support request. Without this a
 * Google security alert reading "if you didn't create this password for Refund
 * Dashboard…" lands in the refund queue.
 */
const AUTOMATED_SENDERS = [
  /@(accounts|no-?reply|noreply|mail)\.google\.com$/i,
  /^no-?reply@/i,
  /^noreply@/i,
  /^do-?not-?reply@/i,
  /^(mailer-daemon|postmaster)@/i,
  /@(polar\.sh|stripe\.com|vercel\.com|github\.com|neon\.tech)$/i,
];

export function isAutomatedSender(address: string): boolean {
  return AUTOMATED_SENDERS.some((pattern) => pattern.test(address ?? ""));
}

/**
 * Cheap keyword routing so the inbox can be triaged at a glance. Subject text
 * is weighted above body text — "Refund" in a subject line is a stronger signal
 * than the word appearing inside a quoted reply chain.
 */
export function classifyIntent(subject: string, body: string, fromAddress = ""): Intent {
  if (fromAddress && isAutomatedSender(fromAddress)) return "other";

  const subjectText = subject ?? "";
  const bodyText = (body ?? "").slice(0, 4000);

  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(subjectText))) return rule.intent;
  }
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(bodyText))) return rule.intent;
  }
  return "other";
}

export const INTENT_LABELS: Record<Intent, string> = {
  refund: "Refund request",
  cancel: "Cancellation",
  billing: "Billing",
  support: "Support",
  other: "General",
};

/** Mailbox names that belong to a function, not a human. */
const ROLE_MAILBOX =
  /^(no-?reply|do-?not-?reply|support|help|info|contact|hello|hi|team|sales|billing|accounts?|admin|office|service|notifications?|notify|alerts?|updates?|news|newsletter|marketing|mailer|postmaster|mailer-daemon|abuse|security|privacy|legal|careers|jobs|hr|feedback|bounce|robot|bot|system|automated|donotreply)([+.-]|$)/i;

/** Providers where an address almost always belongs to one person. */
const CONSUMER_DOMAIN =
  /@(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|pm|gmx|web|mail|zoho|yandex|inbox|fastmail|hey|qq|163|126|naver|daum|seznam|libero|orange|free|t-online|comcast|verizon|att|sbcglobal|bellsouth|cox|charter)\.[a-z.]{2,}$/i;

/** Words that mark a display name as an organisation rather than a person. */
const ORG_NAME =
  /\b(team|support|inc|llc|ltd|gmbh|corp|co|company|group|labs?|studio|agency|services?|solutions?|technologies|tech|software|systems|media|notifications?|alerts?|billing|noreply|store|shop|app|api|admin|security|news|newsletter|updates?)\b/i;

/**
 * Whether the sender reads as an individual writing to you, rather than an
 * organisation, a robot or a mailing list.
 *
 * Deliberately conservative: something only counts as a person when there is a
 * positive signal (a consumer mailbox, or a display name shaped like a human
 * name). Unknown senders on custom domains fall to false, so the Person view
 * stays trustworthy — everything is still visible under All.
 */
export function looksLikePerson(
  from: { name?: string; address?: string },
  bulk = false,
): boolean {
  const address = (from.address ?? "").toLowerCase().trim();
  const name = (from.name ?? "").trim();
  if (!address) return false;

  // Machines and mailing lists are never people.
  if (bulk || isAutomatedSender(address)) return false;

  const local = address.split("@")[0] ?? "";
  if (ROLE_MAILBOX.test(local)) return false;
  if (ORG_NAME.test(name)) return false;

  if (CONSUMER_DOMAIN.test(address)) return true;

  // Custom domain: fall back to the display name. "Jane Okafor" reads as a
  // person; "Acme Billing" and "acme.com" do not.
  const words = name.split(/\s+/).filter(Boolean);
  const humanShaped =
    words.length >= 2 &&
    words.length <= 4 &&
    // Built with the constructor: the project's ES5 target rejects a /u
    // regex literal at compile time, while every runtime supports it.
    words.every((w) => new RegExp("^[\\p{L}'’.-]+$", "u").test(w)) &&
    !/[@_\d]/.test(name);

  return humanShaped;
}

/** Pull any email addresses mentioned in the body — users often write from a
 *  personal address about an account registered under another one. */
export function extractEmails(text: string): string[] {
  const matches = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
  const cleaned = matches
    .map((m) => m.toLowerCase().replace(/[.,;:)]+$/, ""))
    .filter((m) => !m.endsWith("purifytext.com") && !m.includes("purifytext@"));
  return Array.from(new Set(cleaned));
}
