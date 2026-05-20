// Shared state-machine + DB-update logic for both webhook routes.
//
// `/api/webhooks/twilio` and `/api/webhooks/telnyx` each parse their native
// payload, produce a `NormalizedEvent`, and call `applyCallEvent()`. The
// state machine, the same-state short-circuit, the illegal-transition ack,
// the agent-pool release on terminal status — all live here, unaware of
// which provider produced the event.
//
// Concurrency: between findUnique and update, two webhooks for the same
// call can race past the state-machine check and both write — last-write-
// wins can silently clobber `errorMessage` or worse. We close that with a
// compare-and-swap: `updateMany({ where: { id, status: from } })` then
// check `count === 1`. On loss, we refetch once and re-evaluate (state
// might have moved to where the event is now a no-op or illegal). At most
// one retry — if we lose twice the system is in a state this webhook
// can't help and we ack-200 with `ignored: true`.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { canTransition, CallStatus, TERMINAL_STATUSES } from "@/lib/types";
import { releaseAgent } from "@/lib/agent-pool";
import type { NormalizedEvent } from "@/lib/providers/types";

type CallRow = {
  id: string;
  status: string;
  answeredBy: string | null;
  errorMessage: string | null;
  agentId: string | null;
};

/** Result of one CAS attempt — distinguishes "won" from "row moved." */
type CasOutcome = "applied" | "lost";

async function attemptCas(
  call: CallRow,
  to: CallStatus,
  answeredBy: NormalizedEvent["answeredBy"],
  errorMessage: NormalizedEvent["errorMessage"]
): Promise<CasOutcome> {
  const result = await prisma.call.updateMany({
    where: { id: call.id, status: call.status },
    data: {
      status: to,
      answeredBy: answeredBy ?? call.answeredBy,
      errorMessage: errorMessage ?? call.errorMessage,
    },
  });
  return result.count === 1 ? "applied" : "lost";
}

export async function applyCallEvent(
  event: NormalizedEvent
): Promise<NextResponse> {
  const initial = await prisma.call.findUnique({
    where: { providerCallId: event.providerCallId },
  });
  if (!initial) {
    // Unknown provider call id — misrouted or test event. Ack so retries stop.
    return NextResponse.json({ acknowledged: true, known: false });
  }

  // Re-bind to a non-nullable local so TypeScript keeps the narrow type
  // across the loop body and its reassignment from the refetch.
  let row: NonNullable<typeof initial> = initial;
  const MAX_ATTEMPTS = 2;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const from = row.status as CallStatus;
    const to = event.status;

    if (from === to) {
      return NextResponse.json({ acknowledged: true, noop: true });
    }
    if (!canTransition(from, to)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[webhook] ignoring illegal transition for ${row.id}: ${from} -> ${to}`
      );
      return NextResponse.json({ acknowledged: true, ignored: true });
    }

    const outcome = await attemptCas(
      row,
      to,
      event.answeredBy,
      event.errorMessage
    );

    if (outcome === "applied") {
      if (TERMINAL_STATUSES.has(to)) {
        releaseAgent(row.agentId);
      }
      return NextResponse.json({ acknowledged: true });
    }

    // CAS lost: the row moved under us between findUnique and updateMany.
    // Refetch and re-evaluate — but only if we have another attempt left.
    // Looping unbounded risks contention; one retry is the sweet spot.
    if (attempt + 1 < MAX_ATTEMPTS) {
      const fresh = await prisma.call.findUnique({ where: { id: row.id } });
      if (!fresh) {
        // Row deleted under us — unusual; treat as unknown.
        return NextResponse.json({ acknowledged: true, known: false });
      }
      row = fresh;
    }
  }

  // Two CAS losses in a row — give up gracefully. 200 (not 4xx) so the
  // provider doesn't retry; `ignored: contention` distinguishes this from
  // the illegal-transition `ignored: true` for log triage.
  return NextResponse.json({ acknowledged: true, ignored: "contention" });
}
