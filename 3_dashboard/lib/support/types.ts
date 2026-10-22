import type { Intent } from "@/lib/support/classify";
import type { CustomerProfile } from "@/lib/support/customer";
import type { EmailDetail, EmailSummary } from "@/lib/support/gmail";
import type { ProjectSummary } from "@/lib/support/projects";
import type { BillingStatus } from "@/app/api/admin/support/status/route";

export type { Intent, CustomerProfile, EmailDetail, EmailSummary, ProjectSummary, BillingStatus };

/** Keyed `${projectId}:${senderEmail}` — one entry per sender, not per email. */
export type StatusMap = Record<string, BillingStatus>;

type ProjectTagged = {
  /** `${projectId}:${uid}` — UIDs are only unique within one mailbox. */
  key: string;
  projectId: string;
  intent: Intent;
  isPerson: boolean;
  mentionedEmails: string[];
};

export type InboxMessage = EmailSummary & ProjectTagged;
export type InboxDetail = EmailDetail & ProjectTagged;

export type BillingSide = NonNullable<CustomerProfile["billing"]>;
export type BillingOrder = BillingSide["orders"][number];
export type BillingSubscription = BillingSide["subscriptions"][number];
