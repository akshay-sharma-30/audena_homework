// AMD outcome roll, shared between the Twilio and Telnyx simulators.
//
// Both providers see the same call distribution — the difference is purely
// in the webhook envelope each one emits. Keeping the roll here means a
// reviewer comparing the two providers sees identical-by-design behavior.

export type SimulatedOutcome =
  | { kind: "human"; pickupAtMs: number; completeAtMs: number }
  | { kind: "voicemail"; beep: boolean; detectedAtMs: number }
  | { kind: "no_answer"; ringoutAtMs: number }
  | { kind: "busy"; detectedAtMs: number }
  | { kind: "carrier_failure"; failureAtMs: number; reason: string };

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

const CARRIER_FAILURE_REASONS = ["carrier_rejected", "invalid_number"];

/**
 * 60% human · 15% voicemail (no beep) · 5% voicemail (beep) ·
 * 10% no_answer · 7% busy · 3% carrier failure.
 *
 * Tuned to roughly match real outbound-campaign telephony numbers so the UI
 * shows the full range of outcomes within ~10 calls placed back-to-back.
 */
export function rollOutcome(): SimulatedOutcome {
  const r = Math.random();
  if (r < 0.6) {
    const pickup = rand(2000, 4000);
    return {
      kind: "human",
      pickupAtMs: pickup,
      completeAtMs: pickup + rand(5000, 12000),
    };
  }
  if (r < 0.75) {
    return { kind: "voicemail", beep: false, detectedAtMs: rand(4000, 7000) };
  }
  if (r < 0.8) {
    return { kind: "voicemail", beep: true, detectedAtMs: rand(4000, 7000) };
  }
  if (r < 0.9) {
    return { kind: "no_answer", ringoutAtMs: rand(18000, 30000) };
  }
  if (r < 0.97) {
    return { kind: "busy", detectedAtMs: rand(500, 1500) };
  }
  return {
    kind: "carrier_failure",
    failureAtMs: rand(1500, 4000),
    reason:
      CARRIER_FAILURE_REASONS[
        Math.floor(Math.random() * CARRIER_FAILURE_REASONS.length)
      ],
  };
}

export function schedule(delayMs: number, fn: () => void): void {
  setTimeout(fn, delayMs);
}
