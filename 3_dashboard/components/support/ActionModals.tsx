"use client";

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { BillingOrder, BillingSubscription, CustomerProfile } from "@/lib/support/types";
import { cx, ErrorNote, formatDate, Modal, money, ProjectBadge, Spinner, StatusBadge } from "./ui";

type Project = CustomerProfile["project"];

export function RefundModal({
  order,
  project,
  customerEmail,
  onClose,
  onDone,
}: {
  order: BillingOrder;
  project: Project;
  customerEmail: string;
  onClose: () => void;
  onDone: (summary: string) => void;
}) {
  const maxRefundable = order.totalAmount - order.refundedAmount;
  const reasons = project.capabilities?.refundReasons ?? [];
  const apiRefunds = project.capabilities?.refundsViaApi ?? true;

  const [amount, setAmount] = useState((maxRefundable / 100).toFixed(2));
  const [reason, setReason] = useState(reasons[0]?.value ?? "customer_request");
  const [comment, setComment] = useState("");
  // Default on for a full refund — they are getting all their money back, so
  // they should not keep what it bought. Left off for a partial refund, where
  // stripping everything would be disproportionate.
  const [revokeAccess, setRevokeAccess] = useState(true);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const minorAmount = Math.round(Number(amount) * 100);
  const isFullRefund = minorAmount >= maxRefundable;
  const amountValid =
    Number.isFinite(minorAmount) && minorAmount > 0 && minorAmount <= maxRefundable;
  const ready = amountValid && typed.trim().toUpperCase() === "REFUND" && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/support/actions/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          orderId: order.id,
          confirm: order.id,
          amount: minorAmount,
          reason,
          comment: comment.trim() || undefined,
          email: customerEmail,
          revokeAccess: revokeAccess && isFullRefund,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        subscriptionStillActive?: string;
        steps?: { step: string; ok: boolean; detail: string }[];
      };
      if (!response.ok) throw new Error(data.error ?? "Refund failed");

      const extra = (data.steps ?? [])
        .filter((step) => step.step !== "refund")
        .map((step) => (step.ok ? step.detail : `NOT DONE — ${step.detail}`));

      onDone(
        `Refunded ${money(minorAmount, order.currency)} to ${customerEmail} for their ${formatDate(
          order.createdAt,
        )} ${project.label} order.${extra.length ? ` ${extra.join(" ")}` : ""}`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  // Freemius exposes no refund endpoint — refunds happen in its Developer
  // Dashboard. Offering a button here would only produce a 501.
  if (!apiRefunds) {
    const console_ = project.capabilities?.refundConsoleUrl ?? "https://dashboard.freemius.com";
    return (
      <Modal
        title={`Refund in ${project.providerLabel}`}
        subtitle={`${customerEmail} · payment ${order.id}`}
        onClose={onClose}
        footer={
          <button onClick={onClose} className="btn btn-ghost">
            Close
          </button>
        }
      >
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
          <div className="mb-1 flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={13} /> {project.providerLabel} has no refund API
          </div>
          Refunds can only be issued from the {project.providerLabel} Developer Dashboard, so this
          one has to be done there. Everything else for this customer — lookup, credits,
          cancellation, the reply — still works here.
        </div>

        <div className="rounded-lg bg-ink-850 px-3 py-2 text-xs">
          <Line label="Payment id" value={order.id} strong />
          <Line label="Amount" value={money(order.totalAmount, order.currency)} />
          <Line label="Paid on" value={formatDate(order.createdAt, true)} />
          {order.refundedAmount > 0 && (
            <Line
              label="Already refunded"
              value={money(order.refundedAmount, order.currency)}
              tone="warn"
            />
          )}
        </div>

        <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-slate-400">
          <li>
            Open{" "}
            <a
              href={console_}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline underline-offset-2"
            >
              {console_.replace(/^https?:\/\//, "")}
            </a>{" "}
            → Payments.
          </li>
          <li>
            Find payment <span className="font-mono text-slate-300">{order.id}</span> and press
            Refund.
          </li>
          <li>Come back and send the customer a reply from here.</li>
        </ol>

        <p className="text-[11px] leading-relaxed text-slate-500">
          Note that {project.providerLabel} allows only one partial refund per payment, and the
          Needs-action filter will keep flagging this request until the refund shows up in their API.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Refund this payment"
      subtitle={`${customerEmail} · ${project.providerLabel} order ${order.id.slice(0, 12)}…`}
      onClose={onClose}
      tone="danger"
      footer={
        <>
          <button onClick={onClose} className="btn btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button onClick={submit} disabled={!ready} className="btn btn-warn">
            {busy && <Spinner />}
            {busy ? "Refunding…" : `Refund ${money(minorAmount, order.currency)}`}
          </button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <ProjectBadge label={project.label} tag={project.tag} />
        <span className="text-[11px] text-slate-500">
          money moves through {project.providerLabel}
        </span>
      </div>

      <div className="rounded-lg bg-ink-850 px-3 py-2 text-xs">
        <Line label="Order total" value={money(order.totalAmount, order.currency)} strong />
        <Line label="Paid on" value={formatDate(order.createdAt, true)} />
        <div className="flex items-center justify-between py-0.5">
          <span className="text-slate-500">Status</span>
          <StatusBadge status={order.status} />
        </div>
        {order.refundedAmount > 0 && (
          <Line
            label="Already refunded"
            value={money(order.refundedAmount, order.currency)}
            tone="warn"
          />
        )}
      </div>

      <div>
        <label className="label">Refund amount ({order.currency.toUpperCase()})</label>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className="field"
        />
        <p className="mt-1 text-[11px] text-slate-500">
          Up to {money(maxRefundable, order.currency)}. Lower the number for a partial refund.
        </p>
      </div>

      {reasons.length > 0 ? (
        <div>
          <label className="label">Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)} className="field">
            {reasons.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          {project.providerLabel} does not record a refund reason. Anything you type below is kept
          in this dashboard&apos;s action log only.
        </p>
      )}

      <div>
        <label className="label">Internal note (optional)</label>
        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={reasons.length > 0 ? `Visible in ${project.providerLabel} only` : "Kept locally"}
          className="field"
        />
      </div>

      {isFullRefund ? (
        <div
          className={cx(
            "rounded-lg border px-3 py-2.5",
            revokeAccess ? "border-red-900/60 bg-red-950/30" : "border-ink-700 bg-ink-850",
          )}
        >
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={revokeAccess}
              onChange={(e) => setRevokeAccess(e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span className={revokeAccess ? "text-red-300" : "text-slate-400"}>
              <span className="font-medium">Revoke all access</span> — take back everything the
              payment bought.
            </span>
          </label>

          {revokeAccess && (
            <ul className="mt-2 space-y-1 pl-6 text-[11px] leading-relaxed text-slate-400">
              <li>
                • Subscription cancelled{" "}
                {project.capabilities?.immediateCancellation
                  ? "immediately"
                  : `at period end (${project.providerLabel} allows no sooner)`}
                , so it stops billing and stops granting access.
              </li>
              <li>
                • Credits zeroed in the {project.label} database, plan cleared, and the word limit
                dropped back to the free tier. This is what actually gates the product — a refunded
                customer with credits left can keep using it.
              </li>
              {order.supportsBenefitRevocation && (
                <li>• Entitlement for this order revoked in {project.providerLabel}.</li>
              )}
              <li className="text-slate-500">
                Their account itself is kept. Use Archive &amp; delete to remove it entirely.
              </li>
            </ul>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-[11px] leading-relaxed text-slate-400">
          This is a partial refund, so access is left alone — stripping everything for part of the
          money back would be disproportionate. Refund the full{" "}
          {money(maxRefundable, order.currency)} if you want the revoke option, or cancel separately.
        </div>
      )}

      <div>
        <label className="label">Type REFUND to confirm</label>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="REFUND"
          className="field font-mono uppercase tracking-widest"
        />
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}

export function CancelModal({
  subscription,
  project,
  customerEmail,
  onClose,
  onDone,
}: {
  subscription: BillingSubscription;
  project: Project;
  customerEmail: string;
  onClose: () => void;
  onDone: (summary: string) => void;
}) {
  const canRevokeNow = project.capabilities?.immediateCancellation ?? false;
  // Some providers only cancel immediately — there is no choice to present.
  const alwaysImmediate = project.capabilities?.cancellationAlwaysImmediate ?? false;
  const [atPeriodEnd, setAtPeriodEnd] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endDate = formatDate(subscription.currentPeriodEnd ?? subscription.endsAt);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/support/actions/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          subscriptionId: subscription.id,
          confirm: subscription.id,
          atPeriodEnd: canRevokeNow ? atPeriodEnd : true,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Cancellation failed");

      onDone(
        (canRevokeNow && !atPeriodEnd) || alwaysImmediate
          ? `Cancelled the ${project.label} subscription for ${customerEmail} immediately; access has ended.`
          : `Cancelled the ${project.label} subscription for ${customerEmail}; access continues until ${endDate}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Cancel subscription"
      subtitle={`${customerEmail} · ${subscription.productName ?? subscription.id.slice(0, 12)}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn btn-ghost" disabled={busy}>
            Keep it
          </button>
          <button onClick={submit} disabled={busy} className="btn btn-warn">
            {busy && <Spinner />}
            {busy ? "Cancelling…" : "Cancel subscription"}
          </button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <ProjectBadge label={project.label} tag={project.tag} />
        <span className="text-[11px] text-slate-500">via {project.providerLabel}</span>
      </div>

      <div className="rounded-lg bg-ink-850 px-3 py-2 text-xs">
        <div className="flex items-center justify-between py-0.5">
          <span className="text-slate-500">Status</span>
          <StatusBadge status={subscription.status} />
        </div>
        <Line
          label="Started"
          value={formatDate(subscription.startedAt ?? subscription.createdAt)}
        />
        <Line label="Paid through" value={endDate} />
        {subscription.amount !== null && (
          <Line
            label="Amount"
            value={`${money(subscription.amount, subscription.currency ?? "usd")}${
              subscription.interval ? ` / ${subscription.interval}` : ""
            }`}
          />
        )}
      </div>

      {canRevokeNow && !alwaysImmediate ? (
        <div className="space-y-2">
          <Choice
            checked={atPeriodEnd}
            onSelect={() => setAtPeriodEnd(true)}
            title="At period end (recommended)"
            body={`No further charges. They keep access until ${endDate} — they already paid for it.`}
          />
          <Choice
            checked={!atPeriodEnd}
            onSelect={() => setAtPeriodEnd(false)}
            title="Immediately"
            body="Revokes access right now. Use this when you are also refunding the last payment."
          />
        </div>
      ) : (
        <p className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-[11px] leading-relaxed text-slate-400">
          {project.capabilities?.cancellationNote}
          <span className="mt-1 block text-slate-300">Access continues until {endDate}.</span>
        </p>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}

export function DeleteModal({
  profile,
  onClose,
  onDone,
}: {
  profile: CustomerProfile;
  onClose: () => void;
  onDone: (summary: string) => void;
}) {
  const neon = profile.neon!;
  const project = profile.project;
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("Refund processed via support dashboard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = typed.trim().toLowerCase() === neon.email.toLowerCase() && !busy;
  const stillBilling =
    profile.billing?.activeSubscription && !profile.billing.activeSubscription.cancelAtPeriodEnd;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/support/actions/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          email: neon.email,
          confirm: typed.trim(),
          reason,
        }),
      });
      const data = (await response.json()) as { error?: string; archivePath?: string };
      if (!response.ok) throw new Error(data.error ?? "Delete failed");

      onDone(
        `Deleted ${neon.email} from the ${project.label} database. A full archive was saved as ${data.archivePath}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Archive and delete"
      subtitle={`${neon.email} · ${project.label}`}
      onClose={onClose}
      tone="danger"
      footer={
        <>
          <button onClick={onClose} className="btn btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button onClick={submit} disabled={!ready} className="btn btn-danger">
            {busy && <Spinner />}
            {busy ? "Deleting…" : "Archive & delete"}
          </button>
        </>
      }
    >
      <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2.5 text-xs leading-relaxed text-red-300">
        <div className="mb-1 flex items-center gap-1.5 font-semibold">
          <AlertTriangle size={13} /> This cannot be undone
        </div>
        Deleting the user row cascades to their run history, API keys, projects and any team they
        own. A JSON archive is written to{" "}
        <span className="font-mono">dashboard/archives/{project.id}/</span> first, so you keep a
        record for chargebacks.
      </div>

      <div className="rounded-lg bg-ink-850 px-3 py-2 text-xs">
        <Line label="Runs" value={neon.usage.totalRuns.toLocaleString()} />
        <Line label="API keys" value={String(neon.counts.apiKeys)} />
        <Line label="Projects" value={String(neon.counts.projects)} />
        <Line label="Teams owned" value={String(neon.counts.ownedTeams)} />
      </div>

      {stillBilling && (
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
          Their {project.providerLabel} subscription is still{" "}
          <strong>{profile.billing!.activeSubscription!.status}</strong>. Cancel it first, or they
          will keep being billed after their account is gone.
        </div>
      )}

      <div>
        <label className="label">Reason (stored in the archive)</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} className="field" />
      </div>

      <div>
        <label className="label">
          Type <span className="font-mono normal-case text-slate-300">{neon.email}</span> to confirm
        </label>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={neon.email}
          className="field font-mono"
          autoComplete="off"
        />
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}

function Line({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "warn";
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-slate-500">{label}</span>
      <span
        className={
          tone === "warn"
            ? "text-amber-300"
            : strong
              ? "font-medium text-slate-200"
              : "text-slate-300"
        }
      >
        {value}
      </span>
    </div>
  );
}

function Choice({
  checked,
  onSelect,
  title,
  body,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  body: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-ink-700 bg-ink-850 p-3 text-xs">
      <input type="radio" checked={checked} onChange={onSelect} className="mt-0.5 accent-accent" />
      <span>
        <span className="block font-medium text-slate-200">{title}</span>
        <span className="text-slate-500">{body}</span>
      </span>
    </label>
  );
}
