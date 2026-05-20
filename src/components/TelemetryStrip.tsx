"use client";

// The five KPIs an outbound-call ops manager cares about, presented as a
// NOC-style readout strip. The deliberate omission of every "vanity" metric
// (latency, error rate, queue depth) is the design — these five are the ones
// that tell you whether the system is gating expensive agent invocations
// correctly. See the README's "Designed as an operator tool" section.

type Props = {
  active: number;        // Active calls (non-terminal)
  total: number;         // All dials in the table
  agentCalls: number;    // Dials that reached a human (answeredBy === "human")
  voicemailsSaved: number; // Dials that hit a machine — agent never engaged
  poolInflight: number;  // Slots currently held across the whole pool
  poolCapacity: number;  // Total slots available across the whole pool
};

export function TelemetryStrip({
  active,
  total,
  agentCalls,
  voicemailsSaved,
  poolInflight,
  poolCapacity,
}: Props) {
  const pct = total === 0 ? 0 : Math.round((agentCalls / total) * 100);
  // Color the utilization fraction by what it tells the operator:
  //   <40%  mostly machines → good cost discipline (slate)
  //   40-70% healthy mix (amber)
  //   >70%  most dials reach the agent (green — high engagement)
  const pctColor =
    pct >= 70
      ? "text-signal-green"
      : pct >= 40
      ? "text-signal-amber"
      : "text-signal-slate";

  return (
    <div className="panel">
      <div className="panel-header flex items-center justify-between">
        <span>Telemetry</span>
        <span className="text-ink-700 normal-case tracking-normal">
          live · polled every 1.5s
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-panel-edge">
        <Kpi label="Active" value={active} sub="non-terminal" />
        <Kpi label="Dialed" value={total} sub="total dials" />
        <KpiSplit
          label="→ Agent"
          value={agentCalls}
          tail={`(${pct}%)`}
          tailColor={pctColor}
          sub="reached human"
        />
        <Kpi
          label="VM saved"
          value={voicemailsSaved}
          sub="agent never engaged"
          valueColor="text-signal-slate"
        />
        <Kpi
          label="Pool util"
          value={`${poolInflight}/${poolCapacity}`}
          sub="slots in flight"
        />
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  valueColor = "text-ink-50",
}: {
  label: string;
  value: number | string;
  sub: string;
  valueColor?: string;
}) {
  return (
    <div className="px-4 py-4">
      <div className="font-display text-[10px] font-medium uppercase tracking-[0.22em] text-ink-500">
        {label}
      </div>
      <div
        className={
          "mt-1 font-display text-3xl font-light tabular " + valueColor
        }
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-ink-500">{sub}</div>
    </div>
  );
}

function KpiSplit({
  label,
  value,
  tail,
  tailColor,
  sub,
}: {
  label: string;
  value: number;
  tail: string;
  tailColor: string;
  sub: string;
}) {
  return (
    <div className="px-4 py-4">
      <div className="font-display text-[10px] font-medium uppercase tracking-[0.22em] text-ink-500">
        {label}
      </div>
      <div className="mt-1 font-display text-3xl font-light tabular text-ink-50">
        {value}{" "}
        <span className={"text-xl " + tailColor}>{tail}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-ink-500">{sub}</div>
    </div>
  );
}
