"use client";

import { Inbox, Paperclip, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BillingStatus, InboxMessage, Intent, ProjectSummary, StatusMap } from "@/lib/support/types";
import { cx, ErrorNote, IntentBadge, money, ProjectBadge, relativeDate, Spinner } from "./ui";

/**
 * "person" is not an intent — a refund request is also from a person. It's a
 * separate view over the same list: everything a human actually typed,
 * whatever they were writing about.
 */
type ViewKey = Intent | "all" | "person";

const VIEW_FILTERS: { key: ViewKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "person", label: "Person" },
  { key: "refund", label: "Refunds" },
  { key: "cancel", label: "Cancels" },
  { key: "billing", label: "Billing" },
  { key: "support", label: "Support" },
];

const matchesView = (message: InboxMessage, view: ViewKey) =>
  view === "all" ? true : view === "person" ? message.isPerson : message.intent === view;

export const statusKey = (m: { projectId: string; from: { address: string } }) =>
  `${m.projectId}:${m.from.address.toLowerCase()}`;

/**
 * Is this request still outstanding? Only refund and cancellation mail has a
 * resolvable state; everything else is excluded from the Needs-action view.
 *
 * A sender we can't find in the billing provider counts as outstanding — you
 * still have to deal with them, and silently hiding them would be worse than
 * showing one you've already handled.
 */
export function needsAction(message: InboxMessage, status: BillingStatus | undefined): boolean {
  if (message.intent !== "refund" && message.intent !== "cancel") return false;
  if (!status) return false; // not resolved yet
  if (!status.found) return true;

  return message.intent === "refund"
    ? status.refundable > 0
    : status.activeSubscription && !status.cancelScheduled;
}

