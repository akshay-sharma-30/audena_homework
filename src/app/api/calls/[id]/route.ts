// PATCH /api/calls/[id]
//
// Direct status update. The brief lists this as a required backend endpoint
// separately from webhooks, presumably because some operators will want to
// manually mark a call as failed/completed. Same transition rules apply as
// the webhook — and the same compare-and-swap concurrency discipline
// (updateMany with a status predicate) — so a webhook firing the instant
// before the operator clicks can't silently lose either write.
//
// User-facing semantics differ on lost CAS:
//   - Webhook (silent worker): ack-200 with `ignored: contention`, log it.
//   - PATCH (operator UI):     409 `concurrent_update` with the fresh state.
//     The operator gets a real error and can decide what to do next.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkApiAuth } from "@/lib/auth";
import { canTransition, CallStatus, TERMINAL_STATUSES } from "@/lib/types";
import { z } from "zod";
import { CALL_STATUSES } from "@/lib/types";
import { releaseAgent } from "@/lib/agent-pool";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  status: z.enum(CALL_STATUSES),
  errorMessage: z.string().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const unauthorized = checkApiAuth(req);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const call = await prisma.call.findUnique({ where: { id: params.id } });
  if (!call) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }

  const from = call.status as CallStatus;
  const to = parsed.data.status;

  if (from === to) {
    return NextResponse.json({ call });
  }

  if (!canTransition(from, to)) {
    return NextResponse.json(
      { error: "Illegal status transition", details: { from, to } },
      { status: 409 }
    );
  }

  const result = await prisma.call.updateMany({
    where: { id: params.id, status: from },
    data: {
      status: to,
      errorMessage: parsed.data.errorMessage ?? call.errorMessage,
    },
  });

  if (result.count === 0) {
    // Concurrent update — refetch and surface the actual current state so
    // the operator (or their tooling) can re-decide.
    const fresh = await prisma.call.findUnique({ where: { id: params.id } });
    return NextResponse.json(
      {
        error: "concurrent_update",
        details: { expected: from, actual: fresh?.status ?? "deleted" },
      },
      { status: 409 }
    );
  }

  if (TERMINAL_STATUSES.has(to)) {
    releaseAgent(call.agentId);
  }

  // Return the freshly-written row.
  const updated = await prisma.call.findUnique({ where: { id: params.id } });
  return NextResponse.json({ call: updated });
}
