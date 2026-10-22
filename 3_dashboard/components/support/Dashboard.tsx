"use client";

import { AlertTriangle, ShieldCheck, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BillingOrder,
  StatusMap,
  BillingSubscription,
  CustomerProfile,
  InboxDetail,
  InboxMessage,
  ProjectSummary,
} from "@/lib/support/types";
import { CancelModal, DeleteModal, RefundModal } from "./ActionModals";
import { DowngradeModal } from "./DowngradeModal";
import Composer, { type ComposerState } from "./Composer";
import CustomerPanel from "./CustomerPanel";
import EmailList from "./EmailList";
import EmailView from "./EmailView";
import { cx } from "./ui";

type ModalState =
  | { type: "refund"; order: BillingOrder }
  | { type: "cancel"; subscription: BillingSubscription }
  | { type: "downgrade"; subscription: BillingSubscription }
  | { type: "delete" }
  | null;

const EMPTY_COMPOSER: ComposerState = {
  to: "",
  cc: "",
  subject: "",
  instruction: "",
  draft: "",
  tone: "warm",
  includeFacts: true,
};

export default function Dashboard({
  projects,
  groqReady,
}: {
  projects: ProjectSummary[];
  groqReady: boolean;
}) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listErrors, setListErrors] = useState<{ projectId: string | null; message: string }[]>([]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /** The project of the currently open email — everything routes through it. */
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const [lookupEmail, setLookupEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [composer, setComposer] = useState<ComposerState>(EMPTY_COMPOSER);
  const [actionsTaken, setActionsTaken] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Billing state per sender, for the Needs-action view. Resolved lazily and
  // kept until the inbox is reloaded, so toggling filters is free.
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [statusLoading, setStatusLoading] = useState(false);
  const inFlight = useRef(new Set<string>());

  // Guards against a slow lookup for a previous email overwriting a newer one.
  const lookupToken = useRef(0);

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const activeProject = activeProjectId ? (projectById.get(activeProjectId) ?? null) : null;
  const liveProjects = projects.filter((project) => project.active);
  const readyProjects = liveProjects.filter((project) => project.billingReady);
  const anySandbox = liveProjects.some((project) => project.sandbox);

  const loadInbox = useCallback(async () => {
    setListLoading(true);
    setListErrors([]);
    try {
      const response = await fetch("/api/admin/support/emails?limit=60");
      const data = (await response.json()) as {
        messages?: InboxMessage[];
        errors?: { projectId: string | null; message: string }[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Could not read the inboxes");
      setMessages(data.messages ?? []);
      setListErrors(data.errors ?? []);
      // Billing may have moved on since the last check.
      setStatuses({});
      inFlight.current.clear();
    } catch (error) {
      setListErrors([
        { projectId: null, message: error instanceof Error ? error.message : String(error) },
      ]);
    } finally {
      setListLoading(false);
    }
  }, []);

  const lookupCustomer = useCallback(async (projectId: string, email: string) => {
    const token = ++lookupToken.current;
    setLookupEmail(email);
    setProfileLoading(true);
    setProfileError(null);
    setProfile(null);
    try {
      const response = await fetch(
        `/api/admin/support/customer?project=${encodeURIComponent(projectId)}&email=${encodeURIComponent(email)}`,
      );
      const data = (await response.json()) as { profile?: CustomerProfile; error?: string };
      if (token !== lookupToken.current) return;
      if (!response.ok) throw new Error(data.error ?? "Lookup failed");
      setProfile(data.profile ?? null);
    } catch (error) {
      if (token !== lookupToken.current) return;
      setProfileError(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === lookupToken.current) setProfileLoading(false);
    }
  }, []);

  const openMessage = useCallback(
    async (message: InboxMessage) => {
      setSelectedKey(message.key);
      setActiveProjectId(message.projectId);
      setDetail(null);
      setDetailLoading(true);
      setDetailError(null);
      setActionsTaken([]);
      setSentAt(null);
      setComposerError(null);
      setProfile(null);
      setComposer({ ...EMPTY_COMPOSER, to: message.from.address, subject: message.subject });

      try {
        const response = await fetch(`/api/admin/support/emails/${message.projectId}/${message.uid}`);
        const data = (await response.json()) as { message?: InboxDetail; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Could not open the message");
        setDetail(data.message ?? null);

        // Reflect the now-read state in the list without a full refetch.
        setMessages((current) =>
          current.map((entry) => (entry.key === message.key ? { ...entry, seen: true } : entry)),
        );

        if (data.message) void lookupCustomer(message.projectId, data.message.from.address);
      } catch (error) {
        setDetailError(error instanceof Error ? error.message : String(error));
      } finally {
        setDetailLoading(false);
      }
    },
    [lookupCustomer],
  );

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function generateDraft() {
    if (!activeProjectId) return;
    setGenerating(true);
    setComposerError(null);
    try {
      const response = await fetch("/api/admin/support/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          instruction: composer.instruction,
          customerEmail: composer.to || lookupEmail,
          customerName: profile?.neon?.name ?? profile?.billing?.customer.name ?? detail?.from.name,
          subject: composer.subject,
          originalBody: detail?.text || detail?.snippet || "",
          actionsTaken,
          tone: composer.tone,
          includeAccountFacts: composer.includeFacts,
        }),
      });
      const data = (await response.json()) as { draft?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Draft failed");
      setComposer((current) => ({ ...current, draft: data.draft ?? "" }));
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  }

  async function sendReply() {
    if (!activeProjectId) return;
    setSending(true);
    setComposerError(null);
    try {
      const response = await fetch("/api/admin/support/emails/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          uid: detail?.uid,
          to: composer.to,
          cc: composer.cc,
          subject: composer.subject,
          text: composer.draft,
          inReplyTo: detail?.messageId,
          references: detail ? [...detail.references, detail.messageId].filter(Boolean) : [],
        }),
      });
      const data = (await response.json()) as { error?: string; sentFrom?: string };
      if (!response.ok) throw new Error(data.error ?? "Send failed");

      setSentAt(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
      setToast(`Reply sent to ${composer.to} from ${data.sentFrom ?? activeProject?.email ?? ""}`);
      if (detail) {
        setMessages((current) =>
          current.map((entry) =>
            entry.key === `${activeProjectId}:${detail.uid}`
              ? { ...entry, answered: true, seen: true }
              : entry,
          ),
        );
      }
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  /** Resolve billing state for senders the Needs-action view hasn't seen yet. */
  const resolveStatuses = useCallback(async (batch: InboxMessage[]) => {
    const items = new Map<string, { projectId: string; email: string }>();
    for (const m of batch) {
      const key = `${m.projectId}:${m.from.address.toLowerCase()}`;
      if (!inFlight.current.has(key)) items.set(key, { projectId: m.projectId, email: m.from.address });
    }
    if (items.size === 0) return;
    for (const key of Array.from(items.keys())) inFlight.current.add(key);

    setStatusLoading(true);
    try {
      const response = await fetch("/api/admin/support/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: Array.from(items.values()) }),
      });
      const data = (await response.json()) as { statuses?: StatusMap; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not check billing status");
      setStatuses((current) => ({ ...current, ...(data.statuses ?? {}) }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
      for (const key of Array.from(items.keys())) inFlight.current.delete(key);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  function completeAction(summary: string) {
    setModal(null);
    setActionsTaken((current) => [...current, summary]);
    setToast(summary);
    if (lookupEmail && activeProjectId) void lookupCustomer(activeProjectId, lookupEmail);

    // The refund or cancellation just changed this sender's state — drop the
    // cached status so the Needs-action view re-checks instead of going stale.
    if (lookupEmail && activeProjectId) {
      const key = `${activeProjectId}:${lookupEmail.toLowerCase()}`;
      inFlight.current.delete(key);
      setStatuses((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  const setupWarnings = [
    liveProjects.length === 0 && "no Gmail accounts configured",
    liveProjects.length > 0 &&
      readyProjects.length < liveProjects.length &&
      `${liveProjects.length - readyProjects.length} project(s) without billing credentials`,
    !groqReady && "AI key (GEMINI_API_KEY or GROQ_API_KEY) missing",
  ].filter(Boolean) as string[];

  return (
    // Below the admin's genre bar, so the height leaves room for it.
    <div className="support-desk flex h-[calc(100vh-49px)] flex-col overflow-hidden bg-ink-950 text-slate-200">
      <header className="flex shrink-0 items-center justify-between border-b border-ink-800 bg-ink-900 px-5 py-2.5">
        <div className="flex items-center gap-2.5">
          <Zap size={16} className="text-accent" />
          <h1 className="text-sm font-semibold text-slate-100">Support Desk</h1>
          <span className="text-[11px] text-slate-500">
            {liveProjects.length} site{liveProjects.length === 1 ? "" : "s"}
          </span>
          <span
            className={cx(
              "chip",
              anySandbox
                ? "bg-sky-950/70 text-sky-300 ring-1 ring-sky-900/60"
                : "bg-red-950/70 text-red-300 ring-1 ring-red-900/60",
            )}
          >
            {anySandbox ? "sandbox in use" : "production · real money"}
          </span>
        </div>

        <div className="flex items-center gap-3 text-[11px]">
          {setupWarnings.length === 0 ? (
            <span className="inline-flex items-center gap-1 text-slate-500">
              <ShieldCheck size={12} className="text-emerald-500" />
              All {liveProjects.length} sites connected
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-amber-400"
              title="Set these in the dashboard's environment (see RefundProcessor/dashboard/.env.example for the names)"
            >
              <AlertTriangle size={12} />
              {setupWarnings.join(" · ")}
            </span>
          )}
          <a href="/admin" className="text-slate-400 hover:text-slate-200">Dashboard</a>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <EmailList
          messages={messages}
          projects={projects}
          selectedKey={selectedKey}
          onSelect={(message) => void openMessage(message)}
          loading={listLoading}
          errors={listErrors}
          onRefresh={() => void loadInbox()}
          statuses={statuses}
          statusLoading={statusLoading}
          onResolveStatuses={(batch) => void resolveStatuses(batch)}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-ink-950">
          <div className="min-h-0 flex-1">
            <EmailView
              detail={detail}
              project={activeProject}
              loading={detailLoading}
              error={detailError}
              lookupEmail={lookupEmail}
              onLookup={(email) => {
                if (!activeProjectId) return;
                setComposer((current) => ({ ...current, to: email }));
                void lookupCustomer(activeProjectId, email);
              }}
            />
          </div>

          {actionsTaken.length > 0 && (
            <div className="shrink-0 space-y-1 border-t border-ink-800 bg-emerald-950/20 px-5 py-2.5">
              {actionsTaken.map((entry, index) => (
                <p key={index} className="text-[11px] leading-relaxed text-emerald-300">
                  ✓ {entry}
                </p>
              ))}
            </div>
          )}

          <Composer
            state={composer}
            project={activeProject}
            onChange={(patch) => setComposer((current) => ({ ...current, ...patch }))}
            onGenerate={() => void generateDraft()}
            onSend={() => void sendReply()}
            generating={generating}
            sending={sending}
            error={composerError}
            sentAt={sentAt}
            actionsTaken={actionsTaken}
            disabled={!composer.to || !activeProjectId}
          />
        </main>

        <CustomerPanel
          profile={profile}
          loading={profileLoading}
          error={profileError}
          lookupEmail={lookupEmail}
          onLookup={(email) => {
            if (!activeProjectId) return;
            setComposer((current) => ({ ...current, to: current.to || email }));
            void lookupCustomer(activeProjectId, email);
          }}
          onRefund={(order) => setModal({ type: "refund", order })}
          onCancel={(subscription) => setModal({ type: "cancel", subscription })}
          onDowngrade={(subscription) => setModal({ type: "downgrade", subscription })}
          onDelete={() => setModal({ type: "delete" })}
        />
      </div>

      {modal?.type === "refund" && profile && (
        <RefundModal
          order={modal.order}
          project={profile.project}
          customerEmail={lookupEmail ?? ""}
          onClose={() => setModal(null)}
          onDone={completeAction}
        />
      )}
      {modal?.type === "cancel" && profile && (
        <CancelModal
          subscription={modal.subscription}
          project={profile.project}
          customerEmail={lookupEmail ?? ""}
          onClose={() => setModal(null)}
          onDone={completeAction}
        />
      )}
      {modal?.type === "downgrade" && profile && (
        <DowngradeModal
          profile={profile}
          subscription={modal.subscription}
          onClose={() => setModal(null)}
          onDone={completeAction}
        />
      )}
      {modal?.type === "delete" && profile?.neon && (
        <DeleteModal profile={profile} onClose={() => setModal(null)} onDone={completeAction} />
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded-lg border border-ink-600 bg-ink-800 px-4 py-2.5 text-xs text-slate-200 shadow-2xl">
          {toast}
        </div>
      )}
    </div>
  );
}
