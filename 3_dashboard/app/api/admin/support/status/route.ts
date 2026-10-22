import { supportGuard } from "@/lib/support/auth";
import { NextResponse } from "next/server";
import { getProject } from "@/lib/support/projects";
import { providerFor } from "@/lib/support/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * Whether a refund or cancellation request has actually been dealt with. The
 * inbox can't know this on its own — the answer lives in the billing provider,
 * so senders are resolved in batches and cached by the client.
 */
export type BillingStatus = {
  found: boolean;
  /** Minor units still refundable across all their paid orders. */
  refundable: number;
  currency: string;
  /** They paid at least once and none of it is refundable any more. */
  fullyRefunded: boolean;
  /** A subscription that is still billing. */
  activeSubscription: boolean;
  /** Already set to stop at the end of the period. */
  cancelScheduled: boolean;
  error?: string;
};

type Item = { projectId: string; email: string };

/** Run tasks with a small concurrency cap so five providers aren't hammered. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

const EMPTY: BillingStatus = {
  found: false,
  refundable: 0,
  currency: "usd",
  fullyRefunded: false,
  activeSubscription: false,
  cancelScheduled: false,
};

const ACTIVE = new Set(["active", "trialing", "on_trial", "past_due"]);

export async function POST(request: Request) {
  const denied = await supportGuard();
  if (denied) return denied;
  const body = (await request.json()) as { items?: Item[] };

  // One lookup per sender, not per email — people write more than once.
  const unique = new Map<string, Item>();
  for (const it of body.items ?? []) {
    const email = String(it?.email ?? "").trim().toLowerCase();
    const projectId = String(it?.projectId ?? "").trim();
    if (email && projectId) unique.set(`${projectId}:${email}`, { projectId, email });
  }

  const keys = Array.from(unique.keys()).slice(0, 120);

  const results = await pool(keys, 5, async (key) => {
    const { projectId, email } = unique.get(key)!;
    const project = getProject(projectId);
    const provider = project ? providerFor(project) : null;
    if (!provider) return [key, { ...EMPTY, error: "no billing credentials" }] as const;

    try {
      const customer = await provider.findCustomer({ email });
      if (!customer) return [key, { ...EMPTY }] as const;

      const [orders, subs] = await Promise.all([
        provider.listOrders(customer).catch(() => []),
        provider.listSubscriptions(customer).catch(() => []),
      ]);

      const paid = orders.filter((o) => o.isPaid);
      const refundable = paid.reduce(
        (sum, o) => sum + Math.max(0, o.totalAmount - o.refundedAmount),
        0,
      );
      const active = subs.find((s) => ACTIVE.has(s.status)) ?? null;

      return [
        key,
        {
          found: true,
          refundable,
          currency: orders[0]?.currency ?? "usd",
          fullyRefunded: paid.length > 0 && refundable === 0,
          activeSubscription: Boolean(active),
          cancelScheduled: Boolean(active?.cancelAtPeriodEnd) || subs.some((s) => s.cancelAtPeriodEnd),
        } satisfies BillingStatus,
      ] as const;
    } catch (error) {
      return [
        key,
        { ...EMPTY, error: error instanceof Error ? error.message : String(error) },
      ] as const;
    }
  });

  return NextResponse.json({ statuses: Object.fromEntries(results) });
}
