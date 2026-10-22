import type { Project } from "../projects";
import {
  BillingError,
  type BillingCustomer,
  type BillingOrder,
  type BillingProvider,
  type BillingRefund,
  type BillingSubscription,
  type ProviderCapabilities,
} from "./types";

/**
 * LemonSqueezy speaks JSON:API, so every record is {id, attributes}. Money is
 * already in cents, which matches our normalised types.
 *
 * Two behaviours differ from Polar and are surfaced through `capabilities`:
 *  - Cancelling always leaves a grace period until `ends_at`; there is no
 *    immediate revoke, so the cancel dialog hides that option.
 *  - Refunds carry no machine-readable reason, so the reason select is hidden
 *    and the note is kept locally in the action log instead.
 */

const BASE = "https://api.lemonsqueezy.com/v1";

type Resource<A> = { id: string; type: string; attributes: A };
type Collection<A> = { data: Resource<A>[] };
type Single<A> = { data: Resource<A> };

type CustomerAttrs = {
  name: string | null;
  email: string;
  status: string;
  created_at: string;
};

type OrderAttrs = {
  identifier: string;
  order_number: number;
  user_name: string | null;
  user_email: string;
  currency: string;
  total: number;
  status: string; // pending | failed | paid | refunded
  refunded: boolean;
  refunded_amount?: number;
  refunded_at: string | null;
  created_at: string;
  first_order_item?: { product_name?: string; variant_name?: string } | null;
};

type SubscriptionAttrs = {
  status: string; // on_trial | active | paused | past_due | unpaid | cancelled | expired
  status_formatted: string;
  product_name: string | null;
  variant_name: string | null;
  user_email: string;
  cancelled: boolean;
  created_at: string;
  renews_at: string | null;
  ends_at: string | null;
  trial_ends_at: string | null;
  first_subscription_item?: { price_id?: number } | null;
};

const CAPABILITIES: ProviderCapabilities = {
  refundsViaApi: true,
  planChanges: true,
  // DELETE /subscriptions/{id} always leaves a grace period until ends_at.
  immediateCancellation: false,
  partialRefunds: true,
  refundReasons: [],
  cancellationNote:
    "LemonSqueezy always leaves a grace period: billing stops now, and access continues until the current period ends. There is no immediate revoke.",
};

