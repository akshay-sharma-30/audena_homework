// Calls API.
//
//   GET  /api/calls   List calls — keyset (cursor) pagination, newest first.
//                     Query params: ?limit=N (1..200, default 50)
//                                   ?cursor=<base64 of {createdAt, id}>
//                     Response: { calls, nextCursor: string|null, hasMore: bool }
//                     Keyset over offset means O(log n) page-N cost; offset
//                     would scan everything ahead of you.
//
//   POST /api/calls   Create a new call request. Passes through two
//                     pre-call gates (cooldown + agent capacity), then
//                     hands the call to the active provider (Twilio or
//                     Telnyx) and persists the providerCallId so subsequent
//                     webhook events can correlate.
//
// Both endpoints require `Authorization: Bearer <API_TOKEN>`.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkApiAuth } from "@/lib/auth";
import { createCallSchema } from "@/lib/validators";
import { getActiveProvider } from "@/lib/providers/factory";
import { acquireAgent, poolSnapshot, releaseAgent } from "@/lib/agent-pool";
import { consume, getLimiter, rateLimitHeaders } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Don't accept a second dial to the same number within this window. Demo-tuned
// short — long enough that double-clicking the form triggers a visible 409,
// short enough that ordinary use doesn't feel restrictive.
const COOLDOWN_MS = 5_000;

// Rate limit on the cost-bearing endpoint. 10/sec burst, 60/min sustained.
// Per-token (per-API-key in production); a real deployment would also key
// by tenant or by recipient phone. In-memory bucket; Redis-backed in
// production — see trade-offs.
const POST_LIMITER = getLimiter("POST /api/calls", {
  capacity: 10,
  refillPerSec: 1, // 60 per minute sustained
});

function tokenFromAuthHeader(req: NextRequest): string {
  // Pre-auth: scope the limiter by the presented token. The auth check
  // below rejects bad tokens, so unauthenticated traffic gets bucketed
  // together under "anonymous" — protecting against unauth-token-spraying
  // probes from chewing the legitimate-traffic bucket.
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "anonymous";
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Cursor = { createdAt: string; id: string };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    );
    if (
      typeof decoded?.createdAt === "string" &&
      typeof decoded?.id === "string"
    ) {
      return decoded as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const unauthorized = checkApiAuth(req);
  if (unauthorized) return unauthorized;

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const rawCursor = url.searchParams.get("cursor");

  const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : DEFAULT_LIMIT;
  if (rawLimit && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
    return NextResponse.json(
      { error: "Invalid limit (must be a positive integer)" },
      { status: 400 }
    );
  }
  const limit = Math.min(parsedLimit || DEFAULT_LIMIT, MAX_LIMIT);

  // Decode cursor if present; reject malformed cursors explicitly rather
  // than silently treating them as no-cursor.
  let cursor: Cursor | null = null;
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) {
      return NextResponse.json(
        { error: "Invalid cursor" },
        { status: 400 }
      );
    }
  }

  // Fetch one extra row to determine `hasMore` without a separate count query.
  const calls = await prisma.call.findMany({
    where: cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            // Tiebreaker for rows with identical createdAt: take id < cursor.id
            // (since both order-by columns are desc).
            {
              createdAt: new Date(cursor.createdAt),
              id: { lt: cursor.id },
            },
          ],
        }
      : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = calls.length > limit;
  const items = hasMore ? calls.slice(0, limit) : calls;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
      : null;

  return NextResponse.json({ calls: items, nextCursor, hasMore });
}

export async function POST(req: NextRequest) {
  // Rate-limit check runs BEFORE auth so a token-spraying attacker can't
  // bypass the bucket by sending invalid Authorization headers. The key is
  // the presented token (or "anonymous"), so legitimate traffic is isolated
  // from probe traffic.
  const rl = consume(POST_LIMITER, tokenFromAuthHeader(req));
  const rlHeaders = rateLimitHeaders(POST_LIMITER, rl);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: rlHeaders }
    );
  }

  const unauthorized = checkApiAuth(req);
  if (unauthorized) {
    // Propagate rate-limit headers even on auth failures so clients can
    // pace themselves regardless of which gate rejected them.
    for (const [k, v] of Object.entries(rlHeaders)) {
      unauthorized.headers.set(k, v);
    }
    return unauthorized;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createCallSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Gate 1: per-recipient cooldown. Catches both an active call and a
  // recently-terminal call. Cheapest possible anti-spam primitive — protects
  // us from a flaky client double-submitting, and a real operator from
  // accidentally dialing the same person twice in a row.
  const recent = await prisma.call.findFirst({
    where: {
      phoneNumber: parsed.data.phoneNumber,
      OR: [
        { status: { in: ["pending", "dialing", "in_progress"] } },
        { updatedAt: { gt: new Date(Date.now() - COOLDOWN_MS) } },
      ],
    },
    select: { id: true, status: true, updatedAt: true },
  });
  if (recent) {
    return NextResponse.json(
      {
        error: "recipient_cooldown_active",
        recentCallId: recent.id,
        cooldownMs: COOLDOWN_MS,
      },
      { status: 409, headers: { "Retry-After": "5" } }
    );
  }

  // Gate 2: agent capacity. If every endpoint in the pool is either
  // unhealthy or at capacity, refuse the call before we burn a DB row on
  // something we can't actually run.
  const agent = acquireAgent();
  if (!agent) {
    return NextResponse.json(
      { error: "no_agent_capacity", snapshot: poolSnapshot() },
      { status: 503, headers: { "Retry-After": "5" } }
    );
  }

  // Persist as `pending` first (with the agent already pinned). We want a
  // row in our DB before we hand anything to the provider, so a failure
  // between provider-call and DB-insert can't leave us with an orphaned
  // phone call we don't know about. In real life this is also where we'd
  // reserve an Idempotency-Key.
  const call = await prisma.call.create({
    data: {
      customerName: parsed.data.customerName,
      phoneNumber: parsed.data.phoneNumber,
      workflow: parsed.data.workflow,
      status: "pending",
      agentId: agent.id,
    },
  });

  try {
    const { providerCallId } = getActiveProvider().placeCall();
    const updated = await prisma.call.update({
      where: { id: call.id },
      data: { providerCallId },
    });
    return NextResponse.json({ call: updated }, { status: 201 });
  } catch (err) {
    // Return the agent slot — otherwise a flapping provider would slowly
    // drain the pool one acquisition at a time without ever doing any work.
    releaseAgent(agent.id);
    await prisma.call.update({
      where: { id: call.id },
      data: {
        status: "failed",
        errorMessage:
          err instanceof Error ? err.message : "provider_handoff_failed",
      },
    });
    return NextResponse.json(
      { error: "Failed to hand call to provider" },
      { status: 502 }
    );
  }
}
