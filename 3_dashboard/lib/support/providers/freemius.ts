import type { Project } from "../projects";
import {
  BillingError,
  type BillingOrder,
  type BillingProvider,
  type BillingRefund,
  type BillingSubscription,
  type ProviderCapabilities,
} from "./types";

/**
 * Freemius, product-scoped Bearer auth:
 *   Authorization: Bearer <API Bearer Authorization Token>
 * Token and product id both come from the Developer Dashboard under
 * product Settings → API & Keys.
 *
 * Three things differ from the other providers and are surfaced through
 * `capabilities` so the UI never offers something that cannot work:
 *
 *  1. There is NO refund endpoint. Freemius issues refunds from the Developer
 *     Dashboard only, so the refund dialog links there instead of acting.
 *  2. Cancelling is immediate and irreversible — no period-end option.
 *  3. A refund is recorded as a second payment row with a negative `gross` and
 *     `bound_payment_id` pointing at the original, rather than as a field on
 *     the payment being refunded.
 */

const BASE = "https://api.freemius.com/v1";

type RawUser = {
  id: number;
  email: string;
  first?: string | null;
  last?: string | null;
  created: string;
};

type RawPayment = {
  id: number;
  user_id: number;
  plan_id?: number | string | null;
  subscription_id?: number | string | null;
  /** Decimal string in major units, e.g. "5.99". Negative on a refund row. */
  gross: string | number;
  currency: string;
  created: string;
  /** Set on a refund row; points at the payment being refunded. */
  bound_payment_id?: number | string | null;
  is_refund?: boolean;
};

type RawSubscription = {
  id: number;
  user_id: number;
  plan_id?: number | string | null;
  total_gross?: string | number | null;
  currency: string;
  /** 1 = monthly, 12 = annual. */
  billing_cycle?: number | null;
  created: string;
  next_payment?: string | null;
  canceled_at?: string | null;
};

type RawPlan = { id: number | string; title?: string | null; name?: string | null };

const CAPABILITIES: ProviderCapabilities = {
  // Freemius has no refund API — the Developer Dashboard is the only route.
  refundsViaApi: false,
  refundConsoleUrl: "https://dashboard.freemius.com",
  // No documented plan-change endpoint; the dialog guides instead of acting.
  planChanges: false,
  immediateCancellation: true,
  cancellationAlwaysImmediate: true,
  partialRefunds: false,
  refundReasons: [],
  cancellationNote:
    "Freemius cancels immediately and irreversibly — there is no period-end option, and the customer loses access as soon as you confirm.",
};

