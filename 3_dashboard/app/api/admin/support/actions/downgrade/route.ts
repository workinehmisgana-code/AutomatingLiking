import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { findUserByEmail, q, withDbRetry } from "@/lib/support/db";
import { getProject } from "@/lib/support/projects";
import { BillingError, formatMoney, providerFor } from "@/lib/support/providers";
import { isMonthly, isYearly, quoteYearlyToMonthly } from "@/lib/support/intervalDowngrade";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Body = {
  projectId?: string;
  email?: string;
  subscriptionId?: string;
  /** Plan to move onto. */
  newProductId?: string;
  /** Order the refund is taken from — normally their latest paid one. */
  refundOrderId?: string;
  /** Minor units. Full price difference, per the desk's policy. */
  refundAmount?: number;
  /** Credits the new plan grants, for capping the balance. */
  newPlanCredits?: number;
  newMaxWords?: number;
  newPlanName?: string;
  /** Lift a pending cancellation as part of the downgrade. */
  resume?: boolean;
  /**
   * YEARLY → MONTHLY. The refund is then worked out here, not taken from the
   * page: every started month kept at the monthly price, the rest back to the
   * card, and the year cut short so monthly billing starts when those months
   * run out. refundAmount is ignored.
   */
  toMonthly?: boolean;
  confirm?: string;
};

/**
 * Downgrade runs three independent systems in sequence, and any of them can
 * fail on its own. Rather than pretend it's atomic, each step is recorded and
 * reported back, so a partial result is visible instead of silent.
 *
 * Order matters: the plan change is scheduled first (reversible by changing it
 * back), the refund second (the irreversible one), the database last (a local
 * correction you can redo). That way money never moves for a plan change that
 * didn't take.
 */
export async function POST(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const body = (await request.json()) as Body;

  const project = body.projectId ? getProject(body.projectId) : null;
  if (!project) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const provider = providerFor(project);
  if (!provider) {
    return NextResponse.json(
      { error: `${project.label} has no billing credentials configured.` },
      { status: 400 },
    );
  }
  if (!provider.capabilities.planChanges) {
    return NextResponse.json(
      {
        error: `${provider.label} has no plan-change API. Move the customer to the new plan and refund the difference in the ${provider.label} dashboard.`,
      },
      { status: 501 },
    );
  }
  if (!body.subscriptionId || !body.newProductId) {
    return NextResponse.json(
      { error: "subscriptionId and newProductId are required" },
      { status: 400 },
    );
  }
  if (body.confirm !== body.subscriptionId) {
    return NextResponse.json(
      { error: "Confirmation does not match the subscription id" },
      { status: 400 },
    );
  }

  const steps: { step: string; ok: boolean; detail: string }[] = [];
  const record = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail });

  if (body.toMonthly) {
    try {
      const failed = await yearlyToMonthly(provider, body, record);
      if (failed) return failed;
    } catch (error) {
      const message = error instanceof BillingError ? error.message : String(error);
      return NextResponse.json({ error: message, steps }, { status: 502 });
    }
    await capCredits(project, body, record);
    return NextResponse.json({ ok: true, steps });
  }

  // ── 1. Move the subscription onto the cheaper plan ──────────────────────
  try {
    await provider.changePlan(body.subscriptionId, body.newProductId, { resume: body.resume });
    record(
      "plan",
      true,
      `Subscription moved to ${body.newPlanName ?? "the new plan"} from the next billing period${
        body.resume ? ", and the pending cancellation was lifted" : ""
      }.`,
    );
  } catch (error) {
    const message = error instanceof BillingError ? error.message : String(error);
    record("plan", false, message);
    // Nothing else should run if the plan didn't change — refunding now would
    // give money back for a downgrade that never happened.
    return NextResponse.json({ error: `Plan change failed: ${message}`, steps }, { status: 502 });
  }

  // ── 2. Put the price difference back on their card ──────────────────────
  const amount = Math.round(body.refundAmount ?? 0);
  if (body.refundOrderId && amount > 0) {
    try {
      const order = await provider.getOrder(body.refundOrderId);
      const refundable = order.totalAmount - order.refundedAmount;
      if (refundable <= 0) {
        record("refund", false, "That order has already been refunded in full.");
      } else {
        const capped = Math.min(amount, refundable);
        await provider.createRefund({
          orderId: body.refundOrderId,
          amount: capped,
          reason: provider.capabilities.refundReasons[0]?.value ?? "customer_request",
          comment: `Downgrade to ${body.newPlanName ?? "a cheaper plan"}`,
          revokeBenefits: false,
        });
        record(
          "refund",
          true,
          `${formatMoney(capped, order.currency)} refunded${
            capped < amount ? ` (capped from ${formatMoney(amount, order.currency)})` : ""
          }.`,
        );
      }
    } catch (error) {
      record("refund", false, error instanceof BillingError ? error.message : String(error));
    }
  } else {
    record("refund", false, "No refund requested.");
  }

  await capCredits(project, body, record);

  return NextResponse.json({ ok: true, steps });
}

