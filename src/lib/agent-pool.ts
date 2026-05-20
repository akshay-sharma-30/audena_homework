// In-process simulation of a pool of AI voice-agent endpoints.
//
// In production this is a load balancer over N agent URLs with periodic
// health checks (see JT-Aptask's `getNextHealthyCallAgentUrl()` round-robin
// over CALL_AGENT_URL_1, CALL_AGENT_URL_2). Here we keep the same shape but
// in-memory: round-robin selection, per-endpoint capacity, simulated health
// flipping.
//
// State lives on `globalThis` for the same reason as the Prisma client: Next.js
// HMR otherwise resets `inflight` counters on every code change, which would
// be visibly broken during demos.

const CAPACITY = 3;
const DEFAULT_ENDPOINTS = "agent-eu-1,agent-eu-2";

export type Agent = {
  id: string;
  healthy: boolean;
  inflight: number;
};

export type AgentSnapshot = Agent & { capacity: number };

type Pool = { agents: Agent[]; cursor: number };

const globalForPool = globalThis as unknown as {
  audenaAgentPool?: Pool;
  audenaAgentPoolTimer?: NodeJS.Timeout;
};

function init(): Pool {
  const ids = (process.env.AGENT_ENDPOINTS ?? DEFAULT_ENDPOINTS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    agents: ids.map((id) => ({ id, healthy: true, inflight: 0 })),
    cursor: 0,
  };
}

// Module-private — callers should go through acquireAgent/releaseAgent/
// poolSnapshot, never mutate the buckets directly.
const pool: Pool = globalForPool.audenaAgentPool ?? init();
if (process.env.NODE_ENV !== "production") {
  globalForPool.audenaAgentPool = pool;
}

// Simulated chaos: every 60s, each healthy agent has a 5% chance of going
// unhealthy, and each unhealthy agent has a 50% chance of recovering.
// Don't double-schedule across HMR reloads.
if (!globalForPool.audenaAgentPoolTimer) {
  globalForPool.audenaAgentPoolTimer = setInterval(() => {
    for (const a of pool.agents) {
      a.healthy = a.healthy ? Math.random() > 0.05 : Math.random() < 0.5;
    }
  }, 60_000);
}

/**
 * Reserve an agent slot. Round-robin starting from the rotating cursor;
 * skip endpoints that are unhealthy or at capacity. Returns `null` when no
 * endpoint can accept the call — callers should respond 503 with Retry-After.
 */
export function acquireAgent(): Agent | null {
  for (let i = 0; i < pool.agents.length; i++) {
    const a = pool.agents[(pool.cursor + i) % pool.agents.length];
    if (a.healthy && a.inflight < CAPACITY) {
      pool.cursor = (pool.cursor + i + 1) % pool.agents.length;
      a.inflight++;
      return a;
    }
  }
  return null;
}

/**
 * Return a previously-acquired slot to the pool. Safe to call with `null` or
 * an unknown id — both are no-ops, which lets the webhook handler always
 * release without first checking whether an agent was actually assigned.
 */
export function releaseAgent(id: string | null | undefined): void {
  if (!id) return;
  const a = pool.agents.find((x) => x.id === id);
  if (a) a.inflight = Math.max(0, a.inflight - 1);
}

export function poolSnapshot(): AgentSnapshot[] {
  return pool.agents.map((a) => ({
    id: a.id,
    healthy: a.healthy,
    inflight: a.inflight,
    capacity: CAPACITY,
  }));
}
