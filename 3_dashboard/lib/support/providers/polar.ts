import type { Project } from "../projects";
import {
  BillingError,
  type BillingCustomer,
  type BillingOrder,
  type BillingProvider,
  type BillingRefund,
  type BillingSubscription,
  type ProviderCapabilities,
  type RefundInput,
} from "./types";

type Paginated<T> = { items: T[]; pagination?: { total_count: number } };

type RawCustomer = {
  id: string;
  email: string;
  name: string | null;
  external_id: string | null;
  created_at: string;
};

type RawSubscription = {
  id: string;
  status: string;
  amount: number | null;
  currency: string | null;
  recurring_interval: string | null;
  created_at: string;
  started_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  ends_at: string | null;
  product?: { id: string; name: string } | null;
};

type RawOrder = {
  id: string;
  status: string;
  paid?: boolean;
  created_at: string;
  total_amount: number;
  refunded_amount?: number;
  currency: string;
  subscription_id: string | null;
  product?: { id: string; name: string } | null;
};

type RawProduct = {
  id: string;
  name: string;
  is_archived?: boolean;
  recurring_interval?: string | null;
  prices?: { price_amount?: number | null; price_currency?: string | null; is_archived?: boolean; recurring_interval?: string | null }[];
};

type RawRefund = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  reason: string;
  created_at: string;
  order_id: string;
};

const CAPABILITIES: ProviderCapabilities = {
  refundsViaApi: true,
  planChanges: true,
  immediateCancellation: true,
  partialRefunds: true,
  refundReasons: [
    { value: "customer_request", label: "Customer request" },
    { value: "satisfaction_guarantee", label: "Satisfaction guarantee" },
    { value: "service_disruption", label: "Service disruption" },
    { value: "duplicate", label: "Duplicate charge" },
    { value: "fraudulent", label: "Fraudulent" },
    { value: "other", label: "Other" },
  ],
  cancellationNote:
    "Polar can either stop billing at the end of the paid period or revoke access immediately.",
};

