// Domain types for the calls system.
//
// SQLite does not support native enums, so the canonical list of allowed
// values lives here and is enforced by zod on both ingress (API) and the
// state-transition helper below. Keep this file as the single source of truth.

export const CALL_STATUSES = [
  "pending",     // Created in our DB; not yet handed to the provider.
  "dialing",     // Handed to the provider; ringing the customer.
  "in_progress", // Customer picked up (human); call is live with the agent.
  "completed",   // Terminal: human-answered call ended normally.
  "voicemail",   // Terminal: AMD detected a machine (with or without beep).
  "no_answer",   // Terminal: ring-out, nobody picked up.
  "busy",        // Terminal: line was busy.
  "failed",      // Terminal: provider/carrier returned an error.
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

// Anything that doesn't reach "in_progress" doesn't reach the AI agent —
// that's the entire AMD-gate semantics encoded in the type system.
export const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  "completed",
  "voicemail",
  "no_answer",
  "busy",
  "failed",
]);

export const ANSWERED_BY = ["human", "machine", "machine_end_beep"] as const;
export type AnsweredBy = (typeof ANSWERED_BY)[number];

export const WORKFLOWS = ["support", "sales", "reminder"] as const;
export type Workflow = (typeof WORKFLOWS)[number];

export const WORKFLOW_LABELS: Record<Workflow, string> = {
  support: "Support",
  sales: "Sales",
  reminder: "Reminder",
};

// Allowed status transitions. The webhook will reject updates that don't
// satisfy this graph, which protects us from out-of-order or replayed events.
//
//   pending  -> dialing | failed
//   dialing  -> in_progress | voicemail | no_answer | busy | failed
//   in_progress -> completed | failed
//   <terminal> -> (nothing)
//
// Note: `dialing -> voicemail` and `dialing -> no_answer` skip in_progress
// on purpose — AMD fires before we'd ever bridge the agent. Conversely,
// `in_progress -> voicemail` is illegal: if we got to in_progress, a human
// was on the line.
const TRANSITIONS: Record<CallStatus, ReadonlySet<CallStatus>> = {
  pending: new Set(["dialing", "failed"]),
  dialing: new Set(["in_progress", "voicemail", "no_answer", "busy", "failed"]),
  in_progress: new Set(["completed", "failed"]),
  completed: new Set(),
  voicemail: new Set(),
  no_answer: new Set(),
  busy: new Set(),
  failed: new Set(),
};

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  return TRANSITIONS[from].has(to);
}
