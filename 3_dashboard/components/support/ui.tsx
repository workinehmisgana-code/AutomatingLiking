"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import type { Intent } from "@/lib/support/types";

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

const INTENT_STYLE: Record<Intent, { label: string; className: string }> = {
  refund: { label: "Refund", className: "bg-red-950/70 text-red-300 ring-1 ring-red-900/60" },
  cancel: { label: "Cancel", className: "bg-amber-950/70 text-amber-300 ring-1 ring-amber-900/60" },
  billing: { label: "Billing", className: "bg-violet-950/70 text-violet-300 ring-1 ring-violet-900/60" },
  support: { label: "Support", className: "bg-sky-950/70 text-sky-300 ring-1 ring-sky-900/60" },
  other: { label: "General", className: "bg-ink-800 text-slate-400 ring-1 ring-ink-700" },
};

export function IntentBadge({ intent }: { intent: Intent }) {
  const style = INTENT_STYLE[intent];
  return <span className={cx("chip", style.className)}>{style.label}</span>;
}

const STATUS_STYLE: Record<string, string> = {
  paid: "bg-emerald-950/70 text-emerald-300 ring-1 ring-emerald-900/60",
  succeeded: "bg-emerald-950/70 text-emerald-300 ring-1 ring-emerald-900/60",
  active: "bg-emerald-950/70 text-emerald-300 ring-1 ring-emerald-900/60",
  trialing: "bg-sky-950/70 text-sky-300 ring-1 ring-sky-900/60",
  pending: "bg-amber-950/70 text-amber-300 ring-1 ring-amber-900/60",
  refunded: "bg-red-950/70 text-red-300 ring-1 ring-red-900/60",
  partially_refunded: "bg-orange-950/70 text-orange-300 ring-1 ring-orange-900/60",
  canceled: "bg-ink-800 text-slate-400 ring-1 ring-ink-700",
  past_due: "bg-red-950/70 text-red-300 ring-1 ring-red-900/60",
  failed: "bg-red-950/70 text-red-300 ring-1 ring-red-900/60",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cx("chip", STATUS_STYLE[status] ?? "bg-ink-800 text-slate-400 ring-1 ring-ink-700")}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** The project tag — how you tell at a glance which site an email belongs to. */
export function ProjectBadge({
  label,
  tag,
  className,
}: {
  label: string;
  tag: string;
  className?: string;
}) {
  return <span className={cx("chip", tag, className)}>{label}</span>;
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-key">{label}</span>
      <span className="row-val">{children}</span>
    </div>
  );
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{children}</h3>
      {right}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs leading-relaxed text-red-300">
      {children}
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  tone = "neutral",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  tone?: "neutral" | "danger";
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="card w-full max-w-lg overflow-hidden shadow-2xl">
        <div
          className={cx(
            "flex items-start justify-between gap-4 border-b px-5 py-4",
            tone === "danger" ? "border-red-900/50 bg-red-950/30" : "border-ink-700 bg-ink-850",
          )}
        >
          <div>
            <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
            {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-ink-700 bg-ink-850 px-5 py-3">
          {footer}
        </div>
      </div>
    </div>
  );
}

export function formatDate(iso?: string | null, withTime = false): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

export function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function money(minor: number | null | undefined, currency = "usd"): string {
  if (minor === null || minor === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