export function createPolarProvider(project: Project): BillingProvider {
  if (!project.polar) {
    throw new Error(`${project.label} has no POLAR_ACCESS_TOKEN configured.`);
  }
  const { token, server, organizationId } = project.polar;
  const base = server === "sandbox" ? "https://sandbox-api.polar.sh/v1" : "https://api.polar.sh/v1";

  async function call<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }
    // Only meaningful on list endpoints, and only when the token isn't already
    // scoped to a single organization.
    const isList = path.split("/").filter(Boolean).length === 1;
    if (organizationId && isList && init.method !== "POST") {
      url.searchParams.set("organization_id", organizationId);
    }

    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
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

    if (!response.ok) throw new BillingError(describe(response.status, body), response.status, body, "polar");
    return body as T;
  }

  function describe(status: number, body: unknown): string {
    const detail = (body as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const first = detail[0] as { msg?: string; loc?: string[] } | undefined;
      if (first?.msg) return `${first.loc?.join(".") ?? "request"}: ${first.msg}`;
    }
    if (status === 401) return `Polar rejected the token for ${project.label} (401).`;
    if (status === 403) return `The Polar token for ${project.label} is missing a scope (403).`;
    if (status === 404) return "Not found in Polar (404).";
    return `Polar API error ${status}`;
  }

  const toOrder = (raw: RawOrder): BillingOrder => ({
    id: raw.id,
    status: raw.status,
    isPaid: raw.status === "paid" || raw.paid === true,
    isPending: raw.status === "pending",
    createdAt: raw.created_at,
    totalAmount: raw.total_amount,
    refundedAmount: raw.refunded_amount ?? 0,
    currency: raw.currency,
    productName: raw.product?.name ?? null,
    subscriptionId: raw.subscription_id,
    // Polar rejects revoke_benefits on subscription orders — entitlements there
    // are released by cancelling the subscription instead.
    supportsBenefitRevocation: !raw.subscription_id,
  });

  const toSubscription = (raw: RawSubscription): BillingSubscription => ({
    id: raw.id,
    status: raw.status,
    amount: raw.amount,
    currency: raw.currency,
    interval: raw.recurring_interval,
    createdAt: raw.created_at,
    startedAt: raw.started_at,
    currentPeriodEnd: raw.current_period_end,
    cancelAtPeriodEnd: raw.cancel_at_period_end,
    endsAt: raw.ends_at,
    productName: raw.product?.name ?? null,
  });

  return {
    kind: "polar",
    label: "Polar",
    capabilities: CAPABILITIES,

    async findCustomer({ email, customerId }) {
      if (customerId) {
        try {
          const raw = await call<RawCustomer>(`/customers/${customerId}`);
          return { id: raw.id, email: raw.email, name: raw.name, createdAt: raw.created_at };
        } catch (error) {
          if (!(error instanceof BillingError && error.status === 404)) throw error;
        }
      }

      const normalized = email.trim().toLowerCase();
      if (!normalized) return null;

      const byEmail = await call<Paginated<RawCustomer>>("/customers", {
        query: { email: normalized, limit: "10" },
      });
      const exact = byEmail.items?.find((c) => c.email?.toLowerCase() === normalized);
      const fallback =
        exact ??
        (
          await call<Paginated<RawCustomer>>("/customers", {
            query: { query: normalized, limit: "10" },
          })
        ).items?.find((c) => c.email?.toLowerCase() === normalized);

      return fallback
        ? { id: fallback.id, email: fallback.email, name: fallback.name, createdAt: fallback.created_at }
        : null;
    },

    async listSubscriptions(customer) {
      const data = await call<Paginated<RawSubscription>>("/subscriptions", {
        query: { customer_id: customer.id, limit: "50" },
      });
      return (data.items ?? [])
        .map(toSubscription)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    },

    async listOrders(customer) {
      const data = await call<Paginated<RawOrder>>("/orders", {
        query: { customer_id: customer.id, limit: "100" },
      });
      return (data.items ?? [])
        .map(toOrder)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    },

    async listRefunds(customer) {
      const data = await call<Paginated<RawRefund>>("/refunds", {
        query: { customer_id: customer.id, limit: "100" },
      });
      return (data.items ?? []).map((raw) => ({
        id: raw.id,
        amount: raw.amount,
        currency: raw.currency,
        status: raw.status,
        reason: raw.reason,
        createdAt: raw.created_at,
        orderId: raw.order_id,
      }));
    },

    async getOrder(orderId) {
      return toOrder(await call<RawOrder>(`/orders/${orderId}`));
    },

    async listProducts() {
      const data = await call<Paginated<RawProduct>>("/products", { query: { limit: "100" } });
      return (data.items ?? []).map((p) => {
        const price = p.prices?.find((x) => !x.is_archived) ?? p.prices?.[0];
        return {
          id: p.id,
          name: p.name,
          amount: price?.price_amount ?? null,
          currency: (price?.price_currency ?? "usd").toLowerCase(),
          interval: p.recurring_interval ?? price?.recurring_interval ?? null,
          archived: Boolean(p.is_archived),
        };
      });
    },

    async changePlan(subscriptionId, productId, opts) {
      // Two separate calls, both required by Polar:
      //
      // 1. A plan change is rejected outright on a subscription scheduled to
      //    cancel ("uncancel first"), and cancel_at_period_end cannot ride
      //    along in the same body — the update payloads are distinct shapes,
      //    so combining them fails validation with "Extra inputs are not
      //    permitted".
      if (opts?.resume) {
        await call<RawSubscription>(`/subscriptions/${subscriptionId}`, {
          method: "PATCH",
          body: JSON.stringify({ cancel_at_period_end: false }),
        });
      }

      // 2. next_period is the only proration behaviour that moves no money:
      //    the switch is scheduled for the next cycle and Polar issues no
      //    credit of its own. The real difference goes back on the card as a
      //    separate refund, so anything else would pay the customer twice.
      const raw = await call<RawSubscription>(`/subscriptions/${subscriptionId}`, {
        method: "PATCH",
        body: JSON.stringify({ product_id: productId, proration_behavior: "next_period" }),
      });
      return toSubscription(raw);
    },

    async createRefund(input) {
      const raw = await call<RawRefund>("/refunds", {
        method: "POST",
        body: JSON.stringify({
          order_id: input.orderId,
          amount: input.amount,
          reason: input.reason,
          comment: input.comment || undefined,
          revoke_benefits: input.revokeBenefits ?? false,
        }),
      });
      return {
        id: raw.id,
        amount: raw.amount,
        currency: raw.currency,
        status: raw.status,
        reason: raw.reason,
        createdAt: raw.created_at,
        orderId: raw.order_id,
      };
    },

    async cancelSubscription(subscriptionId, atPeriodEnd) {
      const raw = atPeriodEnd
        ? await call<RawSubscription>(`/subscriptions/${subscriptionId}`, {
            method: "PATCH",
            body: JSON.stringify({ cancel_at_period_end: true }),
          })
        : await call<RawSubscription>(`/subscriptions/${subscriptionId}`, { method: "DELETE" });
      return toSubscription(raw);
    },
  };
}
