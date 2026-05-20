// Telnyx webhook parser tests. Pure-function — no DB, no mocks needed.

import { describe, it, expect } from "vitest";
import { parseTelnyxWebhook } from "./telnyx";

function env(eventType: string, payload: Record<string, unknown>) {
  return {
    data: {
      event_type: eventType,
      occurred_at: "2026-05-20T10:00:00Z",
      payload: { call_control_id: "v3:abc", ...payload },
    },
  };
}

describe("parseTelnyxWebhook", () => {
  it("maps call.initiated → dialing", () => {
    expect(parseTelnyxWebhook(env("call.initiated", {}))).toEqual({
      providerCallId: "v3:abc",
      status: "dialing",
    });
  });

  it("maps call.answered → in_progress", () => {
    expect(parseTelnyxWebhook(env("call.answered", {}))).toEqual({
      providerCallId: "v3:abc",
      status: "in_progress",
    });
  });

  it("maps call.hangup + normal_clearing → completed", () => {
    expect(
      parseTelnyxWebhook(env("call.hangup", { hangup_cause: "normal_clearing" }))
    ).toEqual({ providerCallId: "v3:abc", status: "completed" });
  });

  it("maps call.hangup + user_busy → busy", () => {
    expect(
      parseTelnyxWebhook(env("call.hangup", { hangup_cause: "user_busy" }))
    ).toEqual({ providerCallId: "v3:abc", status: "busy" });
  });

  it("maps call.hangup + no_answer → no_answer", () => {
    expect(
      parseTelnyxWebhook(env("call.hangup", { hangup_cause: "no_answer" }))
    ).toEqual({ providerCallId: "v3:abc", status: "no_answer" });
  });

  it("maps machine.detection.ended + answering_machine → voicemail (beep)", () => {
    // Telnyx's `answering_machine` means a beep was detected — safe to
    // leave a message. We surface it as machine_end_beep so the UI shows
    // the BEEP distinction.
    expect(
      parseTelnyxWebhook(
        env("call.machine.detection.ended", { result: "answering_machine" })
      )
    ).toEqual({
      providerCallId: "v3:abc",
      status: "voicemail",
      answeredBy: "machine_end_beep",
    });
  });

  it("maps machine.detection.ended + machine → voicemail (no beep)", () => {
    expect(
      parseTelnyxWebhook(
        env("call.machine.detection.ended", { result: "machine" })
      )
    ).toEqual({
      providerCallId: "v3:abc",
      status: "voicemail",
      answeredBy: "machine",
    });
  });

  it("maps machine.detection.ended + human → in_progress + human", () => {
    // Telnyx's AMD can also confirm a human pickup; surface that explicitly
    // so analytics see "human" as the answerer.
    expect(
      parseTelnyxWebhook(
        env("call.machine.detection.ended", { result: "human" })
      )
    ).toEqual({
      providerCallId: "v3:abc",
      status: "in_progress",
      answeredBy: "human",
    });
  });

  it("returns null for events we don't act on (call.bridged, etc.)", () => {
    expect(parseTelnyxWebhook(env("call.bridged", {}))).toBeNull();
  });

  it("returns null when the envelope is malformed", () => {
    expect(parseTelnyxWebhook({ data: {} })).toBeNull();
    expect(parseTelnyxWebhook(null)).toBeNull();
    expect(parseTelnyxWebhook({})).toBeNull();
  });
});
