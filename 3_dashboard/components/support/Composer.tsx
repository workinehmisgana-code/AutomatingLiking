"use client";

import { CheckCircle2, Send, Sparkles, Wand2 } from "lucide-react";
import { useState } from "react";
import type { ProjectSummary } from "@/lib/support/types";
import { cx, ErrorNote, Spinner } from "./ui";

export type ComposerState = {
  to: string;
  cc: string;
  subject: string;
  instruction: string;
  draft: string;
  tone: "warm" | "neutral" | "firm";
  includeFacts: boolean;
};

const PRESETS = [
  "refund approved, processed today",
  "subscription cancelled, access until period end",
  "asking which email they signed up with",
  "declining refund, they used most of their credits",
  "apologising for the delay, issue is fixed",
];

export default function Composer({
  state,
  project,
  onChange,
  onGenerate,
  onSend,
  generating,
  sending,
  error,
  sentAt,
  actionsTaken,
  disabled,
}: {
  state: ComposerState;
  project: ProjectSummary | null;
  onChange: (patch: Partial<ComposerState>) => void;
  onGenerate: () => void;
  onSend: () => void;
  generating: boolean;
  sending: boolean;
  error: string | null;
  sentAt: string | null;
  actionsTaken: string[];
  disabled: boolean;
}) {
  const [showRecipients, setShowRecipients] = useState(false);

  return (
    <div className="shrink-0 border-t border-ink-800 bg-ink-900">
      <div className="space-y-3 px-5 py-4">
        <div className="flex items-center justify-between">
          <h3 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <Sparkles size={12} /> Reply
            {project && (
              <span className="ml-1 normal-case tracking-normal text-slate-600">
                as {project.label} — from <span className="font-mono">{project.email}</span>
              </span>
            )}
          </h3>
          <button
            onClick={() => setShowRecipients((value) => !value)}
            className="text-[11px] text-slate-500 hover:text-slate-300"
          >
            To: <span className="font-mono text-slate-400">{state.to || "—"}</span>
            {state.cc && <span className="ml-1 text-slate-600">+cc</span>}
          </button>
        </div>

        {showRecipients && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">To</label>
              <input
                value={state.to}
                onChange={(e) => onChange({ to: e.target.value })}
                className="field !py-1.5 font-mono text-xs"
              />
            </div>
            <div>
              <label className="label">Cc</label>
              <input
                value={state.cc}
                onChange={(e) => onChange({ cc: e.target.value })}
                placeholder="optional"
                className="field !py-1.5 font-mono text-xs"
              />
            </div>
            <div className="col-span-2">
              <label className="label">Subject</label>
              <input
                value={state.subject}
                onChange={(e) => onChange({ subject: e.target.value })}
                className="field !py-1.5 text-xs"
              />
            </div>
          </div>
        )}

        {/* Instruction → draft */}
        <div className="flex gap-2">
          <input
            value={state.instruction}
            onChange={(e) => onChange({ instruction: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && state.instruction.trim() && !generating) {
                e.preventDefault();
                onGenerate();
              }
            }}
            placeholder="In a few words: what do you want to tell them?"
            disabled={disabled}
            className="field flex-1"
          />
          <button
            onClick={onGenerate}
            disabled={disabled || generating || !state.instruction.trim()}
            className="btn btn-primary shrink-0"
          >
            {generating ? <Spinner /> : <Wand2 size={13} />}
            {generating ? "Writing…" : "Generate"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => onChange({ instruction: preset })}
              disabled={disabled}
              className="rounded-md bg-ink-850 px-2 py-1 text-[10px] text-slate-500 transition-colors hover:bg-ink-800 hover:text-slate-300 disabled:opacity-40"
            >
              {preset}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={state.includeFacts}
              onChange={(e) => onChange({ includeFacts: e.target.checked })}
              className="accent-accent"
            />
            Ground in account data
          </label>
          <label className="inline-flex items-center gap-1.5">
            Tone
            <select
              value={state.tone}
              onChange={(e) => onChange({ tone: e.target.value as ComposerState["tone"] })}
              className="rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 text-[11px] text-slate-300"
            >
              <option value="warm">Warm</option>
              <option value="neutral">Neutral</option>
              <option value="firm">Firm</option>
            </select>
          </label>
          {actionsTaken.length > 0 && (
            <span className="inline-flex items-center gap-1 text-emerald-400">
              <CheckCircle2 size={11} />
              {actionsTaken.length} action{actionsTaken.length > 1 ? "s" : ""} will be referenced
            </span>
          )}
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {/* Review before sending */}
        <div>
          <textarea
            value={state.draft}
            onChange={(e) => onChange({ draft: e.target.value })}
            placeholder="The generated reply appears here for you to review and edit before it goes out."
            rows={state.draft ? 12 : 5}
            disabled={disabled}
            className={cx("field resize-y font-sans text-[13px] leading-relaxed")}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-600">
            {sentAt ? (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <CheckCircle2 size={11} /> Sent {sentAt}
              </span>
            ) : state.draft ? (
              "Review the text, then send."
            ) : (
              "Nothing drafted yet."
            )}
          </span>
          <button
            onClick={onSend}
            disabled={disabled || sending || !state.draft.trim() || !state.to.trim()}
            className="btn btn-primary"
          >
            {sending ? <Spinner /> : <Send size={13} />}
            {sending ? "Sending…" : "Send reply"}
          </button>
        </div>
      </div>
    </div>
  );
}
