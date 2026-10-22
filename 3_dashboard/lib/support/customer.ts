import { describeDbError, findUserByEmail, q, withDbRetry } from "./db";
import { creditsForPlanName } from "./plans";
import { getProject, type Project } from "./projects";
import {
  BillingError,
  providerFor,
  type BillingCustomer,
  type BillingOrder,
  type BillingRefund,
  type BillingSubscription,
} from "./providers";

export type CustomerProfile = {
  lookupEmail: string;
  project: {
    id: string;
    label: string;
    site: string;
    provider: "polar" | "lemonsqueezy" | "freemius";
    providerLabel: string;
    tag: string;
    billingReady: boolean;
    databaseReady: boolean;
    capabilities: {
      refundsViaApi: boolean;
      refundConsoleUrl?: string;
      planChanges: boolean;
      immediateCancellation: boolean;
      cancellationAlwaysImmediate?: boolean;
      partialRefunds: boolean;
      refundReasons: { value: string; label: string }[];
      cancellationNote: string;
    } | null;
  };
  neon: NeonSide | null;
  billing: BillingSide | null;
  errors: { source: "database" | "billing"; message: string }[];
};

type NeonSide = {
  id: string;
  clerkId: string;
  name: string;
  email: string;
  createdAt: string;
  subscriptionPlan: string | null;
  subscriptionType: string | null;
  productId: string | null;
  nextResetDate: string | null;
  creditsRemaining: number;
  extraCredits: number;
  teamId: string | null;
  creditsAllocated: number | null;
  creditsUsed: number | null;
  usage: {
    totalRuns: number;
    totalWords: number;
    firstRunAt: string | null;
    lastRunAt: string | null;
    runsSinceLastPayment: number | null;
    wordsSinceLastPayment: number | null;
  };
  counts: { apiKeys: number; projects: number; ownedTeams: number };
};

type BillingSide = {
  customer: BillingCustomer;
  subscriptions: BillingSubscription[];
  orders: BillingOrder[];
  refunds: BillingRefund[];
  subscribedAt: string | null;
  activeSubscription: BillingSubscription | null;
  lastPayment: {
    orderId: string;
    date: string;
    amount: number;
    currency: string;
    status: string;
    isPaid: boolean;
    isPending: boolean;
    refundedAmount: number;
    productName: string | null;
  } | null;
  totals: { paid: number; refunded: number; currency: string };
};

const ACTIVE_STATUSES = new Set(["active", "trialing", "on_trial", "past_due", "cancelled"]);

/**
 * Columns every site's `user` table has. The apps agree on all of them except
 * the billing-provider ids: the Polar sites store polarCustomerId /
 * polarSubscriptionId, AcousticText stores lemonCustomerId / lemonSubscriptionId.
 *
 * Prisma's default selection asks for every column in its schema, which fails
 * against AcousticText. Listing columns explicitly lets one generated client
 * serve all five databases; the provider id is read separately below.
 */
export const USER_SCALARS = {
  id: true,
  clerkId: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  createdAt: true,
  updatedAt: true,
  credits: true,
  extraCredits: true,
  subscriptionPlan: true,
  subscriptionType: true,
  productId: true,
  nextResetDate: true,
  maxWordsPerRequest: true,
  teamId: true,
} as const;

/**
 * The provider's customer id, when the schema has a column for it. Used only as
 * a lookup hint — it survives a customer changing their email. LemonSqueezy is
 * matched by email instead, so AcousticText never needs this.
 */
async function readProviderCustomerId(
  project: Project,
  userId: string,
): Promise<string | null> {
  if (project.provider !== "polar" || !project.databaseUrl) return null;
  const rows = await withDbRetry(() =>
    q<{ polarCustomerId: string | null }>(
      project.databaseUrl!,
      `SELECT "polarCustomerId" FROM "user" WHERE id = $1`,
      [userId],
    ),
  ).catch(() => []);
  return rows[0]?.polarCustomerId ?? null;
}

