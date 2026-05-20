// Tests for POST /api/calls — the cost-bearing endpoint.
//
// Covers the two pre-call gates (cooldown + capacity) and the agent slot
// lifecycle (acquired on entry, released on hand-off failure). The webhook
// release path is covered separately in webhooks/provider/route.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockCallFindFirst,
  mockCallFindMany,
  mockCallCreate,
  mockCallUpdate,
  mockAcquireAgent,
  mockReleaseAgent,
  mockPlaceCall,
} = vi.hoisted(() => ({
  mockCallFindFirst: vi.fn(),
  mockCallFindMany: vi.fn(),
  mockCallCreate: vi.fn(),
  mockCallUpdate: vi.fn(),
  mockAcquireAgent: vi.fn(),
  mockReleaseAgent: vi.fn(),
  mockPlaceCall: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    call: {
      findFirst: mockCallFindFirst,
      findMany: mockCallFindMany,
      create: mockCallCreate,
      update: mockCallUpdate,
    },
  },
}));

vi.mock("@/lib/agent-pool", () => ({
  acquireAgent: mockAcquireAgent,
  releaseAgent: mockReleaseAgent,
  poolSnapshot: vi.fn(() => [
    { id: "agent-eu-1", healthy: true, inflight: 3, capacity: 3 },
    { id: "agent-eu-2", healthy: true, inflight: 3, capacity: 3 },
  ]),
}));

vi.mock("@/lib/providers/factory", () => ({
  getActiveProvider: () => ({ name: "twilio", placeCall: mockPlaceCall }),
}));

import { GET, POST } from "@/app/api/calls/route";
import { __resetAllLimitersForTests } from "@/lib/rate-limit";

const TOKEN = "test-api-token";

function makeRequest(
  body: unknown,
  opts: { token?: string | null } = {}
): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const tok = opts.token === undefined ? TOKEN : opts.token;
  if (tok !== null) headers["Authorization"] = `Bearer ${tok}`;
  return new NextRequest("http://localhost:3000/api/calls", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const validBody = {
  customerName: "Maria Rossi",
  phoneNumber: "+393331234567",
  workflow: "support",
};

beforeEach(() => {
  // Limiter state lives on globalThis across tests — reset before each run
  // so the 11th-request-rate-limit test isn't flaky from sibling tests
  // having burned tokens off the same bucket.
  __resetAllLimitersForTests();
  mockCallFindFirst.mockReset();
  mockCallFindMany.mockReset();
  mockCallCreate.mockReset();
  mockCallUpdate.mockReset();
  mockAcquireAgent.mockReset();
  mockReleaseAgent.mockReset();
  mockPlaceCall.mockReset();
  // Default: nothing recent, plenty of capacity, hand-off succeeds.
  mockCallFindFirst.mockResolvedValue(null);
  mockCallFindMany.mockResolvedValue([]);
  mockAcquireAgent.mockReturnValue({
    id: "agent-eu-1",
    healthy: true,
    inflight: 1,
  });
  mockPlaceCall.mockReturnValue({ providerCallId: "prov_xyz" });
  mockCallCreate.mockImplementation(async ({ data }) => ({
    id: "call_new",
    providerCallId: null,
    answeredBy: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  }));
  mockCallUpdate.mockImplementation(async ({ data, where }) => ({
    id: where.id,
    customerName: "Maria Rossi",
    phoneNumber: "+393331234567",
    workflow: "support",
    status: "pending",
    answeredBy: null,
    errorMessage: null,
    agentId: "agent-eu-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  }));
});

describe("POST /api/calls", () => {
  it("recipient cooldown: returns 409 when the same number was called recently", async () => {
    mockCallFindFirst.mockResolvedValue({
      id: "call_prior",
      status: "completed",
      updatedAt: new Date(),
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "recipient_cooldown_active",
      recentCallId: "call_prior",
    });
    expect(res.headers.get("Retry-After")).toBe("5");

    // No agent acquired, no row created — the gate fires first.
    expect(mockAcquireAgent).not.toHaveBeenCalled();
    expect(mockCallCreate).not.toHaveBeenCalled();
  });

  it("no capacity: returns 503 when every agent in the pool is saturated", async () => {
    mockAcquireAgent.mockReturnValue(null);

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ error: "no_agent_capacity" });
    expect(body.snapshot).toBeDefined();
    expect(res.headers.get("Retry-After")).toBe("5");

    // We must not burn a DB row on a call we can't actually run.
    expect(mockCallCreate).not.toHaveBeenCalled();
  });

  it("happy path: acquires an agent, persists the row with agentId, returns 201", async () => {
    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(201);
    expect(mockAcquireAgent).toHaveBeenCalledTimes(1);
    // Row created with the acquired agent pinned to it.
    expect(mockCallCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending",
          agentId: "agent-eu-1",
        }),
      })
    );
    // Then updated with the providerCallId post-hand-off.
    expect(mockCallUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ providerCallId: "prov_xyz" }),
      })
    );
    // No release on the happy path — that fires from the webhook handler
    // when a terminal status arrives.
    expect(mockReleaseAgent).not.toHaveBeenCalled();
  });

  it("hand-off failure: releases the acquired agent and marks the row failed", async () => {
    mockPlaceCall.mockImplementation(() => {
      throw new Error("provider exploded");
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(502);

    // Critical assertion: the agent slot we acquired is returned to the pool.
    // Without this, a flapping provider would slowly drain the pool one
    // acquisition at a time without ever doing any work.
    expect(mockReleaseAgent).toHaveBeenCalledTimes(1);
    expect(mockReleaseAgent).toHaveBeenCalledWith("agent-eu-1");

    // The row is updated to `failed` with the error message.
    expect(mockCallUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          errorMessage: "provider exploded",
        }),
      })
    );
  });
});