export default function EmailList({
  messages,
  projects,
  selectedKey,
  onSelect,
  loading,
  errors,
  onRefresh,
  statuses,
  statusLoading,
  onResolveStatuses,
}: {
  messages: InboxMessage[];
  projects: ProjectSummary[];
  selectedKey: string | null;
  onSelect: (message: InboxMessage) => void;
  loading: boolean;
  errors: { projectId: string | null; message: string }[];
  onRefresh: () => void;
  statuses: StatusMap;
  statusLoading: boolean;
  onResolveStatuses: (messages: InboxMessage[]) => void;
}) {
  const [view, setView] = useState<ViewKey>("all");
  const [projectId, setProjectId] = useState<string | "all">("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const [query, setQuery] = useState("");

  // Every refund/cancel email in the inbox, regardless of the other filters —
  // resolving the whole set once means toggling filters costs no extra calls.
  const actionable = useMemo(
    () => messages.filter((m) => m.intent === "refund" || m.intent === "cancel"),
    [messages],
  );

  // Resolve on demand: only when the view actually needs billing state.
  useEffect(() => {
    if (!openOnly || actionable.length === 0) return;
    const missing = actionable.filter((m) => !statuses[statusKey(m)]);
    if (missing.length > 0) onResolveStatuses(missing);
  }, [openOnly, actionable, statuses, onResolveStatuses]);

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return messages.filter((message) => {
      if (unreadOnly && message.seen) return false;
      if (openOnly && !needsAction(message, statuses[statusKey(message)])) return false;
      if (!matchesView(message, view)) return false;
      if (projectId !== "all" && message.projectId !== projectId) return false;
      if (!needle) return true;
      return (
        message.subject.toLowerCase().includes(needle) ||
        message.from.address.includes(needle) ||
        message.from.name.toLowerCase().includes(needle) ||
        message.snippet.toLowerCase().includes(needle)
      );
    });
  }, [messages, view, projectId, unreadOnly, openOnly, statuses, query]);

  // Counts respect the other active filters, so the numbers match what a click
  // would actually show.
  const scoped = useMemo(
    () =>
      messages.filter(
        (m) =>
          (!unreadOnly || !m.seen) &&
          (!openOnly || needsAction(m, statuses[statusKey(m)])) &&
          (projectId === "all" || m.projectId === projectId),
      ),
    [messages, unreadOnly, openOnly, statuses, projectId],
  );
  // Counted the same way they're filtered, so a pill's number always matches
  // what clicking it shows.
  const viewCounts = useMemo(() => {
    const map = new Map<ViewKey, number>();
    for (const entry of VIEW_FILTERS) {
      map.set(entry.key, scoped.filter((m) => matchesView(m, entry.key)).length);
    }
    return map;
  }, [scoped]);

  const projectCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const message of messages) {
      if (unreadOnly && message.seen) continue;
      if (openOnly && !needsAction(message, statuses[statusKey(message)])) continue;
      map.set(message.projectId, (map.get(message.projectId) ?? 0) + 1);
    }
    return map;
  }, [messages, unreadOnly, openOnly, statuses]);

  const unreadTotal = useMemo(() => messages.filter((m) => !m.seen).length, [messages]);
  const inboxProjects = projects.filter((project) => project.active);

  return (
    <aside className="flex h-full w-[370px] shrink-0 flex-col border-r border-ink-800 bg-ink-900">
      <div className="space-y-2.5 border-b border-ink-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Inbox size={15} className="text-slate-500" />
            <span className="text-sm font-semibold text-slate-200">Inbox</span>
            <span className="text-xs text-slate-500">
              {messages.length}
              {unreadTotal > 0 && <span className="ml-1 text-accent">· {unreadTotal} unread</span>}
            </span>
          </div>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="btn btn-ghost !px-2 !py-1.5"
            title="Fetch new mail from every account"
          >
            {loading ? <Spinner /> : <RefreshCw size={13} />}
          </button>
        </div>

        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sender or subject"
            className="field !py-1.5 !pl-8 text-xs"
          />
        </div>

        {/* Project tags — which site am I working on */}
        {inboxProjects.length > 1 && (
          <div className="flex flex-wrap gap-1">
            <FilterPill active={projectId === "all"} onClick={() => setProjectId("all")}>
              All sites
            </FilterPill>
            {inboxProjects.map((project) => (
              <FilterPill
                key={project.id}
                active={projectId === project.id}
                onClick={() => setProjectId(project.id)}
                count={projectCounts.get(project.id) ?? 0}
              >
                {project.label}
              </FilterPill>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1">
          {VIEW_FILTERS.map((entry) => (
            <FilterPill
              key={entry.key}
              active={view === entry.key}
              onClick={() => setView(entry.key)}
              count={viewCounts.get(entry.key) ?? 0}
            >
              {entry.label}
            </FilterPill>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <label className="flex cursor-pointer select-none items-center gap-2 text-[11px] text-slate-400 hover:text-slate-300">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
              className="accent-accent"
            />
            Unread only
          </label>

          <label
            className="flex cursor-pointer select-none items-center gap-2 text-[11px] text-slate-400 hover:text-slate-300"
            title="Refund requests not yet refunded, and cancellation requests whose subscription is still billing"
          >
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(e) => setOpenOnly(e.target.checked)}
              className="accent-accent"
            />
            Needs action
            {statusLoading && <Spinner className="text-slate-500" />}
          </label>

          {(unreadOnly || openOnly) && (
            <span className="text-[11px] text-slate-600">{visible.length} shown</span>
          )}
        </div>

        {openOnly && !statusLoading && actionable.length > 0 && (
          <p className="text-[10px] leading-relaxed text-slate-600">
            Checked {actionable.length} refund/cancel request
            {actionable.length === 1 ? "" : "s"} against their billing provider.
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {errors.map((error, index) => (
          <div key={index} className="p-3 pb-0">
            <ErrorNote>{error.message}</ErrorNote>
          </div>
        ))}

        {loading && messages.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-slate-500">Connecting to Gmail…</p>
        )}

        {!loading && visible.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-slate-500">
            {unreadOnly && messages.length > 0
              ? "Nothing unread in this view."
              : "Nothing matches this view."}
          </p>
        )}

        {visible.map((message) => {
          const active = message.key === selectedKey;
          const project = projectById.get(message.projectId);
          return (
            <button
              key={message.key}
              onClick={() => onSelect(message)}
              className={cx(
                "block w-full border-b border-ink-850 px-4 py-3 text-left transition-colors",
                active ? "bg-ink-800" : "hover:bg-ink-850",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cx(
                    "truncate text-[13px]",
                    message.seen ? "font-normal text-slate-400" : "font-semibold text-slate-100",
                  )}
                >
                  {message.from.name || message.from.address}
                </span>
                <span className="shrink-0 text-[10px] text-slate-600">
                  {relativeDate(message.date)}
                </span>
              </div>

              <div className="mt-0.5 flex items-center gap-1.5">
                {!message.seen && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                <span
                  className={cx(
                    "truncate text-xs",
                    message.seen ? "text-slate-500" : "text-slate-200",
                  )}
                >
                  {message.subject}
                </span>
                {message.hasAttachments && (
                  <Paperclip size={11} className="shrink-0 text-slate-600" />
                )}
              </div>

              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-600">
                {message.snippet}
              </p>

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {project && <ProjectBadge label={project.label} tag={project.tag} />}
                <IntentBadge intent={message.intent} />
                <ResolutionChip message={message} status={statuses[statusKey(message)]} />
                {message.answered && (
                  <span className="chip bg-ink-800 text-slate-500 ring-1 ring-ink-700">Replied</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/** Shows how a refund/cancel request stands, once its sender has been resolved. */
function ResolutionChip({
  message,
  status,
}: {
  message: InboxMessage;
  status: BillingStatus | undefined;
}) {
  if (!status) return null;
  if (message.intent !== "refund" && message.intent !== "cancel") return null;

  if (!status.found) {
    return (
      <span className="chip bg-ink-800 text-slate-500 ring-1 ring-ink-700" title={status.error}>
        no account
      </span>
    );
  }

  if (message.intent === "refund") {
    return status.refundable > 0 ? (
      <span className="chip bg-amber-950/70 text-amber-300 ring-1 ring-amber-900/60">
        {money(status.refundable, status.currency)} open
      </span>
    ) : (
      <span className="chip bg-emerald-950/70 text-emerald-300 ring-1 ring-emerald-900/60">
        refunded
      </span>
    );
  }

  if (!status.activeSubscription) {
    return (
      <span className="chip bg-emerald-950/70 text-emerald-300 ring-1 ring-emerald-900/60">
        no subscription
      </span>
    );
  }
  return status.cancelScheduled ? (
    <span className="chip bg-emerald-950/70 text-emerald-300 ring-1 ring-emerald-900/60">
      cancelled
    </span>
  ) : (
    <span className="chip bg-amber-950/70 text-amber-300 ring-1 ring-amber-900/60">
      still billing
    </span>
  );
}

function FilterPill({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
        active
          ? "bg-accent text-white"
          : "bg-ink-850 text-slate-400 hover:bg-ink-800 hover:text-slate-300",
      )}
    >
      {children}
      {count !== undefined && count > 0 && <span className="ml-1 opacity-60">{count}</span>}
    </button>
  );
}