/** Freemius returns decimals in major units; everything here is minor units. */
function toMinor(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function createFreemiusProvider(project: Project): BillingProvider {
  if (!project.freemius) {
    throw new Error(`${project.label} has no FREEMIUS_API_TOKEN / FREEMIUS_PRODUCT_ID configured.`);
  }
  const { token, productId } = project.freemius;

  async function call<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${BASE}/products/${productId}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });

    const raw = await response.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }

    if (!response.ok) {
      throw new BillingError(describe(response.status, body), response.status, body, "freemius");
    }
    return body as T;
  }

  function describe(status: number, body: unknown): string {
    const error = (body as { error?: { message?: string; code?: string } } | null)?.error;
    if (error?.message) return error.message;
    if (status === 401) return `Freemius rejected the token for ${project.label} (401).`;
    if (status === 403) return `The Freemius token for ${project.label} lacks access (403).`;
    if (status === 404) return "Not found in Freemius (404).";
    return `Freemius API error ${status}`;
  }

  /** plan id → human name, so orders and subscriptions read properly. */
  let planCache: Map<string, string> | null = null;
  async function planNames(): Promise<Map<string, string>> {
    if (planCache) return planCache;
    try {
      const data = await call<{ plans?: RawPlan[] }>("/plans.json", { query: { count: "50" } });
      planCache = new Map(
        (data.plans ?? []).map((p) => [String(p.id), p.title || p.name || `Plan ${p.id}`]),
      );
    } catch {
      planCache = new Map();
    }
    return planCache;
  }

  return {
    kind: "freemius",
    label: "Freemius",
    capabilities: CAPABILITIES,

    async findCustomer({ email }) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) return null;

      const data = await call<{ users?: RawUser[] }>("/users.json", {
        query: { email: normalized, count: "10" },
      });
      const match =
        (data.users ?? []).find((u) => u.email?.toLowerCase() === normalized) ?? data.users?.[0];
      if (!match) return null;

      const name = [match.first, match.last].filter(Boolean).join(" ").trim();
      return {
        id: String(match.id),
        email: match.email,
        name: name || null,
        createdAt: match.created ?? null,
      };
    },

    async listSubscriptions(customer) {
      const [data, plans] = await Promise.all([
        call<{ subscriptions?: RawSubscription[] }>(
          `/users/${customer.id}/subscriptions.json`,
          { query: { count: "50" } },
        ),
        planNames(),
      ]);

      return (data.subscriptions ?? [])
        .map<BillingSubscription>((s) => {
          const canceled = Boolean(s.canceled_at);
          return {
            id: String(s.id),
            // Freemius has no status string; it's derived from canceled_at.
            status: canceled ? "cancelled" : "active",
            amount: toMinor(s.total_gross),
            currency: (s.currency ?? "usd").toLowerCase(),
            interval: s.billing_cycle === 12 ? "year" : s.billing_cycle === 1 ? "month" : null,
            createdAt: s.created,
            startedAt: s.created,
            currentPeriodEnd: s.next_payment ?? null,
            // Cancellation is immediate, so a cancelled subscription is over —
            // there is no "still running until period end" state to report.
            cancelAtPeriodEnd: canceled,
            endsAt: s.canceled_at ?? null,
            productName: s.plan_id ? (plans.get(String(s.plan_id)) ?? null) : null,
          };
        })
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    },

    async listOrders(customer) {
      const [data, plans] = await Promise.all([
        call<{ payments?: RawPayment[] }>(`/users/${customer.id}/payments.json`, {
          query: { count: "100" },
        }),
        planNames(),
      ]);

      const rows = data.payments ?? [];

      // Refunds are their own rows; fold them back onto the payment they undo.
      const refundedByPayment = new Map<string, number>();
      for (const row of rows) {
        const amount = toMinor(row.gross);
        if (row.bound_payment_id && amount < 0) {
          refundedByPayment.set(
            String(row.bound_payment_id),
            (refundedByPayment.get(String(row.bound_payment_id)) ?? 0) + Math.abs(amount),
          );
        }
      }

      return rows
        .filter((row) => toMinor(row.gross) > 0 && !row.bound_payment_id)
        .map<BillingOrder>((row) => {
          const total = toMinor(row.gross);
          const refunded = Math.min(total, refundedByPayment.get(String(row.id)) ?? 0);
          return {
            id: String(row.id),
            status: refunded >= total ? "refunded" : refunded > 0 ? "partially_refunded" : "paid",
            isPaid: true, // Freemius only records completed payments
            isPending: false,
            createdAt: row.created,
            totalAmount: total,
            refundedAmount: refunded,
            currency: (row.currency ?? "usd").toLowerCase(),
            productName: row.plan_id ? (plans.get(String(row.plan_id)) ?? null) : null,
            subscriptionId: row.subscription_id ? String(row.subscription_id) : null,
            supportsBenefitRevocation: false,
          };
        })
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    },

    async listRefunds(customer) {
      const data = await call<{ payments?: RawPayment[] }>(
        `/users/${customer.id}/payments.json`,
        { query: { count: "100" } },
      );

      return (data.payments ?? [])
        .filter((row) => toMinor(row.gross) < 0 || row.is_refund)
        .map<BillingRefund>((row) => ({
          id: String(row.id),
          amount: Math.abs(toMinor(row.gross)),
          currency: (row.currency ?? "usd").toLowerCase(),
          status: "succeeded",
          reason: null,
          createdAt: row.created,
          orderId: row.bound_payment_id ? String(row.bound_payment_id) : null,
        }));
    },

    async getOrder(orderId) {
      const [data, plans] = await Promise.all([
        call<{ payment?: RawPayment }>(`/payments/${orderId}.json`),
        planNames(),
      ]);
      const row = data.payment;
      if (!row) throw new BillingError("Payment not found in Freemius", 404, data, "freemius");

      const total = toMinor(row.gross);
      return {
        id: String(row.id),
        status: "paid",
        isPaid: true,
        isPending: false,
        createdAt: row.created,
        totalAmount: total,
        // A single payment row doesn't carry its own refunds; the list view
        // computes that. Callers needing exactness should use listOrders.
        refundedAmount: 0,
        currency: (row.currency ?? "usd").toLowerCase(),
        productName: row.plan_id ? (plans.get(String(row.plan_id)) ?? null) : null,
        subscriptionId: row.subscription_id ? String(row.subscription_id) : null,
        supportsBenefitRevocation: false,
      };
    },

    async listProducts() {
      const plans = await planNames();
      return Array.from(plans.entries()).map(([id, name]) => ({
        id: String(id),
        name,
        amount: null,
        currency: "usd",
        interval: null,
        archived: false,
      }));
    },

    async changePlan() {
      throw new BillingError(
        "Freemius has no plan-change API. Move the customer to the new plan in the Freemius Developer Dashboard, then refund the difference there too.",
        501,
        null,
        "freemius",
      );
    },

    async createRefund() {
      throw new BillingError(
        "Freemius has no refund API. Refund this payment from the Freemius Developer Dashboard (Payments → find the payment → Refund), then mark the email answered here.",
        501,
        null,
        "freemius",
      );
    },

    async cancelSubscription(subscriptionId) {
      // Always immediate — Freemius offers no period-end cancellation.
      await call(`/subscriptions/${subscriptionId}.json`, { method: "DELETE" });

      const subs = await call<{ subscriptions?: RawSubscription[] }>("/subscriptions.json", {
        query: { count: "100" },
      }).catch(() => ({ subscriptions: [] as RawSubscription[] }));

      const updated = (subs.subscriptions ?? []).find((s) => String(s.id) === String(subscriptionId));

      return {
        id: String(subscriptionId),
        status: "cancelled",
        amount: toMinor(updated?.total_gross),
        currency: (updated?.currency ?? "usd").toLowerCase(),
        interval: updated?.billing_cycle === 12 ? "year" : updated?.billing_cycle === 1 ? "month" : null,
        createdAt: updated?.created ?? new Date().toISOString(),
        startedAt: updated?.created ?? null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: true,
        endsAt: updated?.canceled_at ?? new Date().toISOString(),
        productName: null,
      };
    },
  };
}
