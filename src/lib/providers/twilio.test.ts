// Twilio webhook parser tests. Pure-function — no DB, no mocks needed.

import { describe, it, expect } from "vitest";
import { parseTwilioWebhook } from "./twilio";

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

describe("parseTwilioWebhook", () => {
  it("maps ringing → dialing", () => {
    expect(
      parseTwilioWebhook(form({ CallSid: "CA1", CallStatus: "ringing" }))
    ).toEqual({ providerCallId: "CA1", status: "dialing" });
  });

  it("maps in-progress with AnsweredBy=human → in_progress + human", () => {
    expect(
      parseTwilioWebhook(
        form({
          CallSid: "CA2",
          CallStatus: "in-progress",
          AnsweredBy: "human",
        })
      )
    ).toEqual({
      providerCallId: "CA2",
      status: "in_progress",
      answeredBy: "human",
    });
  });

  it("maps in-progress with AnsweredBy=machine_end_beep → voicemail (AMD shortcut)", () => {
    // The Twilio quirk: machine_* on in-progress is *the* voicemail signal.
    // Normalize to terminal voicemail so the agent is never engaged.
    expect(
      parseTwilioWebhook(
        form({
          CallSid: "CA3",
          CallStatus: "in-progress",
          AnsweredBy: "machine_end_beep",
        })
      )
    ).toEqual({
      providerCallId: "CA3",
      status: "voicemail",
      answeredBy: "machine_end_beep",
    });
  });

  it("maps no-answer → no_answer (note the dash-to-underscore)", () => {
    expect(
      parseTwilioWebhook(form({ CallSid: "CA4", CallStatus: "no-answer" }))
    ).toEqual({ providerCallId: "CA4", status: "no_answer" });
  });

  it("returns null for unknown CallStatus (acked silently by the route)", () => {
    expect(
      parseTwilioWebhook(form({ CallSid: "CA5", CallStatus: "ghost-state" }))
    ).toBeNull();
  });

  it("returns null when CallSid is missing", () => {
    expect(parseTwilioWebhook(form({ CallStatus: "ringing" }))).toBeNull();
  });
});
