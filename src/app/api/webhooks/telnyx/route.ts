// POST /api/webhooks/telnyx
//
// Auth: real Telnyx-Signature-Ed25519 verification + Telnyx-Timestamp
// replay-window check (±5min). The signature is over the EXACT raw body
// bytes — we must `req.text()` before `JSON.parse`, otherwise the re-
// serialized JSON wouldn't match what the producer signed.

import { NextRequest, NextResponse } from "next/server";
import { checkTelnyxAuth } from "@/lib/auth";
import { applyCallEvent } from "@/lib/call-state";
import { parseTelnyxWebhook } from "@/lib/providers/telnyx";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const unauthorized = checkTelnyxAuth(req, rawBody);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = parseTelnyxWebhook(body);
  if (!event) {
    return NextResponse.json({ acknowledged: true, ignored: "unhandled_event" });
  }

  return applyCallEvent(event);
}