export async function loadCustomerProfile(
  projectId: string,
  rawEmail: string,
): Promise<CustomerProfile> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project "${projectId}"`);

  const email = rawEmail.trim().toLowerCase();
  const errors: CustomerProfile["errors"] = [];
  const provider = project.billingReady ? providerFor(project) : null;

  const summary: CustomerProfile["project"] = {
    id: project.id,
    label: project.label,
    site: project.site,
    provider: project.provider,
    providerLabel:
      provider?.label ??
      { polar: "Polar", lemonsqueezy: "LemonSqueezy", freemius: "Freemius" }[project.provider],
    tag: project.tag,
    billingReady: project.billingReady,
    databaseReady: project.databaseReady,
    capabilities: provider?.capabilities ?? null,
  };

  const neon = await loadNeonSide(project, email, errors);

  let billing: BillingSide | null = null;
  if (!provider) {
    errors.push({
      source: "billing",
      message: `No ${summary.providerLabel} credentials for ${project.label}. Add them to .env to look this customer up.`,
    });
  } else {
    try {
      const customer = await provider.findCustomer({
        email,
        customerId: neon?.polarCustomerId ?? null,
      });

      if (customer) {
        const [subscriptions, orders, refunds] = await Promise.all([
          provider.listSubscriptions(customer).catch(() => [] as BillingSubscription[]),
          provider.listOrders(customer).catch(() => [] as BillingOrder[]),
          provider.listRefunds(customer).catch(() => [] as BillingRefund[]),
        ]);

        const activeSubscription =
          subscriptions.find((s) => ACTIVE_STATUSES.has(s.status)) ?? null;
        const oldest = subscriptions[subscriptions.length - 1];
        const latest = orders[0] ?? null;

        billing = {
          customer,
          subscriptions,
          orders,
          refunds,
          subscribedAt: oldest ? (oldest.startedAt ?? oldest.createdAt) : null,
          activeSubscription,
          lastPayment: latest
            ? {
                orderId: latest.id,
                date: latest.createdAt,
                amount: latest.totalAmount,
                currency: latest.currency,
                status: latest.status,
                isPaid: latest.isPaid,
                isPending: latest.isPending,
                refundedAmount: latest.refundedAmount,
                productName: latest.productName,
              }
            : null,
          totals: {
            paid: orders.filter((o) => o.isPaid).reduce((sum, o) => sum + o.totalAmount, 0),
            refunded: orders.reduce((sum, o) => sum + o.refundedAmount, 0),
            currency: latest?.currency ?? "usd",
          },
        };

        // Now that the billing period is known, scope usage to it.
        if (neon && latest && project.databaseUrl) {
          const scoped = await withDbRetry(() =>
            q<{ runs: number; words: string | null }>(
              project.databaseUrl!,
              `SELECT count(*)::int AS runs, sum("tokensUsed")::text AS words
                 FROM humanizer_history WHERE "userId" = $1 AND "createdAt" >= $2`,
              [neon.id, new Date(latest.createdAt)],
            ),
          ).catch(() => null);

          if (scoped?.[0]) {
            neon.usage.runsSinceLastPayment = scoped[0].runs;
            neon.usage.wordsSinceLastPayment = Number(scoped[0].words ?? 0);
          }
        }
      }
    } catch (error) {
      errors.push({
        source: "billing",
        message: error instanceof BillingError ? error.message : describe(error),
      });
    }
  }

  return {
    lookupEmail: email,
    project: summary,
    neon: neon ? stripInternal(neon) : null,
    billing,
    errors,
  };
}

type NeonInternal = NeonSide & { polarCustomerId: string | null };

function stripInternal(value: NeonInternal): NeonSide {
  const { polarCustomerId: _ignored, ...rest } = value;
  return rest;
}

async function loadNeonSide(
  project: Project,
  email: string,
  errors: CustomerProfile["errors"],
): Promise<NeonInternal | null> {
  if (!project.databaseUrl) return null;

  const url = project.databaseUrl;

  try {
    const user = await findUserByEmail(url, email);
    if (!user) return null;

    const allocated =
      (user.productId ? project.creditMap[user.productId] : undefined) ??
      creditsForPlanName(user.subscriptionPlan);

    const [agg, counts] = await Promise.all([
      withDbRetry(() =>
        q<{ runs: number; words: string | null; first: Date | null; last: Date | null }>(
          url,
          `SELECT count(*)::int AS runs, sum("tokensUsed")::text AS words,
                  min("createdAt") AS first, max("createdAt") AS last
             FROM humanizer_history WHERE "userId" = $1`,
          [user.id],
        ),
      ),
      withDbRetry(() =>
        q<{ api_keys: number; projects: number; owned_teams: number }>(
          url,
          `SELECT (SELECT count(*)::int FROM api_key WHERE "userId" = $1) AS api_keys,
                  (SELECT count(*)::int FROM project WHERE "userId" = $1) AS projects,
                  (SELECT count(*)::int FROM team WHERE "ownerId" = $1) AS owned_teams`,
          [user.id],
        ),
      ).catch(() => [{ api_keys: 0, projects: 0, owned_teams: 0 }]),
    ]);
    const aggregate = {
      _count: { _all: agg[0]?.runs ?? 0 },
      _sum: { tokensUsed: Number(agg[0]?.words ?? 0) },
      _min: { createdAt: agg[0]?.first ? new Date(agg[0].first) : null },
      _max: { createdAt: agg[0]?.last ? new Date(agg[0].last) : null },
    };
    const userCounts = {
      apiKeys: counts[0]?.api_keys ?? 0,
      projects: counts[0]?.projects ?? 0,
      ownedTeams: counts[0]?.owned_teams ?? 0,
    };

    return {
      id: user.id,
      clerkId: user.clerkId,
      name: user.name,
      email: user.email,
      createdAt: new Date(user.createdAt).toISOString(),
      subscriptionPlan: user.subscriptionPlan,
      subscriptionType: user.subscriptionType,
      productId: user.productId,
      polarCustomerId: await readProviderCustomerId(project, user.id),
      nextResetDate: user.nextResetDate ? new Date(user.nextResetDate).toISOString() : null,
      creditsRemaining: user.credits,
      extraCredits: user.extraCredits,
      teamId: user.teamId,
      creditsAllocated: allocated ?? null,
      creditsUsed: allocated === null || allocated === undefined
        ? null
        : Math.max(0, allocated - user.credits),
      usage: {
        totalRuns: aggregate._count._all,
        totalWords: aggregate._sum.tokensUsed ?? 0,
        firstRunAt: aggregate._min.createdAt?.toISOString() ?? null,
        lastRunAt: aggregate._max.createdAt?.toISOString() ?? null,
        runsSinceLastPayment: null,
        wordsSinceLastPayment: null,
      },
      counts: userCounts,
    };
  } catch (error) {
    errors.push({ source: "database", message: describeDbError(error, project.label) });
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Condensed, LLM-safe facts used to ground the Groq draft. */
export function accountFacts(profile: CustomerProfile): string[] {
  const facts: string[] = [`This customer wrote to ${profile.project.label} (${profile.project.site}).`];
  const { neon, billing } = profile;

  if (!neon && !billing) {
    return [`No account found for this email address on ${profile.project.label}.`];
  }

  if (billing?.subscribedAt) facts.push(`Subscribed on ${formatDate(billing.subscribedAt)}.`);

  if (billing?.activeSubscription) {
    const s = billing.activeSubscription;
    facts.push(
      `Subscription status is ${s.status}${s.cancelAtPeriodEnd ? " and set to cancel at period end" : ""}.`,
    );
    if (s.currentPeriodEnd) facts.push(`Current billing period ends ${formatDate(s.currentPeriodEnd)}.`);
  }

  if (billing?.lastPayment) {
    const p = billing.lastPayment;
    facts.push(
      `Last payment ${(p.amount / 100).toFixed(2)} ${p.currency.toUpperCase()} on ${formatDate(p.date)}, status ${p.status}.`,
    );
    if (p.refundedAmount > 0) {
      facts.push(`${(p.refundedAmount / 100).toFixed(2)} ${p.currency.toUpperCase()} of that has already been refunded.`);
    }
  }

  if (neon) {
    if (neon.subscriptionPlan) facts.push(`Plan on file: ${neon.subscriptionPlan}.`);
    if (neon.creditsAllocated !== null && neon.creditsUsed !== null) {
      facts.push(
        `Used ${neon.creditsUsed.toLocaleString()} of ${neon.creditsAllocated.toLocaleString()} credits this period; ${neon.creditsRemaining.toLocaleString()} remaining.`,
      );
    } else {
      facts.push(`${neon.creditsRemaining.toLocaleString()} credits remaining.`);
    }
    facts.push(`${neon.usage.totalRuns} runs on the account in total.`);
    if (neon.usage.runsSinceLastPayment !== null) {
      facts.push(`${neon.usage.runsSinceLastPayment} runs since the last payment.`);
    }
  }

  return facts;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
