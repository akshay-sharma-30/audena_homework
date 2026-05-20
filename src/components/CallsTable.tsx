"use client";

import { WORKFLOW_LABELS, type CallStatus, type Workflow } from "@/lib/types";
import type { Call } from "./CallsApp";

// Each status maps to one of four color buckets. Outcomes that mean "no human"
// (voicemail / no_answer / busy) all use slate — visually grouped as "the
// agent never engaged" so an operator can read the AMD distribution at a
// glance.
const STATUS_COLOR: Record<CallStatus, string> = {
  pending: "text-ink-500",
  dialing: "text-signal-amber",
  in_progress: "text-signal-green",
  completed: "text-signal-green",
  voicemail: "text-signal-slate",
  no_answer: "text-signal-slate",
  busy: "text-signal-slate",
  failed: "text-signal-red",
};

const STATUS_LABEL: Record<CallStatus, string> = {
  pending: "PENDING",
  dialing: "DIALING",
  in_progress: "IN PROGRESS",
  completed: "COMPLETED",
  voicemail: "VOICEMAIL",
  no_answer: "NO ANSWER",
  busy: "BUSY",
  failed: "FAILED",
};

// Live (non-terminal) states get a halo glow on the dot. Two states qualify.
const ACTIVE_STATES: ReadonlySet<CallStatus> = new Set(["dialing", "in_progress"]);

const ANSWERED_LABEL: Record<string, string> = {
  human: "HUMAN",
  machine: "MACHINE",
  machine_end_beep: "MACHINE+BEEP",
};

export function CallsTable({
  calls,
  loading,
}: {
  calls: Call[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="panel">
        <div className="px-4 py-8 font-mono text-[11px] text-ink-500">
          loading…
        </div>
      </div>
    );
  }
  if (calls.length === 0) {
    return (
      <div className="panel">
        <div className="px-4 py-12 text-center">
          <div className="font-display text-[10px] uppercase tracking-[0.22em] text-ink-700">
            no calls yet
          </div>
          <div className="mt-2 text-[12px] text-ink-500">
            place a call from the panel on the left.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-panel-edge text-left font-display text-[10px] uppercase tracking-[0.18em] text-ink-500">
            <th className="px-4 py-3 font-medium">Customer</th>
            <th className="px-4 py-3 font-medium">Phone</th>
            <th className="px-4 py-3 font-medium">Workflow</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Outcome</th>
            <th className="px-4 py-3 font-medium">Agent</th>
            <th className="px-4 py-3 font-medium text-right">Created</th>
          </tr>
        </thead>
        <tbody className="row-stagger">
          {calls.map((c) => (
            <tr
              key={c.id}
              className="border-t border-panel-edge hover:bg-panel-hover transition-colors animate-fade-in-up"
            >
              <td className="px-4 py-3 text-ink-50">{c.customerName}</td>
              <td className="px-4 py-3 font-mono text-ink-300 tabular text-[13px]">
                {c.phoneNumber}
              </td>
              <td className="px-4 py-3 font-mono text-ink-500 text-[12px]">
                {WORKFLOW_LABELS[c.workflow as Workflow] ?? c.workflow}
              </td>
              <td className="px-4 py-3">
                <StatusPill status={c.status} errorMessage={c.errorMessage} />
              </td>
              <td className="px-4 py-3">
                <OutcomeCell status={c.status} answeredBy={c.answeredBy} />
              </td>
              <td className="px-4 py-3 font-mono text-[11px] text-ink-500">
                {c.agentId ?? "—"}
              </td>
              <td className="px-4 py-3 text-right font-mono text-[11px] text-ink-500 tabular">
                {formatRelative(c.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({
  status,
  errorMessage,
}: {
  status: CallStatus;
  errorMessage: string | null;
}) {
  const color = STATUS_COLOR[status];
  const isActive = ACTIVE_STATES.has(status);
  return (
    <span
      className={
        "pill " +
        color +
        " border-current/40 " +
        (isActive ? "pill-active " : "")
      }
      style={{ borderColor: "currentColor" }}
      title={
        status === "failed" && errorMessage ? `Reason: ${errorMessage}` : undefined
      }
    >
      <span className="pill-dot" />
      <span style={{ opacity: 0.9 }}>{STATUS_LABEL[status]}</span>
      {status === "failed" && errorMessage && (
        <span className="font-mono opacity-60 normal-case tracking-normal">
          · {errorMessage}
        </span>
      )}
    </span>
  );
}

function OutcomeCell({
  status,
  answeredBy,
}: {
  status: CallStatus;
  answeredBy: string | null;
}) {
  if (answeredBy && ANSWERED_LABEL[answeredBy]) {
    const isHuman = answeredBy === "human";
    return (
      <span
        className={
          "font-display text-[10px] uppercase tracking-[0.14em] " +
          (isHuman ? "text-signal-green" : "text-signal-slate")
        }
      >
        {ANSWERED_LABEL[answeredBy]}
      </span>
    );
  }
  if (status === "no_answer" || status === "busy") {
    return (
      <span className="font-display text-[10px] uppercase tracking-[0.14em] text-signal-slate">
        NO PICKUP
      </span>
    );
  }
  return <span className="font-mono text-[11px] text-ink-700">—</span>;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}
