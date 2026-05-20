"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CallForm } from "./CallForm";
import { CallsTable } from "./CallsTable";
import { AgentPoolStrip } from "./AgentPoolStrip";
import { TelemetryStrip } from "./TelemetryStrip";
import { TERMINAL_STATUSES, type CallStatus } from "@/lib/types";

// Bearer token is read from a public env var so the demo "just works". A
// real app would never put the API token in the browser — the frontend
// would hit a session-authenticated BFF route that forwards to the API.
// (See the README "What I'd do with more time" section.)
const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN ?? "audena-demo-token";

export type Call = {
  id: string;
  customerName: string;
  phoneNumber: string;
  workflow: string;
  status: CallStatus;
  answeredBy: string | null;
  agentId: string | null;
  errorMessage: string | null;
  providerCallId: string | null;
  createdAt: string;
  updatedAt: string;
};

type AgentSnapshot = {
  id: string;
  healthy: boolean;
  inflight: number;
  capacity: number;
};

export function CallsApp() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [olderCalls, setOlderCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loadMoreCursor, setLoadMoreCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [poolUtil, setPoolUtil] = useState<{ inflight: number; capacity: number }>(
    { inflight: 0, capacity: 0 }
  );

  // Page 1 (most recent up to N) — polled. The "older" pages live in a
  // separate slice so polling doesn't blow away rows the user explicitly
  // loaded via "Load older."
  const fetchCalls = useCallback(async () => {
    try {
      const res = await fetch("/api/calls?limit=50", {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`GET /api/calls -> ${res.status}`);
      }
      const data = (await res.json()) as {
        calls: Call[];
        nextCursor: string | null;
        hasMore: boolean;
      };
      setCalls(data.calls);
      // The "Load older" cursor mirrors page 1's nextCursor — but only
      // until the user has clicked through to older pages. After that we
      // keep advancing loadMoreCursor independently (clicks own it).
      if (loadMoreCursor === null && olderCalls.length === 0) {
        setLoadMoreCursor(data.hasMore ? data.nextCursor : null);
      }
      setFetchError(null);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [loadMoreCursor, olderCalls.length]);

  const loadMore = useCallback(async () => {
    if (!loadMoreCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/calls?limit=50&cursor=${encodeURIComponent(loadMoreCursor)}`,
        {
          headers: { Authorization: `Bearer ${API_TOKEN}` },
          cache: "no-store",
        }
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        calls: Call[];
        nextCursor: string | null;
        hasMore: boolean;
      };
      setOlderCalls((prev) => [...prev, ...data.calls]);
      setLoadMoreCursor(data.hasMore ? data.nextCursor : null);
    } finally {
      setLoadingMore(false);
    }
  }, [loadMoreCursor, loadingMore]);

  const fetchPool = useCallback(async () => {
    try {
      const res = await fetch("/api/agents/snapshot", {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { agents: AgentSnapshot[] };
      const inflight = data.agents.reduce((s, a) => s + a.inflight, 0);
      const capacity = data.agents.reduce((s, a) => s + a.capacity, 0);
      setPoolUtil({ inflight, capacity });
    } catch {
      // Silent — the telemetry strip degrades to 0/0.
    }
  }, []);

  useEffect(() => {
    void fetchCalls();
    void fetchPool();
  }, [fetchCalls, fetchPool]);

  // Auto-refresh while any call is non-terminal. Stops polling once every
  // call has settled — a small touch that means the tab isn't hammering the
  // server forever. The pool endpoint piggybacks on the same interval.
  // (Computed off page-1 only; older pages don't trigger polling restarts.)
  const hasActive = useMemo(
    () => calls.some((c) => !TERMINAL_STATUSES.has(c.status)),
    [calls]
  );
  useEffect(() => {
    if (!hasActive) return;
    const handle = setInterval(() => {
      void fetchCalls();
      void fetchPool();
    }, 1500);
    return () => clearInterval(handle);
  }, [hasActive, fetchCalls, fetchPool]);

  const onCreated = useCallback((created: Call) => {
    // Optimistic insert at the top; the next poll reconciles.
    setCalls((prev) => [created, ...prev]);
    // Capacity just dropped by one slot — refresh immediately so the pool
    // strip reflects the new state without waiting for the 1.5s tick.
    void fetchPool();
  }, [fetchPool]);

  // Merge page-1 + any older pages loaded by the user, deduping by id in
  // case polling and load-more overlap on a boundary row.
  const visibleCalls = useMemo(() => {
    const seen = new Set<string>();
    const out: Call[] = [];
    for (const c of [...calls, ...olderCalls]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  }, [calls, olderCalls]);

  // Telemetry: the five role-specific KPIs.
  const totalCalls = visibleCalls.length;
  const agentCalls = visibleCalls.filter((c) => c.answeredBy === "human").length;
  const voicemailsSaved = visibleCalls.filter((c) => c.status === "voicemail").length;
  const activeCalls = visibleCalls.filter(
    (c) => !TERMINAL_STATUSES.has(c.status)
  ).length;

  return (
    <div className="space-y-6">
      <TelemetryStrip
        active={activeCalls}
        total={totalCalls}
        agentCalls={agentCalls}
        voicemailsSaved={voicemailsSaved}
        poolInflight={poolUtil.inflight}
        poolCapacity={poolUtil.capacity}
      />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div>
          <CallForm apiToken={API_TOKEN} onCreated={onCreated} />
        </div>
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-[10px] font-medium uppercase tracking-[0.22em] text-ink-500">
              Recent Calls
            </h2>
            <span className="font-mono text-[11px] text-ink-500">
              {hasActive ? (
                <>
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-signal-green animate-pulse-soft mr-1.5 align-middle" />
                  live · 1.5s
                </>
              ) : calls.length > 0 ? (
                "settled"
              ) : (
                "—"
              )}
            </span>
          </div>
          {fetchError && (
            <div className="border border-signal-red/40 bg-signal-red/8 px-3 py-2 font-mono text-[11px] text-signal-red">
              ✕ {fetchError}
            </div>
          )}
          <CallsTable calls={visibleCalls} loading={loading} />
          {loadMoreCursor && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="font-display text-[10px] uppercase tracking-[0.22em] text-ink-500 hover:text-signal-amber disabled:opacity-50 transition-colors"
              >
                {loadingMore ? "Loading…" : "↓ Load older"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Re-export so page.tsx can render the pool strip in the header next to the
// app title (keeps the header self-contained but lets CallsApp own the data).
export { AgentPoolStrip };
export const APP_API_TOKEN = API_TOKEN;