// ---------- GET /api/calls — keyset pagination ----------

function makeGet(url: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

function fakeRow(i: number, ts: Date) {
  return {
    id: `call_${i}`,
    customerName: `User ${i}`,
    phoneNumber: "+1555000" + String(i).padStart(4, "0"),
    workflow: "support",
    status: "completed",
    providerCallId: `CA${i}`,
    answeredBy: "human",
    errorMessage: null,
    agentId: "agent-eu-1",
    createdAt: ts,
    updatedAt: ts,
  };
}

describe("GET /api/calls (keyset pagination)", () => {
  it("returns calls with nextCursor:null and hasMore:false when there are no more rows", async () => {
    // Page of 3 with limit=50 → take=51, returns 3 → fewer than limit → no more.
    mockCallFindMany.mockResolvedValueOnce([
      fakeRow(1, new Date("2026-05-20T10:00:00Z")),
      fakeRow(2, new Date("2026-05-20T09:00:00Z")),
      fakeRow(3, new Date("2026-05-20T08:00:00Z")),
    ]);

    const res = await GET(makeGet("http://localhost:3000/api/calls"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calls).toHaveLength(3);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("returns hasMore:true + a usable nextCursor when there's more data", async () => {
    // limit=2 → take=3. Returning 3 means hasMore.
    const rows = [
      fakeRow(1, new Date("2026-05-20T10:00:00Z")),
      fakeRow(2, new Date("2026-05-20T09:00:00Z")),
      fakeRow(3, new Date("2026-05-20T08:00:00Z")),
    ];
    mockCallFindMany.mockResolvedValueOnce(rows);

    const res = await GET(makeGet("http://localhost:3000/api/calls?limit=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calls).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBeTruthy();

    // The cursor should decode to the LAST visible row (call_2, not the
    // unreturned call_3) so a second fetch picks up at call_3 exactly.
    const decoded = JSON.parse(
      Buffer.from(body.nextCursor, "base64url").toString("utf8")
    );
    expect(decoded.id).toBe("call_2");
  });

  it("respects the cursor on a follow-up page", async () => {
    mockCallFindMany.mockResolvedValueOnce([
      fakeRow(3, new Date("2026-05-20T08:00:00Z")),
    ]);
    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: "2026-05-20T09:00:00.000Z",
        id: "call_2",
      }),
      "utf8"
    ).toString("base64url");

    const res = await GET(
      makeGet(`http://localhost:3000/api/calls?limit=2&cursor=${encodeURIComponent(cursor)}`)
    );
    expect(res.status).toBe(200);

    // Verify findMany was called with the keyset where-clause derived from
    // the cursor (the OR-tiebreaker pattern, not OFFSET).
    expect(mockCallFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { createdAt: { lt: new Date("2026-05-20T09:00:00.000Z") } },
            {
              createdAt: new Date("2026-05-20T09:00:00.000Z"),
              id: { lt: "call_2" },
            },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    );
  });

  it("rejects a malformed cursor with 400 (not silent fallback to no-cursor)", async () => {
    const res = await GET(
      makeGet("http://localhost:3000/api/calls?cursor=not-base64-or-json")
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/cursor/i);
  });

  it("rate limit: 11th rapid POST from the same token returns 429 with Retry-After", async () => {
    // Limiter is capacity=10. The first 10 calls go through, the 11th hits
    // the bucket-empty branch.
    for (let i = 0; i < 10; i++) {
      const res = await POST(makeRequest({
        customerName: `RL ${i}`,
        phoneNumber: `+15550009${String(i).padStart(3, "0")}`,
        workflow: "support",
      }));
      expect(res.status).toBe(201);
    }
    const overflow = await POST(makeRequest({
      customerName: "Overflow",
      phoneNumber: "+15550009999",
      workflow: "support",
    }));
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("Retry-After")).toBeTruthy();
    expect(overflow.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(overflow.headers.get("X-RateLimit-Remaining")).toBe("0");
    const body = await overflow.json();
    expect(body).toMatchObject({ error: "rate_limited" });
  });

  it("caps limit at MAX_LIMIT and rejects non-positive values", async () => {
    mockCallFindMany.mockResolvedValueOnce([]);
    const tooBig = await GET(
      makeGet("http://localhost:3000/api/calls?limit=500")
    );
    expect(tooBig.status).toBe(200);
    // findMany should have been called with take ≤ 201 (MAX_LIMIT 200 + 1).
    expect(mockCallFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 201 })
    );

    const negative = await GET(
      makeGet("http://localhost:3000/api/calls?limit=-5")
    );
    expect(negative.status).toBe(400);
  });
});
