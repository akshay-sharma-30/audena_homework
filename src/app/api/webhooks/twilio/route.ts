// POST /api/webhooks/twilio
//
// Auth: real X-Twilio-Signature verification (HMAC-SHA1 over canonical URL
// + sorted form-param `key+value` pairs). Body is `application/x-www-form-
// urlencoded`, parsed via `req.formData()` — Twilio's signature operates
// on the key-value parsing, not raw bytes, so this is correct.
//
// We compute the canonical URL from `PUBLIC_BASE_URL` rather than reading
// it off the request, because in production the request may arrive through
// a load balancer / proxy that rewrites Host. The producer signed against
// the canonical URL; the verifier must use the same.

import { NextRequest, NextResponse } from "next/server";
import { checkTwilioAuth } from "@/lib/auth";
import { applyCallEvent } from "@/lib/call-state";
import { parseTwilioWebhook } from "@/lib/providers/twilio";

export const dynamic = "force-dynamic";

const WEBHOOK_URL =
  (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000") +
  "/api/webhooks/twilio";

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form body" }, { status: 400 });
  }

  // Snapshot the form into a plain object for HMAC computation. Files are
  // not part of the signed payload — for our calls webhooks the body is
  // always plain strings.
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    params[k] = typeof v === "string" ? v : v.name;
  }

  const unauthorized = checkTwilioAuth(req, WEBHOOK_URL, params);
  if (unauthorized) return unauthorized;

  const event = parseTwilioWebhook(form);
  if (!event) {
    return NextResponse.json({ acknowledged: true, ignored: "unparseable" });
  }

  return applyCallEvent(event);
}
