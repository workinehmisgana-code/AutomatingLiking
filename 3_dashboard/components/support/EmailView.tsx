"use client";

import { Code2, FileText, Paperclip, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { InboxDetail, ProjectSummary } from "@/lib/support/types";
import { cx, ErrorNote, formatDate, IntentBadge, ProjectBadge, Spinner } from "./ui";

export default function EmailView({
  detail,
  project,
  loading,
  error,
  lookupEmail,
  onLookup,
}: {
  detail: InboxDetail | null;
  project: ProjectSummary | null;
  loading: boolean;
  error: string | null;
  lookupEmail: string | null;
  onLookup: (email: string) => void;
}) {
  const [mode, setMode] = useState<"text" | "html">("text");

  useEffect(() => {
    setMode(detail?.text ? "text" : detail?.html ? "html" : "text");
  }, [detail?.uid, detail?.text, detail?.html]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-slate-500">
        <Spinner /> Loading message…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-600">
        <FileText size={28} strokeWidth={1.3} />
        <p className="text-xs">Select an email to see it here.</p>
      </div>
    );
  }

  const otherEmails = detail.mentionedEmails.filter((e) => e !== detail.from.address);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-ink-800 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold leading-snug text-slate-100">{detail.subject}</h2>
          <div className="flex shrink-0 items-center gap-1.5">
            {project && <ProjectBadge label={project.label} tag={project.tag} />}
            <IntentBadge intent={detail.intent} />
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className="text-slate-300">{detail.from.name || detail.from.address}</span>
          <button
            onClick={() => onLookup(detail.from.address)}
            className={cx(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors",
              lookupEmail === detail.from.address
                ? "bg-accent/20 text-accent"
                : "bg-ink-850 text-slate-400 hover:bg-ink-800 hover:text-slate-200",
            )}
            title="Look this address up in Polar + Neon"
          >
            {detail.from.address}
            <Search size={10} />
          </button>
          <span>{formatDate(detail.date, true)}</span>
          {project && (
            <span className="text-slate-600">
              received at <span className="font-mono">{project.email}</span>
            </span>
          )}
        </div>

        {otherEmails.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-slate-600">Also mentioned:</span>
            {otherEmails.map((email) => (
              <button
                key={email}
                onClick={() => onLookup(email)}
                className={cx(
                  "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                  lookupEmail === email
                    ? "bg-accent/20 text-accent"
                    : "bg-ink-850 text-slate-400 hover:bg-ink-800 hover:text-slate-200",
                )}
              >
                {email}
              </button>
            ))}
          </div>
        )}

        {detail.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {detail.attachments.map((attachment, index) => (
              <span
                key={`${attachment.filename}-${index}`}
                className="inline-flex items-center gap-1 rounded bg-ink-850 px-2 py-0.5 text-[10px] text-slate-400"
              >
                <Paperclip size={9} />
                {attachment.filename}
                <span className="text-slate-600">{Math.ceil(attachment.size / 1024)} KB</span>
              </span>
            ))}
          </div>
        )}

        {detail.html && detail.text && (
          <div className="mt-3 flex gap-1">
            <ModeButton active={mode === "text"} onClick={() => setMode("text")} icon={<FileText size={11} />}>
              Plain text
            </ModeButton>
            <ModeButton active={mode === "html"} onClick={() => setMode("html")} icon={<Code2 size={11} />}>
              Rendered
            </ModeButton>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {mode === "html" && detail.html ? (
          // Sandboxed: remote email HTML never gets script access or same-origin.
          <iframe
            title="Email body"
            sandbox=""
            srcDoc={`<body style="margin:0;padding:12px;background:#fff;color:#111;font:14px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif">${detail.html}</body>`}
            className="h-[60vh] w-full rounded-lg border border-ink-700 bg-white"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-slate-300">
            {detail.text || detail.snippet || "(empty message)"}
          </pre>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
        active ? "bg-ink-700 text-slate-200" : "bg-ink-850 text-slate-500 hover:text-slate-300",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
