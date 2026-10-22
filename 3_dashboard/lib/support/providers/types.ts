/**
 * One shape for billing data regardless of who processes the money. Polar and
 * LemonSqueezy disagree on almost everything — field names, money units, how a
 * cancellation behaves — so each adapter normalises into these types and the
 * rest of the dashboard never branches on provider again.
 *
 * All money is in minor units (cents), matching both providers' APIs.
 */

export type BillingCustomer = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string | null;
};

export type BillingSubscription = {
  id: string;
  status: string;
  amount: number | null;
  currency: string | null;
  interval: string | null;
  createdAt: string;
  startedAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  endsAt: string | null;
  productName: string | null;
};

export type BillingOrder = {
  id: string;
  status: string;
  isPaid: boolean;
  isPending: boolean;
  createdAt: string;
  totalAmount: number;
  refundedAmount: number;
  currency: string;
  productName: string | null;
  subscriptionId: string | null;
  /**
   * Whether this order can have its entitlement pulled back as part of the
   * refund. Polar allows it on one-time orders only; LemonSqueezy never does.
   */
  supportsBenefitRevocation: boolean;
};

/** A plan that a subscription can be moved onto. */
export type BillingProduct = {
  id: string;
  name: string;
  /** Minor units. */
  amount: number | null;
  currency: string;
  /** "month" | "year" | null for one-time products. */
  interval: string | null;
  archived: boolean;
};

export type BillingRefund = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  createdAt: string;
  orderId: string | null;
};

export type RefundInput = {
  orderId: string;
  /** Minor units. */
  amount: number;
  reason: string;
  comment?: string;
  revokeBenefits?: boolean;
};

export class BillingError extends Error {
  status: number;
  body: unknown;
  provider: string;

  constructor(message: string, status: number, body: unknown, provider: string) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.body = body;
    this.provider = provider;
  }
}

export type ProviderCapabilities = {
  /**
   * Refunds can be issued through the API at all. Freemius exposes no refund
   * endpoint — refunds there are Developer-Dashboard-only — so the UI sends you
   * there instead of offering a button that cannot work.
   */
  refundsViaApi: boolean;
  /** Where to go when refundsViaApi is false. */
  refundConsoleUrl?: string;
  /**
   * A subscription can be moved to a different plan through the API.
   * Freemius cannot, so its downgrade dialog only guides.
   */
  planChanges: boolean;
  /** Cancel can revoke access immediately, not just at period end. */
  immediateCancellation: boolean;
  /** Cancelling is ALWAYS immediate — there is no period-end option. */
  cancellationAlwaysImmediate?: boolean;
  /** Refunds can be issued for less than the order total. */
  partialRefunds: boolean;
  /** A refund can carry a machine-readable reason. */
  refundReasons: { value: string; label: string }[];
  /** Shown in the cancel dialog to explain what actually happens. */
  cancellationNote: string;
};

export interface BillingProvider {
  kind: "polar" | "lemonsqueezy" | "freemius";
  label: string;
  capabilities: ProviderCapabilities;

  findCustomer(params: { email: string; customerId?: string | null }): Promise<BillingCustomer | null>;
  listSubscriptions(customer: BillingCustomer): Promise<BillingSubscription[]>;
  listOrders(customer: BillingCustomer): Promise<BillingOrder[]>;
  listRefunds(customer: BillingCustomer): Promise<BillingRefund[]>;
  getOrder(orderId: string): Promise<BillingOrder>;
  /** Plans available to move a subscription onto. */
  listProducts(): Promise<BillingProduct[]>;
  /**
   * Move a subscription onto another plan. Implementations must NOT let the
   * provider issue its own proration credit — the dashboard refunds the
   * difference to the card itself, and both would double-compensate.
   */
  changePlan(
    subscriptionId: string,
    productId: string,
    opts?: { resume?: boolean },
  ): Promise<BillingSubscription>;
  createRefund(input: RefundInput): Promise<BillingRefund>;
  cancelSubscription(subscriptionId: string, atPeriodEnd: boolean): Promise<BillingSubscription>;
}
