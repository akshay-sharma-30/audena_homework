// Trust boundaries:
//
//   1. The frontend / external API consumers authenticate to /api/calls
//      using a hardcoded Bearer token (`API_TOKEN`). Deliberately minimal
//      per the brief; production would use sessions / per-tenant keys.
//
//   2. Each telephony provider authenticates to its own /api/webhooks/{name}
//      endpoint with its real signature scheme:
//        - Twilio:  X-Twilio-Signature             HMAC-SHA1 over URL+sorted params
//        - Telnyx:  Telnyx-Signature-Ed25519       Ed25519 over `${ts}|${body}`
//                   + Telnyx-Timestamp (replay window: ±5min)
//      Verification lives in lib/providers/signing.ts so the same code
//      that signs (in the simulator producers) also verifies, and a real
//      Twilio account drops in by changing only the auth token source.

import { NextRequest, NextResponse } from "next/server";
import { verifyTelnyx, verifyTwilio } from "@/lib/providers/signing";

const API_TOKEN = process.env.API_TOKEN ?? "";
const PROVIDER_WEBHOOK_SECRET = process.env.PROVIDER_WEBHOOK_SECRET ?? "";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function checkApiAuth(req: NextRequest): NextResponse | null {
  if (!API_TOKEN) {
    return NextResponse.json(
      { error: "Server misconfigured: API_TOKEN not set" },
      { status: 500 }
    );
  }
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !timingSafeEqual(match[1], API_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function providerSecretMisconfigured(): NextResponse | null {
  if (!PROVIDER_WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "Server misconfigured: PROVIDER_WEBHOOK_SECRET not set" },
      { status: 500 }
    );
  }
  return null;
}

/**
 * Verify a Twilio webhook. The caller is responsible for having already
 * parsed the form body (Twilio HMAC operates on key-value pairs) and for
 * passing the canonical webhook URL (must match what the producer signed).
 */
export function checkTwilioAuth(
  req: NextRequest,
  url: string,
  params: Record<string, string>
): NextResponse | null {
  const misconfig = providerSecretMisconfigured();
  if (misconfig) return misconfig;
  const sig = req.headers.get("x-twilio-signature") ?? "";
  if (!verifyTwilio(url, params, sig)) {
    return NextResponse.json(
      { error: "Invalid Twilio signature" },
      { status: 401 }
    );
  }
  return null;
}

/**
 * Verify a Telnyx webhook. The caller is responsible for having captured
 * the raw body bytes (the signature is over `${timestamp}|${rawBody}`, so
 * re-stringifying parsed JSON would not produce identical bytes).
 */
export function checkTelnyxAuth(
  req: NextRequest,
  rawBody: string
): NextResponse | null {
  const misconfig = providerSecretMisconfigured();
  if (misconfig) return misconfig;
  const sig = req.headers.get("telnyx-signature-ed25519") ?? "";
  const timestamp = req.headers.get("telnyx-timestamp") ?? "";
  if (!verifyTelnyx(timestamp, rawBody, sig)) {
    return NextResponse.json(
      { error: "Invalid Telnyx signature or expired timestamp" },
      { status: 401 }
    );
  }
  return null;
}