type RecordStep = (step: string, ok: boolean, detail: string) => void;

/**
 * Yearly → monthly, in the order that never leaves money moved for a change
 * that did not take:
 *
 *   1. Cut the current (yearly) period short to the months they keep. Moves
 *      no money; put back below if the next step fails.
 *   2. Schedule the monthly plan for the next period — which now starts when
 *      those months run out. next_period, so the provider issues no proration
 *      credit of its own (the refund below is the whole compensation).
 *   3. Refund the rest of the yearly payment to the card. The irreversible one.
 *
 * Returns an error response to send, or null when the caller should go on.
 */
async function yearlyToMonthly(
  provider: NonNullable<ReturnType<typeof providerFor>>,
  body: Body,
  record: RecordStep,
): Promise<NextResponse | null> {
  const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });
  const setEnd = provider.setBillingPeriodEnd?.bind(provider);
  if (!provider.capabilities.billingPeriodChanges || !setEnd) {
    return fail(
      `${provider.label} cannot shorten a billing period through its API, so a yearly plan cannot be turned into a monthly one from here. Do it in the ${provider.label} dashboard.`,
      501,
    );
  }
  if (!body.email) return fail("The customer email is required.");
  if (!body.refundOrderId) return fail("The yearly payment to refund from is required.");

  // Everything from the provider, nothing from the page.
  const customer = await provider.findCustomer({ email: body.email });
  const subs = customer ? await provider.listSubscriptions(customer) : [];
  const sub = subs.find((s) => s.id === body.subscriptionId);
  if (!sub) return fail("That subscription was not found for this customer.");
  if (!isYearly(sub.interval)) return fail("That subscription is not billed yearly.");

  const target = (await provider.listProducts()).find((p) => p.id === body.newProductId);
  if (!target || !isMonthly(target.interval) || target.amount == null) {
    return fail("The plan to move onto must be a monthly plan with a price.");
  }

  const order = await provider.getOrder(body.refundOrderId);
  if (order.subscriptionId !== sub.id) return fail("That payment is not for this subscription.");
  if (!order.isPaid) return fail("That payment has not been paid.");
  const refundable = order.totalAmount - order.refundedAmount;

  const quote = quoteYearlyToMonthly({
    paidAt: order.createdAt,
    paid: order.totalAmount,
    monthly: target.amount,
  });
  const refund = Math.min(quote.difference, refundable);
  if (refund <= 0) {
    return fail(
      `Nothing to refund: ${quote.monthsUsed} month(s) at ${formatMoney(target.amount, target.currency)} come to ${formatMoney(quote.kept, order.currency)}, which is not less than what is left on the payment (${formatMoney(refundable, order.currency)}).`,
    );
  }
  if (sub.currentPeriodEnd && new Date(quote.paidThrough) >= new Date(sub.currentPeriodEnd)) {
    return fail("The months kept already reach the end of the yearly period — nothing to shorten.");
  }

  // ── 1. Cut the year short ───────────────────────────────────────────────
  try {
    await setEnd(sub.id, quote.paidThrough);
    record(
      "period",
      true,
      `Yearly period now ends ${quote.paidThrough.slice(0, 10)} (${quote.monthsUsed} month(s) kept).`,
    );
  } catch (error) {
    const message = error instanceof BillingError ? error.message : String(error);
    record("period", false, message);
    return fail(`Could not shorten the yearly period: ${message}. Nothing was changed.`, 502);
  }

  // ── 2. Monthly from then on ─────────────────────────────────────────────
  try {
    await provider.changePlan(sub.id, target.id, { resume: sub.cancelAtPeriodEnd });
    record(
      "plan",
      true,
      `Moves to ${target.name} on ${quote.paidThrough.slice(0, 10)}, billed ${formatMoney(target.amount, target.currency)} a month${
        sub.cancelAtPeriodEnd ? "; the pending cancellation was lifted" : ""
      }.`,
    );
  } catch (error) {
    const message = error instanceof BillingError ? error.message : String(error);
    record("plan", false, message);
    // Put the year back, or it would renew early on the YEARLY price.
    const oldEnd = sub.currentPeriodEnd;
    const restored = oldEnd ? await setEnd(sub.id, oldEnd).then(() => true, () => false) : false;
    return fail(
      `Plan change failed: ${message}. Nothing was refunded. ${
        restored
          ? "The yearly period end was put back."
          : `PUT THE PERIOD END BACK BY HAND in ${provider.label}: it was ${oldEnd ?? "unknown"}, it is now ${quote.paidThrough}.`
      }`,
      502,
    );
  }

  // ── 3. The rest of the year back on the card ────────────────────────────
  try {
    await provider.createRefund({
      orderId: order.id,
      amount: refund,
      reason: provider.capabilities.refundReasons[0]?.value ?? "customer_request",
      comment: `Yearly to monthly: ${quote.monthsUsed} month(s) kept at ${formatMoney(target.amount, target.currency)}`,
      revokeBenefits: false,
    });
    record(
      "refund",
      true,
      `${formatMoney(refund, order.currency)} refunded (paid ${formatMoney(order.totalAmount, order.currency)}, kept ${formatMoney(quote.kept, order.currency)}${
        refund < quote.difference ? ", capped at what was left refundable" : ""
      }).`,
    );
  } catch (error) {
    record(
      "refund",
      false,
      `${error instanceof BillingError ? error.message : String(error)} — the plan change WAS made, so refund ${formatMoney(refund, order.currency)} by hand.`,
    );
  }
  return null;
}

