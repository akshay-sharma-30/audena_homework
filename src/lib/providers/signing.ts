// Real webhook signature schemes per provider.
//
// Twilio: HMAC-SHA1 over `URL + sorted(key+value for each form param)`,
// base64-encoded. Symmetric — same auth token used to sign and verify.
// This is the documented Twilio scheme; the only stand-in is that our
// "auth token" is the same demo PROVIDER_WEBHOOK_SECRET (in production
// every Twilio account has its own auth token from the console).
//
// Telnyx: Ed25519 signature over `${timestamp}|${rawBody}`, base64. Real
// Telnyx hands you a public key in the dashboard; for the simulator we
// generate a keypair at module load and cache it on globalThis so the
// producer (TelnyxProvider) and verifier (checkTelnyxAuth) share state.
// Replay-window check: reject if `|now - timestamp| > 300s`.

import {
  createHmac,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
} from "crypto";

const PROVIDER_WEBHOOK_SECRET = process.env.PROVIDER_WEBHOOK_SECRET ?? "";

// ---------- Twilio: HMAC-SHA1 ----------

/** Compute X-Twilio-Signature for a webhook delivery. */
export function signTwilio(
  url: string,
  params: Record<string, string>
): string {
  // Twilio's algorithm: sort param keys, concat `key+value` pairs (no
  // separator), append to the full URL, HMAC-SHA1 with the auth token,
  // base64-encode. Must use the un-decoded values exactly as sent.
  const sorted = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join("");
  return createHmac("sha1", PROVIDER_WEBHOOK_SECRET)
    .update(url + sorted)
    .digest("base64");
}

/** Constant-time verify of an X-Twilio-Signature header. */
export function verifyTwilio(
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  if (!signature) return false;
  return timingSafeEqualStr(signTwilio(url, params), signature);
}

// ---------- Telnyx: Ed25519 ----------

type KeyPair = { privateKey: KeyObject; publicKey: KeyObject };

const globalForKeys = globalThis as unknown as {
  audenaTelnyxKeys?: KeyPair;
};

function getTelnyxKeys(): KeyPair {
  if (globalForKeys.audenaTelnyxKeys) return globalForKeys.audenaTelnyxKeys;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  globalForKeys.audenaTelnyxKeys = { privateKey, publicKey };
  return globalForKeys.audenaTelnyxKeys;
}

export const TELNYX_REPLAY_WINDOW_SEC = 300;

/** Compute Telnyx-Signature-Ed25519 for a webhook delivery. */
export function signTelnyx(timestamp: string, rawBody: string): string {
  const payload = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
  return sign(null, payload, getTelnyxKeys().privateKey).toString("base64");
}

/**
 * Verify Telnyx-Signature-Ed25519. Also enforces the replay window —
 * returns false if the timestamp is missing, unparseable, or outside
 * ±5 minutes of "now."
 */
export function verifyTelnyx(
  timestamp: string,
  rawBody: string,
  signatureBase64: string
): boolean {
  if (!timestamp || !signatureBase64) return false;
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TELNYX_REPLAY_WINDOW_SEC) return false;
  try {
    const sig = Buffer.from(signatureBase64, "base64");
    const payload = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
    return verify(null, payload, getTelnyxKeys().publicKey, sig);
  } catch {
    return false;
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