export function createLemonSqueezyProvider(project: Project): BillingProvider {
  if (!project.lemon) {
    throw new Error(`${project.label} has no LEMONSQUEEZY_API_KEY configured.`);
  }
  const { apiKey, storeId } = project.lemon;

  async function call<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${apiKey}`,
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
      throw new BillingError(describe(response.status, body), response.status, body, "lemonsqueezy");
    }
    return body as T;
  }

  function describe(status: number, body: unknown): string {
    const errors = (body as { errors?: { detail?: string; title?: string }[] } | null)?.errors;
    const first = errors?.[0];
    if (first?.detail) return first.detail;
    if (first?.title) return first.title;
    if (status === 401) return `LemonSqueezy rejected the API key for ${project.label} (401).`;
    if (status === 404) return "Not found in LemonSqueezy (404).";
    return `LemonSqueezy API error ${status}`;
  }

  const productNameOf = (attrs: OrderAttrs): string | null => {
    const item = attrs.first_order_item;
    if (!item) return null;
    return [item.product_name, item.variant_name].filter(Boolean).join(" · ") || null;
  };

  function toOrder(resource: Resource<OrderAttrs>): BillingOrder {
    const a = resource.attributes;
    // The API exposes `refunded` as a boolean; only a full refund is possible
    // to detect reliably, so treat a refunded order as fully returned unless a
    // partial amount is reported.
    const refundedAmount = a.refunded_amount ?? (a.refunded ? a.total : 0);
    return {
      id: resource.id,
      status: a.status,
      isPaid: a.status === "paid",
      isPending: a.status === "pending",
      createdAt: a.created_at,
      totalAmount: a.total,
      refundedAmount,
      currency: a.currency?.toLowerCase() ?? "usd",
      productName: productNameOf(a),
      // LemonSqueezy orders don't link back to a subscription in this payload.
      subscriptionId: null,
      supportsBenefitRevocation: false,
    };
  }

  function toSubscription(resource: Resource<SubscriptionAttrs>): BillingSubscription {
    const a = resource.attributes;
    return {
      id: resource.id,
      status: a.status,
      amount: null, // not present on the subscription payload
      currency: null,
      interval: null,
      createdAt: a.created_at,
      startedAt: a.created_at,
      currentPeriodEnd: a.renews_at ?? a.ends_at,
      cancelAtPeriodEnd: Boolean(a.cancelled),
      endsAt: a.ends_at,
      productName: [a.product_name, a.variant_name].filter(Boolean).join(" · ") || null,
    };
  }

  return {
    kind: "lemonsqueezy",
    label: "LemonSqueezy",
    capabilities: CAPABILITIES,

    async findCustomer({ email }) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) return null;

      const data = await call<Collection<CustomerAttrs>>("/customers", {
        query: {
          "filter[email]": normalized,
          ...(storeId ? { "filter[store_id]": storeId } : {}),
        },
      });

      const match =
        data.data?.find((c) => c.attributes.email?.toLowerCase() === normalized) ?? data.data?.[0];
      if (!match) return null;

      return {
        id: match.id,
        email: match.attributes.email,
        name: match.attributes.name,
        createdAt: match.attributes.created_at,
      };
    },

    async listSubscriptions(customer) {
      const data = await call<Collection<SubscriptionAttrs>>("/subscriptions", {
        query: {
          "filter[user_email]": customer.email,
          ...(storeId ? { "filter[store_id]": storeId } : {}),
        },
      });
      return (data.data ?? [])
        .map(toSubscription)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    },

    async listOrders(customer) {
      const data = await call<Collection<OrderAttrs>>("/orders", {
        query: {
          "filter[user_email]": customer.email,
          ...(storeId ? { "filter[store_id]": storeId } : {}),
        },
      });
      return (data.data ?? [])
        .map(toOrder)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    },

    async listRefunds(customer) {
      // No refunds collection exists; reconstruct from the orders themselves.
      const orders = await this.listOrders(customer);
      return orders
        .filter((order) => order.refundedAmount > 0)
        .map((order): BillingRefund => ({
          id: `order-${order.id}`,
          amount: order.refundedAmount,
          currency: order.currency,
          status: "succeeded",
          reason: null,
          createdAt: order.createdAt,
          orderId: order.id,
        }));
    },

    async listProducts() {
      const products = await call<Collection<{ name: string }>>("/products", {
        query: { "page[size]": "100", ...(storeId ? { "filter[store_id]": storeId } : {}) },
      });
      const names = new Map((products.data ?? []).map((p) => [String(p.id), p.attributes?.name ?? ""]));

      const variants = await call<
        Collection<{ name: string; price: number; product_id: number; interval?: string | null; status?: string }>
      >("/variants", { query: { "page[size]": "100" } });

      return (variants.data ?? [])
        .filter((v) => names.has(String(v.attributes?.product_id)))
        .map((v) => {
          const a = v.attributes;
          return {
            id: String(v.id),
            name: [names.get(String(a.product_id)), a.name].filter(Boolean).join(" / "),
            amount: a.price ?? null,
            currency: "usd",
            interval: a.interval ?? null,
            archived: a.status === "draft",
          };
        });
    },

    async changePlan(subscriptionId, productId, opts) {
      // disable_prorations stops LemonSqueezy issuing its own credit; the
      // dashboard refunds the difference to the card instead.
      const data = await call<Single<SubscriptionAttrs>>(`/subscriptions/${subscriptionId}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "subscriptions",
            id: String(subscriptionId),
            attributes: {
              variant_id: Number(productId),
              disable_prorations: true,
              ...(opts?.resume ? { cancelled: false } : {}),
            },
          },
        }),
      });
      return toSubscription(data.data);
    },

    async getOrder(orderId) {
      const data = await call<Single<OrderAttrs>>(`/orders/${orderId}`);
      return toOrder(data.data);
    },

    async createRefund(input) {
      const order = await this.getOrder(input.orderId);
      const full = input.amount >= order.totalAmount - order.refundedAmount;

      const data = await call<Single<OrderAttrs>>(`/orders/${input.orderId}/refund`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "orders",
            id: String(input.orderId),
            // Omitting `amount` refunds the order in full.
            attributes: full ? {} : { amount: Math.round(input.amount) },
          },
        }),
      });

      const updated = toOrder(data.data);
      return {
        id: `order-${updated.id}`,
        amount: input.amount,
        currency: updated.currency,
        status: updated.refundedAmount > 0 ? "succeeded" : "pending",
        reason: input.reason || null,
        createdAt: new Date().toISOString(),
        orderId: updated.id,
      };
    },

    async cancelSubscription(subscriptionId) {
      // Always a grace period — `atPeriodEnd` is ignored by design, and the UI
      // hides the immediate option for this provider.
      const data = await call<Single<SubscriptionAttrs>>(`/subscriptions/${subscriptionId}`, {
        method: "DELETE",
      });
      return toSubscription(data.data);
    },
  };
}