/** Cap their credits at what the new plan grants. */
async function capCredits(
  project: NonNullable<ReturnType<typeof getProject>>,
  body: Body,
  record: RecordStep,
): Promise<void> {
  if (project.databaseUrl && body.email && typeof body.newPlanCredits === "number") {
    try {
      const url = project.databaseUrl;
      const user = await findUserByEmail(url, body.email!);

      if (!user) {
        record("database", false, "No matching user in the database.");
      } else {
        // Someone holding 40,000 Ultra credits drops to the Pro ceiling;
        // someone with 5,000 left keeps their 5,000.
        const capped = Math.min(user.credits, body.newPlanCredits);
        // Columns every product's schema has; the optional ones are only
        // touched when the request gives a value.
        await withDbRetry(() =>
          q(
            url,
            `UPDATE "user" SET credits = $2, "productId" = $3,
                    "subscriptionPlan" = COALESCE($4, "subscriptionPlan"),
                    "maxWordsPerRequest" = COALESCE($5, "maxWordsPerRequest")
              WHERE id = $1`,
            [
              user.id,
              capped,
              body.newProductId ?? null,
              body.newPlanName ? body.newPlanName.toLowerCase() : null,
              typeof body.newMaxWords === "number" ? body.newMaxWords : null,
            ],
          ),
        );
        record(
          "database",
          true,
          capped < user.credits
            ? `Credits capped from ${user.credits.toLocaleString()} to ${capped.toLocaleString()}.`
            : `Credits left at ${capped.toLocaleString()} (already under the new plan).`,
        );
      }
    } catch (error) {
      record("database", false, error instanceof Error ? error.message : String(error));
    }
  }
}
