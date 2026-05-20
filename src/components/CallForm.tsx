"use client";

import { useEffect, useState } from "react";
import { WORKFLOWS, WORKFLOW_LABELS, type Workflow } from "@/lib/types";
import type { Call } from "./CallsApp";

type FieldErrors = Partial<
  Record<"customerName" | "phoneNumber" | "workflow", string>
>;

type GateState =
  | { kind: "none" }
  | { kind: "cooldown"; secondsRemaining: number; recentCallId: string }
  | { kind: "saturated"; secondsRemaining: number }
  | { kind: "error"; message: string };

export function CallForm({
  apiToken,
  onCreated,
}: {
  apiToken: string;
  onCreated: (call: Call) => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [workflow, setWorkflow] = useState<Workflow>("support");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [gate, setGate] = useState<GateState>({ kind: "none" });

  // Live countdown for cooldown / saturated readouts. Operator-tool framing:
  // these aren't error messages, they're instruments showing system state.
  useEffect(() => {
    if (gate.kind !== "cooldown" && gate.kind !== "saturated") return;
    if (gate.secondsRemaining <= 0) {
      setGate({ kind: "none" });
      return;
    }
    const t = setTimeout(
      () =>
        setGate((g) =>
          g.kind === "cooldown" || g.kind === "saturated"
            ? { ...g, secondsRemaining: g.secondsRemaining - 1 }
            : g
        ),
      1000
    );
    return () => clearTimeout(t);
  }, [gate]);

  async function handleSubmit() {
    setSubmitting(true);
    setFieldErrors({});
    setGate({ kind: "none" });

    try {
      const res = await fetch("/api/calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ customerName, phoneNumber, workflow }),
      });

      if (res.status === 400) {
        const body = await res.json();
        const fieldErrs = body?.details?.fieldErrors ?? {};
        setFieldErrors({
          customerName: fieldErrs.customerName?.[0],
          phoneNumber: fieldErrs.phoneNumber?.[0],
          workflow: fieldErrs.workflow?.[0],
        });
        return;
      }

      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        if (body?.error === "recipient_cooldown_active") {
          const secs = Math.max(1, Math.ceil((body.cooldownMs ?? 5000) / 1000));
          setGate({
            kind: "cooldown",
            secondsRemaining: secs,
            recentCallId: body.recentCallId ?? "—",
          });
          return;
        }
      }

      if (res.status === 503) {
        const body = await res.json().catch(() => ({}));
        if (body?.error === "no_agent_capacity") {
          setGate({ kind: "saturated", secondsRemaining: 5 });
          return;
        }
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setGate({
          kind: "error",
          message: body?.error ?? `Request failed (${res.status})`,
        });
        return;
      }

      const { call } = (await res.json()) as { call: Call };
      onCreated(call);
      setCustomerName("");
      setPhoneNumber("");
      setWorkflow("support");
    } catch (err) {
      setGate({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">New Call</div>
      <div className="p-4 space-y-4">
        <div>
          <label htmlFor="customerName" className="field-label">
            Customer
          </label>
          <input
            id="customerName"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Maria Rossi"
            className="field-input font-sans"
            aria-invalid={Boolean(fieldErrors.customerName)}
            aria-describedby={
              fieldErrors.customerName ? "customerName-err" : undefined
            }
            disabled={submitting}
          />
          {fieldErrors.customerName && (
            <p
              id="customerName-err"
              className="mt-1.5 font-mono text-[11px] text-signal-red"
            >
              {fieldErrors.customerName}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="phoneNumber" className="field-label">
            Phone
          </label>
          <input
            id="phoneNumber"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+393331234567"
            className="field-input"
            inputMode="tel"
            aria-invalid={Boolean(fieldErrors.phoneNumber)}
            aria-describedby={
              fieldErrors.phoneNumber ? "phoneNumber-err" : undefined
            }
            disabled={submitting}
          />
          {fieldErrors.phoneNumber && (
            <p
              id="phoneNumber-err"
              className="mt-1.5 font-mono text-[11px] text-signal-red"
            >
              {fieldErrors.phoneNumber}
            </p>
          )}
        </div>

        <div>
          <span className="field-label">Workflow</span>
          <div className="grid grid-cols-3 gap-1.5">
            {WORKFLOWS.map((w) => {
              const selected = workflow === w;
              return (
                <button
                  type="button"
                  key={w}
                  onClick={() => setWorkflow(w)}
                  disabled={submitting}
                  className={
                    "border px-2 py-2 font-display text-[10px] font-medium uppercase tracking-[0.18em] transition-colors " +
                    (selected
                      ? "border-signal-amber text-signal-amber bg-signal-amber/8"
                      : "border-panel-edge text-ink-500 hover:border-ink-300 hover:text-ink-300")
                  }
                  aria-pressed={selected}
                >
                  {WORKFLOW_LABELS[w]}
                </button>
              );
            })}
          </div>
        </div>

        <GateReadout gate={gate} />

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !customerName || !phoneNumber}
          className="btn-dial"
        >
          {submitting ? "Placing…" : "Dial"}
        </button>
      </div>
    </div>
  );
}

function GateReadout({ gate }: { gate: GateState }) {
  if (gate.kind === "none") return null;

  if (gate.kind === "cooldown") {
    return (
      <div className="border border-signal-amber/40 bg-signal-amber/8 px-3 py-2 font-mono text-[11px] text-signal-amber">
        ⏱ COOLDOWN ·{" "}
        <span className="tabular">{gate.secondsRemaining}s</span> — same number
        was just dialed
        <div className="mt-0.5 text-ink-500">
          ref: <span className="text-ink-300">{gate.recentCallId}</span>
        </div>
      </div>
    );
  }
  if (gate.kind === "saturated") {
    return (
      <div className="border border-signal-amber/40 bg-signal-amber/8 px-3 py-2 font-mono text-[11px] text-signal-amber">
        ▮ POOL SATURATED · retry in{" "}
        <span className="tabular">{gate.secondsRemaining}s</span>
        <div className="mt-0.5 text-ink-500">
          all agent endpoints at capacity
        </div>
      </div>
    );
  }
  return (
    <div className="border border-signal-red/40 bg-signal-red/8 px-3 py-2 font-mono text-[11px] text-signal-red">
      ✕ {gate.message}
    </div>
  );
}
