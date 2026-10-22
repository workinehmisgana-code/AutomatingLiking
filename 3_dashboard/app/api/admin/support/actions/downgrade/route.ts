import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { findUserByEmail, q, withDbRetry } from "@/lib/support/db";
import { getProject } from "@/lib/support/projects";
import { BillingError, formatMoney, providerFor } from "@/lib/support/providers";

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

  // ── 3. Cap their credits at what the new plan grants ────────────────────
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

  return NextResponse.json({ ok: true, steps });
}
