"use client";

// Visualization of the AI voice-agent pool's live state. One row per endpoint.
//
// This is the headline detail of the operator UI: round-robin selection and
// per-endpoint capacity, made visible as a first-class part of the product
// rather than implementation trivia. Capacity is rendered with `▮` / `▯`
// monospace glyphs — no DOM bars, no SVG. The whole component is ~80 lines
// of JSX and reads as instrument-grade.

import { useEffect, useState } from "react";

type AgentSnapshot = {
  id: string;
  healthy: boolean;
  inflight: number;
  capacity: number;
};

export function AgentPoolStrip({ apiToken }: { apiToken: string }) {
  const [agents, setAgents] = useState<AgentSnapshot[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchOnce() {
      try {
        const res = await fetch("/api/agents/snapshot", {
          headers: { Authorization: `Bearer ${apiToken}` },
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { agents: AgentSnapshot[] };
        if (!cancelled) setAgents(data.agents);
      } catch {
        // Silent — the strip degrades to "—" rather than throwing.
      }
    }

    void fetchOnce();
    const handle = setInterval(() => void fetchOnce(), 1500);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [apiToken]);

  return (
    <div className="panel min-w-[260px]">
      <div className="panel-header">Pool</div>
      <div className="px-4 py-3 space-y-1.5">
        {agents === null ? (
          <div className="font-mono text-[11px] text-ink-700">—</div>
        ) : agents.length === 0 ? (
          <div className="font-mono text-[11px] text-ink-700">no endpoints</div>
        ) : (
          agents.map((a) => <AgentRow key={a.id} agent={a} />)
        )}
      </div>
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentSnapshot }) {
  const atCapacity = agent.inflight >= agent.capacity;
  const dotColor = !agent.healthy
    ? "text-signal-red"
    : atCapacity
    ? "text-signal-amber"
    : "text-signal-green";
  const dotPulse = agent.inflight > 0 ? "animate-pulse-soft" : "";

  // Build the capacity bar from typography. `█` filled / `░` empty —
  // both are in the universally-supported "Block Elements" Unicode range
  // (U+2580+), unlike `▮`/`▯` (U+25AE/F) which Plex Mono on Windows
  // falls back to .notdef boxes for. Reads as an analog gauge.
  const bar = Array.from({ length: agent.capacity }, (_, i) =>
    i < agent.inflight ? "█" : "░"
  ).join("");

  const barColor = !agent.healthy
    ? "text-signal-red"
    : atCapacity
    ? "text-signal-amber"
    : "text-signal-green";

  return (
    <div className="flex items-center gap-3 font-mono text-[11px]">
      <span
        className={"h-1.5 w-1.5 rounded-full bg-current " + dotColor + " " + dotPulse}
        aria-label={agent.healthy ? "healthy" : "unhealthy"}
      />
      <span className="text-ink-300 flex-1">{agent.id}</span>
      <span className={"capacity-glyph tracking-[0.12em] " + barColor}>{bar}</span>
      <span className="text-ink-500 tabular w-9 text-right">
        {agent.inflight}/{agent.capacity}
      </span>
    </div>
  );
}
