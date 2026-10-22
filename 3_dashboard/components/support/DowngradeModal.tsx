"use client";

import { AlertTriangle, ArrowDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DowngradeTarget } from "@/app/api/admin/support/products/route";
import type { BillingOrder, BillingSubscription, CustomerProfile } from "@/lib/support/types";
import { ErrorNote, formatDate, Modal, money, ProjectBadge, Spinner } from "./ui";

type Project = CustomerProfile["project"];

/**
 * Move a customer to a cheaper plan and put the price difference back on their
 * card. Deliberately two separate operations against the provider, because no
 * provider does both: their built-in proration issues account credit, not a
 * card refund. See src/app/api/actions/downgrade/route.ts.
 */
export function DowngradeModal({
  profile,
  subscription,
  onClose,
  onDone,
}: {
  profile: CustomerProfile;
  subscription: BillingSubscription;
  onClose: () => void;
  onDone: (summary: string) => void;
}) {
  const project: Project = profile.project;
  const canChangePlans = project.capabilities?.planChanges ?? false;

  const [targets, setTargets] = useState<DowngradeTarget[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What they actually paid last, which is what a refund can come out of.
  const lastPaid: BillingOrder | undefined = useMemo(
    () =>
      profile.billing?.orders.find((o) => o.isPaid && o.totalAmount - o.refundedAmount > 0) ??
      profile.billing?.orders.find((o) => o.isPaid),
    [profile.billing],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch(`/api/admin/support/products?project=${encodeURIComponent(project.id)}`);
        const d = (await r.json()) as { products?: DowngradeTarget[]; error?: string };
        if (!live) return;
        if (!r.ok) throw new Error(d.error ?? "Could not load plans");
        setTargets(d.products ?? []);
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [project.id]);

  const currentAmount = lastPaid?.totalAmount ?? subscription.amount ?? 0;
  const currency = lastPaid?.currency ?? subscription.currency ?? "usd";

  // Cheaper, and a real subscription plan on the same billing interval.
  // One-time products (top-ups) have no interval and must never appear here —
  // a subscription cannot be moved onto them, and comparing a monthly price
  // against a yearly one would make the difference meaningless either way.
  const options = useMemo(
    () =>
      (targets ?? []).filter(
        (t) =>
          t.amount !== null &&
          t.amount < currentAmount &&
          t.interval !== null &&
          (!subscription.interval || t.interval === subscription.interval),
      ),
    [targets, currentAmount, subscription.interval],
  );

  const target = options.find((o) => o.id === choice) ?? null;
  const difference = target?.amount != null ? Math.max(0, currentAmount - target.amount) : 0;
  const refundable = lastPaid ? lastPaid.totalAmount - lastPaid.refundedAmount : 0;
  const refundAmount = Math.min(difference, refundable);

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/support/actions/downgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          email: profile.lookupEmail,
          subscriptionId: subscription.id,
          confirm: subscription.id,
          newProductId: target.id,
          newPlanName: target.name.split(/\s+/)[0],
          resume: subscription.cancelAtPeriodEnd,
          newPlanCredits: target.credits ?? undefined,
          refundOrderId: lastPaid?.id,
          refundAmount,
        }),
      });
      const d = (await r.json()) as {
        error?: string;
        steps?: { step: string; ok: boolean; detail: string }[];
      };
      if (!r.ok) throw new Error(d.error ?? "Downgrade failed");

      const done = (d.steps ?? []).filter((s) => s.ok).map((s) => s.detail);
      const failed = (d.steps ?? []).filter((s) => !s.ok && s.step !== "refund");
      onDone(
        `Downgraded ${profile.lookupEmail} to ${target.name}. ${done.join(" ")}${
          failed.length ? ` Not done: ${failed.map((f) => f.detail).join(" ")}` : ""
        }`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Providers without a plan-change API get instructions, not a dead button.
  if (!canChangePlans) {
    return (
      <Modal
        title={`Downgrade in ${project.providerLabel}`}
        subtitle={profile.lookupEmail}
        onClose={onClose}
        footer={
          <button onClick={onClose} className="btn btn-ghost">
            Close
          </button>
        }
      >
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
          <div className="mb-1 flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={13} /> {project.providerLabel} has no plan-change API
          </div>
          Move them to the cheaper plan in the {project.providerLabel} dashboard, and refund the
          difference there as well — it has no refund endpoint either.
        </div>

        <div className="rounded-lg bg-ink-850 px-3 py-2 text-xs">
          <Row label="Subscription" value={subscription.id} />
          <Row label="Current plan" value={subscription.productName ?? "—"} />
          <Row label="Paid" value={money(currentAmount, currency)} />
        </div>

        <p className="text-[11px] leading-relaxed text-slate-500">
          Once it is done there, come back and send the reply from here — the account panel picks
          the change up on the next lookup.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Downgrade and refund the difference"
      subtitle={`${profile.lookupEmail} · ${project.providerLabel}`}
      onClose={onClose}
      tone="danger"
      footer={
        <>
          <button onClick={onClose} className="btn btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button onClick={submit} disabled={!target || busy} className="btn btn-warn">
            {busy && <Spinner />}
            {busy
              ? "Working…"
              : target
                ? `Downgrade & refund ${money(refundAmount, currency)}`
                : "Pick a plan"}
          </button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <ProjectBadge label={project.label} tag={project.tag} />
        <span className="text-[11px] text-slate-500">via {project.providerLabel}</span>
      </div>

      <div className="rounded-lg bg-ink-850 px-3 py-2 text-xs">
        <Row label="Current plan" value={subscription.productName ?? "—"} strong />
        <Row label="They paid" value={money(currentAmount, currency)} />
        <Row label="Period ends" value={formatDate(subscription.currentPeriodEnd)} />
        {subscription.cancelAtPeriodEnd && (
          <Row label="Status" value="cancellation scheduled — will be lifted" />
        )}
        {lastPaid && <Row label="Refundable" value={money(refundable, lastPaid.currency)} />}
      </div>

      <div>
        <label className="label">Move them to</label>
        {loading ? (
          <p className="flex items-center gap-2 py-2 text-xs text-slate-500">
            <Spinner /> Loading plans…
          </p>
        ) : loadError ? (
          <ErrorNote>{loadError}</ErrorNote>
        ) : options.length === 0 ? (
          <p className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
            No cheaper recurring plan billed {subscription.interval ?? "the same way"}. One-time
            top-ups are excluded — a subscription cannot be moved onto one. There is nothing to
            downgrade to here, so cancelling may be what they want instead.
          </p>
        ) : (
          <select value={choice} onChange={(e) => setChoice(e.target.value)} className="field">
            <option value="">Select a plan…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} — {money(o.amount, o.currency)}
                {o.interval ? `/${o.interval}` : ""}
                {o.credits ? ` · ${o.credits.toLocaleString()} credits` : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      {target && (
        <>
          <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-xs">
            <div className="mb-1.5 flex items-center gap-2 text-slate-300">
              <span>{subscription.productName ?? "Current"}</span>
              <ArrowDown size={12} className="text-slate-600" />
              <span className="font-medium text-slate-100">{target.name}</span>
            </div>
            <Row label="They paid" value={money(currentAmount, currency)} />
            <Row label="New plan" value={money(target.amount, target.currency)} />
            <div className="my-1 border-t border-ink-700" />
            <Row label="Refund to card" value={money(refundAmount, currency)} strong />
            {refundAmount < difference && (
              <p className="mt-1 text-[10px] text-amber-300">
                Capped at what is left refundable on that order.
              </p>
            )}
          </div>

          <ul className="space-y-1 text-[11px] leading-relaxed text-slate-400">
            <li>
              • {money(refundAmount, currency)} goes back on their card now, as a real refund — not
              account credit.
            </li>
            <li>
              • Billing moves to {target.name} at the next period, so {project.providerLabel} issues
              no proration credit of its own. They would otherwise be compensated twice.
            </li>
            {subscription.cancelAtPeriodEnd && (
              <li className="text-amber-300">
                • Their scheduled cancellation is lifted, otherwise the subscription would end
                before the new plan ever starts. They stay a paying customer on {target.name}.
              </li>
            )}
            {target.credits !== null && (
              <li>
                • Credits are capped at {target.credits.toLocaleString()} in the {project.label}{" "}
                database, so they cannot keep a balance they have been refunded for.
              </li>
            )}
          </ul>
        </>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string | null; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-slate-500">{label}</span>
      <span className={strong ? "font-medium text-slate-200" : "text-slate-300"}>
        {value ?? "—"}
      </span>
    </div>
  );
}
