"use client";

import {
  AlertTriangle,
  Ban,
  Database,
  RotateCcw,
  Search,
  TrendingDown,
  Trash2,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { BillingOrder, BillingSubscription, CustomerProfile } from "@/lib/support/types";
import {
  cx,
  ErrorNote,
  formatDate,
  money,
  ProjectBadge,
  Row,
  SectionTitle,
  Spinner,
  StatusBadge,
} from "./ui";

export default function CustomerPanel({
  profile,
  loading,
  error,
  lookupEmail,
  onLookup,
  onRefund,
  onCancel,
  onDowngrade,
  onDelete,
}: {
  profile: CustomerProfile | null;
  loading: boolean;
  error: string | null;
  lookupEmail: string | null;
  onLookup: (email: string) => void;
  onRefund: (order: BillingOrder) => void;
  onCancel: (subscription: BillingSubscription) => void;
  onDowngrade: (subscription: BillingSubscription) => void;
  onDelete: () => void;
}) {
  const [search, setSearch] = useState(lookupEmail ?? "");

  useEffect(() => {
    setSearch(lookupEmail ?? "");
  }, [lookupEmail]);

  const neon = profile?.neon ?? null;
  const billing = profile?.billing ?? null;
  const project = profile?.project ?? null;
  const refundableOrders =
    billing?.orders.filter((order) => order.isPaid && order.totalAmount - order.refundedAmount > 0) ??
    [];

  return (
    <aside className="flex h-full w-[430px] shrink-0 flex-col border-l border-ink-800 bg-ink-900">
      <div className="shrink-0 space-y-2 border-b border-ink-800 px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (search.trim()) onLookup(search.trim().toLowerCase());
          }}
          className="relative"
        >
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Look up a customer by email"
            className="field !py-1.5 !pl-8 !pr-16 text-xs"
          />
          <button
            type="submit"
            disabled={loading || !search.trim()}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-ink-700 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-ink-600 disabled:opacity-40"
          >
            {loading ? <Spinner /> : "Look up"}
          </button>
        </form>

        {project && (
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <ProjectBadge label={project.label} tag={project.tag} />
            <span>
              searched in{" "}
              <span className="text-slate-300">{project.providerLabel}</span>
              {project.databaseReady ? " + database" : ""}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        {profile?.errors.map((entry) => (
          <ErrorNote key={entry.source}>
            <strong className="uppercase">{entry.source}</strong>: {entry.message}
          </ErrorNote>
        ))}

        {!profile && !loading && !error && (
          <p className="py-10 text-center text-xs text-slate-600">
            Open an email, or search an address, to pull their billing and account records.
          </p>
        )}

        {loading && !profile && (
          <p className="flex items-center justify-center gap-2 py-10 text-xs text-slate-500">
            <Spinner /> Checking {project?.providerLabel ?? "billing"}…
          </p>
        )}

        {profile && !billing && !neon && profile.errors.length === 0 && (
          <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-3 text-xs text-amber-300">
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <AlertTriangle size={13} /> No account found
            </div>
            <p className="leading-relaxed text-amber-300/80">
              <span className="font-mono">{profile.lookupEmail}</span> is not in{" "}
              {profile.project.providerLabel} or the {profile.project.label} database. They may have
              written from a different address than the one they signed up with — check the
              addresses mentioned in the email body.
            </p>
          </div>
        )}

        {/* ─── Billing ───────────────────────────────────────────── */}
        {billing && project && (
          <section className="card p-3">
            <SectionTitle
              right={<StatusBadge status={billing.activeSubscription?.status ?? "no subscription"} />}
            >
              <span className="inline-flex items-center gap-1.5">
                <Wallet size={12} /> {project.providerLabel}
              </span>
            </SectionTitle>

            <Row label="Customer">{billing.customer.name || "—"}</Row>
            <Row label="Email">
              <span className="font-mono text-xs">{billing.customer.email}</span>
            </Row>
            <Row label="Customer since">{formatDate(billing.customer.createdAt)}</Row>
            <Row label="Subscribed on">
              {billing.subscribedAt ? formatDate(billing.subscribedAt) : "never subscribed"}
            </Row>

            {billing.activeSubscription && (
              <>
                <div className="my-2 border-t border-ink-800" />
                <Row label="Plan">{billing.activeSubscription.productName ?? "—"}</Row>
                {billing.activeSubscription.amount !== null && (
                  <Row label="Amount">
                    {money(
                      billing.activeSubscription.amount,
                      billing.activeSubscription.currency ?? "usd",
                    )}
                    {billing.activeSubscription.interval
                      ? ` / ${billing.activeSubscription.interval}`
                      : ""}
                  </Row>
                )}
                <Row label="Renews / ends">
                  {formatDate(billing.activeSubscription.currentPeriodEnd)}
                </Row>
                {billing.activeSubscription.cancelAtPeriodEnd && (
                  <p className="mt-1 rounded bg-amber-950/40 px-2 py-1 text-[11px] text-amber-300">
                    Already cancelled — access runs to{" "}
                    {formatDate(
                      billing.activeSubscription.endsAt ??
                        billing.activeSubscription.currentPeriodEnd,
                    )}
                    .
                  </p>
                )}
              </>
            )}

            <div className="my-2 border-t border-ink-800" />
            <SectionTitle>Last payment</SectionTitle>
            {billing.lastPayment ? (
              <>
                <Row label="Date">{formatDate(billing.lastPayment.date, true)}</Row>
                <Row label="Amount">
                  {money(billing.lastPayment.amount, billing.lastPayment.currency)}
                </Row>
                <Row label="Status">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusBadge status={billing.lastPayment.status} />
                    {billing.lastPayment.isPaid && (
                      <span className="text-[11px] text-emerald-400">money received</span>
                    )}
                    {billing.lastPayment.isPending && (
                      <span className="text-[11px] text-amber-400">not settled yet</span>
                    )}
                  </span>
                </Row>
                {billing.lastPayment.refundedAmount > 0 && (
                  <Row label="Already refunded">
                    {money(billing.lastPayment.refundedAmount, billing.lastPayment.currency)}
                  </Row>
                )}
                {billing.lastPayment.isPending && (
                  <p className="mt-2 rounded bg-amber-950/40 px-2 py-1.5 text-[11px] leading-relaxed text-amber-300">
                    This charge has not settled. {project.providerLabel} can only refund a paid
                    order — wait for it to flip to <span className="font-semibold">paid</span>, or
                    cancel the subscription instead.
                  </p>
                )}
              </>
            ) : (
              <p className="py-2 text-xs text-slate-600">No orders on this customer.</p>
            )}

            <div className="my-2 border-t border-ink-800" />
            <SectionTitle
              right={
                <span className="text-[10px] text-slate-600">
                  {money(billing.totals.paid, billing.totals.currency)} paid
                  {billing.totals.refunded > 0 &&
                    ` · ${money(billing.totals.refunded, billing.totals.currency)} refunded`}
                </span>
              }
            >
              Payment history ({billing.orders.length})
            </SectionTitle>

            <div className="space-y-1">
              {billing.orders.map((order) => {
                const remaining = order.totalAmount - order.refundedAmount;
                const canRefund = order.isPaid && remaining > 0;
                return (
                  <div
                    key={order.id}
                    className="flex items-center justify-between gap-2 rounded-lg bg-ink-850 px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-slate-200">
                          {money(order.totalAmount, order.currency)}
                        </span>
                        <StatusBadge status={order.status} />
                      </div>
                      <p className="truncate text-[10px] text-slate-500">
                        {formatDate(order.createdAt)}
                        {order.productName ? ` · ${order.productName}` : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => onRefund(order)}
                      disabled={!canRefund}
                      className="btn btn-warn shrink-0 !px-2 !py-1 !text-[11px]"
                      title={canRefund ? "Refund this order" : "Nothing left to refund"}
                    >
                      <RotateCcw size={11} /> Refund
                    </button>
                  </div>
                );
              })}
              {billing.orders.length === 0 && (
                <p className="py-2 text-xs text-slate-600">No payment history.</p>
              )}
            </div>

            {billing.refunds.length > 0 && (
              <>
                <div className="my-2 border-t border-ink-800" />
                <SectionTitle>Refunds issued ({billing.refunds.length})</SectionTitle>
                <div className="space-y-1">
                  {billing.refunds.map((refund) => (
                    <div
                      key={refund.id}
                      className="flex items-center justify-between rounded-lg bg-ink-850 px-2.5 py-1.5"
                    >
                      <span className="text-xs text-slate-300">
                        {money(refund.amount, refund.currency)}
                      </span>
                      <span className="flex items-center gap-2 text-[10px] text-slate-500">
                        {formatDate(refund.createdAt)}
                        <StatusBadge status={refund.status} />
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* ─── Account database ──────────────────────────────────── */}
        {neon && (
          <section className="card p-3">
            <SectionTitle right={<span className="text-[10px] text-slate-600">{neon.id}</span>}>
              <span className="inline-flex items-center gap-1.5">
                <Database size={12} /> {project?.label} account
              </span>
            </SectionTitle>

            <Row label="Name">{neon.name}</Row>
            <Row label="Signed up">{formatDate(neon.createdAt)}</Row>
            <Row label="Plan on file">
              {neon.subscriptionPlan ?? "free"}
              {neon.subscriptionType ? ` · ${neon.subscriptionType}` : ""}
            </Row>
            <Row label="Credits reset">{formatDate(neon.nextResetDate)}</Row>

            <div className="my-2.5 border-t border-ink-800" />
            <SectionTitle>Credit usage</SectionTitle>

            {neon.creditsAllocated !== null && neon.creditsUsed !== null ? (
              <>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-lg font-semibold text-slate-100">
                    {neon.creditsUsed.toLocaleString()}
                  </span>
                  <span className="text-xs text-slate-500">
                    of {neon.creditsAllocated.toLocaleString()} used
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
                  <div
                    className={cx(
                      "h-full rounded-full transition-all",
                      neon.creditsUsed / neon.creditsAllocated > 0.5 ? "bg-amber-500" : "bg-accent",
                    )}
                    style={{
                      width: `${Math.min(100, (neon.creditsUsed / neon.creditsAllocated) * 100)}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-[10px] text-slate-600">
                  Resets each billing period — see runs since payment below for the real signal.
                </p>
              </>
            ) : (
              <p className="text-[11px] leading-relaxed text-slate-500">
                Allocation unknown. Add a line to <code>.env</code> to compute credits used:
                <code className="mt-1 block break-all text-slate-400">
                  {project?.id.toUpperCase()}_CREDITS_20000_LABEL={neon.productId ?? "<productId>"}
                </code>
              </p>
            )}

            <div className="mt-2.5">
              <Row label="Credits remaining">{neon.creditsRemaining.toLocaleString()}</Row>
              {neon.extraCredits > 0 && (
                <Row label="Top-up credits">{neon.extraCredits.toLocaleString()}</Row>
              )}
              <Row label="Runs total">{neon.usage.totalRuns.toLocaleString()}</Row>
              <Row label="Words processed">{neon.usage.totalWords.toLocaleString()}</Row>
              {neon.usage.runsSinceLastPayment !== null && (
                <Row label="Runs since payment">
                  {neon.usage.runsSinceLastPayment.toLocaleString()}
                  <span className="ml-1 text-[11px] font-normal text-slate-500">
                    ({(neon.usage.wordsSinceLastPayment ?? 0).toLocaleString()} words)
                  </span>
                </Row>
              )}
              <Row label="Last run">{formatDate(neon.usage.lastRunAt, true)}</Row>
            </div>

            {(neon.usage.runsSinceLastPayment ?? 0) > 0 && (
              <p className="mt-2 rounded bg-ink-850 px-2 py-1.5 text-[11px] leading-relaxed text-slate-400">
                They have used the service{" "}
                <span className="font-semibold text-slate-200">
                  {neon.usage.runsSinceLastPayment} times
                </span>{" "}
                since paying. Worth weighing before a full refund.
              </p>
            )}
          </section>
        )}

        {project && !project.databaseReady && billing && (
          <p className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
            No database configured for {project.label}, so credit usage can&apos;t be shown. Set{" "}
            <code>{project.id.toUpperCase()}_DATABASE_URL</code> in <code>.env</code> to enable it.
          </p>
        )}

        {/* ─── Actions ───────────────────────────────────────────── */}
        {(billing || neon) && (
          <section className="card p-3">
            <SectionTitle>Actions</SectionTitle>
            <div className="space-y-2">
              {refundableOrders[0] && (
                <button onClick={() => onRefund(refundableOrders[0]!)} className="btn btn-warn w-full">
                  <RotateCcw size={13} />
                  Refund last payment (
                  {money(refundableOrders[0].totalAmount, refundableOrders[0].currency)})
                </button>
              )}

              {/* Shown even when a cancellation is already scheduled — offering a
                  cheaper plan is exactly the save you want at that moment. */}
              {billing?.activeSubscription && (
                <button
                  onClick={() => onDowngrade(billing.activeSubscription!)}
                  className="btn btn-warn w-full"
                  title="Move them to a cheaper plan and refund the price difference"
                >
                  <TrendingDown size={13} />
                  {billing.activeSubscription.cancelAtPeriodEnd
                    ? "Downgrade instead of cancelling"
                    : "Downgrade & refund difference"}
                </button>
              )}

              {billing?.activeSubscription && !billing.activeSubscription.cancelAtPeriodEnd && (
                <button
                  onClick={() => onCancel(billing.activeSubscription!)}
                  className="btn btn-ghost w-full"
                >
                  <Ban size={13} /> Cancel subscription
                </button>
              )}

              {neon && (
                <button onClick={onDelete} className="btn btn-danger w-full">
                  <Trash2 size={13} /> Archive &amp; delete from database
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
