// Tests for the shared call-state updater.
//
// Now exercises the compare-and-swap path: `updateMany` returning
// `{count: 1}` is the win case; `{count: 0}` triggers a refetch + one
// retry; two losses in a row → 200 with `ignored: contention`.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindUnique, mockUpdateMany, mockReleaseAgent } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockReleaseAgent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    call: { findUnique: mockFindUnique, updateMany: mockUpdateMany },
  },
}));

vi.mock("@/lib/agent-pool", () => ({
  releaseAgent: mockReleaseAgent,
}));

import { applyCallEvent } from "@/lib/call-state";
import type { NormalizedEvent } from "@/lib/providers/types";

function fakeCall(
  overrides: Partial<{
    status: string;
    agentId: string | null;
    answeredBy: string | null;
  }> = {}
) {
  return {
    id: "call_123",
    providerCallId: "prov_abc",
    customerName: "Test",
    phoneNumber: "+393331234567",
    workflow: "support",
    status: "pending",
    answeredBy: null as string | null,
    agentId: "agent-eu-1" as string | null,
    errorMessage: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    providerCallId: "prov_abc",
    status: "dialing",
    ...overrides,
  };
}

beforeEach(() => {
  mockFindUnique.mockReset();
  mockUpdateMany.mockReset();
  mockReleaseAgent.mockReset();
});

describe("applyCallEvent", () => {
  it("accepts a legal transition and updates the call (CAS wins)", async () => {
    mockFindUnique.mockResolvedValue(fakeCall());
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await applyCallEvent(event({ status: "dialing" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ acknowledged: true });
    expect(body.ignored).toBeUndefined();
    expect(body.noop).toBeUndefined();
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "call_123", status: "pending" }, // CAS predicate
        data: expect.objectContaining({ status: "dialing" }),
      })
    );
    expect(mockReleaseAgent).not.toHaveBeenCalled();
  });

  it("is idempotent: redelivery short-circuits as noop without a second write", async () => {
    mockFindUnique.mockResolvedValueOnce(fakeCall({ status: "pending" }));
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    await applyCallEvent(event({ status: "dialing" }));

    mockFindUnique.mockResolvedValueOnce(fakeCall({ status: "dialing" }));
    const res2 = await applyCallEvent(event({ status: "dialing" }));

    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ acknowledged: true, noop: true });
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects illegal transitions and does not write to the DB", async () => {
    mockFindUnique.mockResolvedValue(fakeCall({ status: "completed" }));

    const res = await applyCallEvent(event({ status: "dialing" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      acknowledged: true,
      ignored: true,
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockReleaseAgent).not.toHaveBeenCalled();
  });

  it("acknowledges events for unknown providerCallId without erroring", async () => {
    mockFindUnique.mockResolvedValue(null);

    const res = await applyCallEvent(
      event({ providerCallId: "prov_unknown", status: "dialing" })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      acknowledged: true,
      known: false,
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockReleaseAgent).not.toHaveBeenCalled();
  });

  it("voicemail transition persists answeredBy and releases the agent slot", async () => {
    mockFindUnique.mockResolvedValue(
      fakeCall({ status: "dialing", agentId: "agent-eu-2" })
    );
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await applyCallEvent(
      event({ status: "voicemail", answeredBy: "machine_end_beep" })
    );

    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "voicemail",
          answeredBy: "machine_end_beep",
        }),
      })
    );
    expect(mockReleaseAgent).toHaveBeenCalledTimes(1);
    expect(mockReleaseAgent).toHaveBeenCalledWith("agent-eu-2");
  });

  it("no_answer transition releases the agent without setting answeredBy", async () => {
    mockFindUnique.mockResolvedValue(
      fakeCall({ status: "dialing", agentId: "agent-eu-1" })
    );
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await applyCallEvent(event({ status: "no_answer" }));

    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "no_answer", answeredBy: null }),
      })
    );
    expect(mockReleaseAgent).toHaveBeenCalledWith("agent-eu-1");
  });

  it("releaseAgent is safe to call when the call row has a null agentId", async () => {
    mockFindUnique.mockResolvedValue(
      fakeCall({ status: "dialing", agentId: null })
    );
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await applyCallEvent(event({ status: "busy" }));

    expect(res.status).toBe(200);
    expect(mockReleaseAgent).toHaveBeenCalledWith(null);
  });

  // ---------- CAS contention ----------

  it("CAS race: row moved under us, refetch shows new state is illegal → ignored", async () => {
    // Initial read: status=dialing. CAS attempted dialing→in_progress.
    // Lost: the row was concurrently moved to `completed`. Refetch shows
    // completed; from `completed` no transition is legal → ack ignored.
    mockFindUnique
      .mockResolvedValueOnce(fakeCall({ status: "dialing" }))
      .mockResolvedValueOnce(fakeCall({ status: "completed" }));
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await applyCallEvent(event({ status: "in_progress" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      acknowledged: true,
      ignored: true,
    });
    // Only ONE updateMany call — the retry's state-machine check fails
    // before any write attempt.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockReleaseAgent).not.toHaveBeenCalled();
  });

  it("CAS race: row moved to target state under us → noop", async () => {
    mockFindUnique
      .mockResolvedValueOnce(fakeCall({ status: "dialing" }))
      .mockResolvedValueOnce(fakeCall({ status: "in_progress" }));
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });

    const res = await applyCallEvent(event({ status: "in_progress" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ acknowledged: true, noop: true });
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("CAS race: legal-from-fresh-state, retry succeeds", async () => {
    // First fetch: dialing. CAS lost. Refetch: still dialing (race already
    // resolved). Second CAS attempts the same transition and wins.
    mockFindUnique
      .mockResolvedValueOnce(fakeCall({ status: "dialing" }))
      .mockResolvedValueOnce(fakeCall({ status: "dialing" }));
    mockUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const res = await applyCallEvent(event({ status: "in_progress" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ acknowledged: true });
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("CAS race: two losses in a row → ack with ignored:contention", async () => {
    mockFindUnique
      .mockResolvedValueOnce(fakeCall({ status: "dialing" }))
      .mockResolvedValueOnce(fakeCall({ status: "dialing" }));
    mockUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    const res = await applyCallEvent(event({ status: "in_progress" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      acknowledged: true,
      ignored: "contention",
    });
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
  });
});
