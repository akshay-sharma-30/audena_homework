// Tests for the real signature implementations. Pure functions, no DB,
// no mocks. Covers the symmetric (Twilio HMAC) and asymmetric (Telnyx
// Ed25519) round trips plus the failure modes that matter at the
// integration boundary.

import { describe, it, expect } from "vitest";
import {
  signTelnyx,
  signTwilio,
  verifyTelnyx,
  verifyTwilio,
  TELNYX_REPLAY_WINDOW_SEC,
} from "./signing";

// ---------- Twilio HMAC-SHA1 ----------

describe("signTwilio + verifyTwilio", () => {
  const URL = "http://localhost:3000/api/webhooks/twilio";
  const PARAMS = {
    CallSid: "CA1234",
    CallStatus: "in-progress",
    AnsweredBy: "human",
  };

  it("round-trips: produced signature verifies", () => {
    const sig = signTwilio(URL, PARAMS);
    expect(verifyTwilio(URL, PARAMS, sig)).toBe(true);
  });

  it("is deterministic: same inputs → same signature", () => {
    expect(signTwilio(URL, PARAMS)).toEqual(signTwilio(URL, PARAMS));
  });

  it("is order-independent: param key order doesn't matter", () => {
    const reordered = {
      AnsweredBy: PARAMS.AnsweredBy,
      CallStatus: PARAMS.CallStatus,
      CallSid: PARAMS.CallSid,
    };
    expect(signTwilio(URL, PARAMS)).toEqual(signTwilio(URL, reordered));
  });

  it("rejects a tampered parameter value", () => {
    const sig = signTwilio(URL, PARAMS);
    expect(
      verifyTwilio(URL, { ...PARAMS, CallStatus: "completed" }, sig)
    ).toBe(false);
  });

  it("rejects a tampered URL", () => {
    const sig = signTwilio(URL, PARAMS);
    expect(verifyTwilio(URL + "?evil=true", PARAMS, sig)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyTwilio(URL, PARAMS, "")).toBe(false);
  });

  it("rejects a length-mismatched signature without timing leak", () => {
    expect(verifyTwilio(URL, PARAMS, "short")).toBe(false);
  });
});

// ---------- Telnyx Ed25519 ----------

describe("signTelnyx + verifyTelnyx", () => {
  const RAW_BODY = '{"data":{"event_type":"call.answered","payload":{}}}';
  const NOW = () => Math.floor(Date.now() / 1000).toString();

  it("round-trips: produced signature verifies", () => {
    const ts = NOW();
    const sig = signTelnyx(ts, RAW_BODY);
    expect(verifyTelnyx(ts, RAW_BODY, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = NOW();
    const sig = signTelnyx(ts, RAW_BODY);
    expect(verifyTelnyx(ts, RAW_BODY + " ", sig)).toBe(false);
  });

  it("rejects a tampered timestamp", () => {
    const ts = NOW();
    const sig = signTelnyx(ts, RAW_BODY);
    // Change ts → the payload `${ts}|${body}` changes → signature breaks.
    const tampered = (parseInt(ts, 10) + 1).toString();
    expect(verifyTelnyx(tampered, RAW_BODY, sig)).toBe(false);
  });

  it("rejects a timestamp outside the replay window (too old)", () => {
    const tooOld = (
      Math.floor(Date.now() / 1000) - TELNYX_REPLAY_WINDOW_SEC - 1
    ).toString();
    const sig = signTelnyx(tooOld, RAW_BODY);
    expect(verifyTelnyx(tooOld, RAW_BODY, sig)).toBe(false);
  });

  it("rejects a timestamp outside the replay window (too future)", () => {
    const tooFuture = (
      Math.floor(Date.now() / 1000) + TELNYX_REPLAY_WINDOW_SEC + 1
    ).toString();
    const sig = signTelnyx(tooFuture, RAW_BODY);
    expect(verifyTelnyx(tooFuture, RAW_BODY, sig)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyTelnyx(NOW(), RAW_BODY, "")).toBe(false);
  });

  it("rejects an empty/missing timestamp", () => {
    const sig = signTelnyx(NOW(), RAW_BODY);
    expect(verifyTelnyx("", RAW_BODY, sig)).toBe(false);
    expect(verifyTelnyx("not-a-number", RAW_BODY, sig)).toBe(false);
  });

  it("rejects garbage signature bytes without throwing", () => {
    expect(verifyTelnyx(NOW(), RAW_BODY, "not-base64-!!!")).toBe(false);
  });
});
