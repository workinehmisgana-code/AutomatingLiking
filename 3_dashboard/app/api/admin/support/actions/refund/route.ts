import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { findUserByEmail, q, withDbRetry } from "@/lib/support/db";
import { getProject } from "@/lib/support/projects";
import { BillingError, formatMoney, providerFor } from "@/lib/support/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

type Body = {
  projectId?: string;
  orderId?: string;
  /** Minor units (cents). */
  amount?: number;
  reason?: string;
  comment?: string;
  /** The customer, so their account can be stripped too. */
  email?: string;
  /**
   * Take back everything the money paid for: the provider entitlement, the
   * subscription, and the paid plan in the app's own database. Without this a
   * refunded customer keeps using the product.
   */
  revokeAccess?: boolean;
  revokeBenefits?: boolean;
  /**
   * Must echo the order id. A coherence check that the caller refunded the
   * order it displayed — the human confirmation lives in the modal.
   */
  confirm?: string;
};

export async function POST(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const body = (await request.json()) as Body;

  const project = body.projectId ? getProject(body.projectId) : null;
  if (!project) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  const provider = providerFor(project);
  if (!provider) {
    return NextResponse.json(
      { error: `${project.label} has no billing credentials configured.` },
      { status: 400 },
    );
  }
  if (!body.orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }
  if (body.confirm !== body.orderId) {
    return NextResponse.json(
      { error: "Confirmation does not match the order id" },
      { status: 400 },
    );
  }
  if (!body.amount || body.amount <= 0) {
    return NextResponse.json({ error: "Refund amount must be greater than zero" }, { status: 400 });
  }

  const allowedReasons = provider.capabilities.refundReasons.map((entry) => entry.value);
  const reason =
    body.reason && allowedReasons.includes(body.reason)
      ? body.reason
      : (allowedReasons[0] ?? "customer_request");

  try {
    // Re-read the order rather than trusting the panel, which may have been
    // rendered before someone else refunded part of it.
    const order = await provider.getOrder(body.orderId);
    const refundable = order.totalAmount - order.refundedAmount;
    const amount = Math.round(body.amount);

    if (order.isPending) {
      return NextResponse.json(
        {
          error: `This charge has not settled yet — ${provider.label} can only refund a paid order.`,
        },
        { status: 400 },
      );
    }
    if (refundable <= 0) {
      return NextResponse.json(
        { error: "This order has already been refunded in full." },
        { status: 400 },
      );
    }
    if (amount > refundable) {
      return NextResponse.json(
        {
          error: `Only ${formatMoney(refundable, order.currency)} is left to refund on this order${
            order.refundedAmount > 0
              ? ` (${formatMoney(order.refundedAmount, order.currency)} was already refunded)`
              : ""
          }.`,
        },
        { status: 400 },
      );
    }

    const revoke = body.revokeAccess ?? false;

    const refund = await provider.createRefund({
      orderId: body.orderId,
      amount,
      reason,
      comment: body.comment,
      // Polar accepts this on one-time orders only; LemonSqueezy and Freemius
      // never do. Subscription entitlements come back via the cancel below.
      revokeBenefits: order.supportsBenefitRevocation ? revoke || (body.revokeBenefits ?? false) : false,
    });

    const steps: { step: string; ok: boolean; detail: string }[] = [];
    const record = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail });
    record("refund", true, `${formatMoney(amount, order.currency)} refunded.`);

    if (revoke) {
      await revokeAccess({ project, provider, order, email: body.email, record });
    }

    return NextResponse.json({
      ok: true,
      refund,
      steps,
      // Money is back, but an untouched subscription will still bill next cycle.
      subscriptionStillActive: revoke ? null : order.subscriptionId,
    });
  } catch (error) {
    if (error instanceof BillingError) {
      return NextResponse.json({ error: error.message, details: error.body }, { status: 502 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

const LIVE_STATUSES = new Set(["active", "trialing", "on_trial", "past_due"]);

/**
 * Take back what the payment bought. Three systems, none of which knows about
 * the others:
 *
 *   1. The provider entitlement, where the provider supports revoking it.
 *   2. The subscription, so it stops billing AND stops granting access.
 *   3. The app's own database, which is what actually gates the product —
 *      a refunded customer with 20,000 credits still has 20,000 credits.
 *
 * Each step reports separately; a failure in one does not stop the others,
 * because the money has already moved and leaving access half-revoked silently
 * would be worse than reporting exactly what did and did not happen.
 */
async function revokeAccess({
  project,
  provider,
  order,
  email,
  record,
}: {
  project: NonNullable<ReturnType<typeof getProject>>;
  provider: NonNullable<ReturnType<typeof providerFor>>;
  order: Awaited<ReturnType<NonNullable<ReturnType<typeof providerFor>>["getOrder"]>>;
  email?: string;
  record: (step: string, ok: boolean, detail: string) => void;
}): Promise<void> {
  // ── Subscription ────────────────────────────────────────────────────────
  try {
    let subscriptionId = order.subscriptionId;

    // A top-up order carries no subscription, but the customer may still have
    // one — look it up rather than leaving them subscribed.
    if (!subscriptionId && email) {
      const customer = await provider.findCustomer({ email });
      if (customer) {
        const subs = await provider.listSubscriptions(customer);
        subscriptionId = subs.find((s) => LIVE_STATUSES.has(s.status))?.id ?? null;
      }
    }

    if (!subscriptionId) {
      record("subscription", true, "No live subscription to cancel.");
    } else {
      // Immediately wherever the provider allows it — they have their money back.
      const atPeriodEnd = !provider.capabilities.immediateCancellation;
      await provider.cancelSubscription(subscriptionId, atPeriodEnd);
      record(
        "subscription",
        true,
        atPeriodEnd
          ? `Subscription cancelled; ${provider.label} only allows a grace period, so access runs to the period end.`
          : "Subscription cancelled immediately.",
      );
    }
  } catch (error) {
    record(
      "subscription",
      false,
      error instanceof BillingError ? error.message : String(error),
    );
  }

  // ── Account database ────────────────────────────────────────────────────
  if (!project.databaseUrl) {
    record("database", false, `${project.label} has no database configured.`);
    return;
  }
  if (!email) {
    record("database", false, "No customer email, so the account could not be found.");
    return;
  }

  try {
    const url = project.databaseUrl;
    const user = await findUserByEmail(url, email);

    if (!user) {
      record("database", false, `No user in the ${project.label} database with that email.`);
      return;
    }

    // Columns every site shares. Back to the free-tier ceiling of 600 words.
    await withDbRetry(() =>
      q(
        url,
        `UPDATE "user" SET credits = 0, "extraCredits" = 0, "subscriptionPlan" = NULL,
                "subscriptionType" = NULL, "productId" = NULL, "nextResetDate" = NULL,
                "maxWordsPerRequest" = 600
          WHERE id = $1`,
        [user.id],
      ),
    );

    record(
      "database",
      true,
      `Account stripped: ${(user.credits + user.extraCredits).toLocaleString()} credits zeroed, ${
        user.subscriptionPlan ?? "plan"
      } cleared, word limit back to 600.`,
    );
  } catch (error) {
    record("database", false, error instanceof Error ? error.message : String(error));
  }
}
