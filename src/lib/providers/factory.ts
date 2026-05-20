// Provider selection. One-line env switch:
//
//   CALL_PROVIDER=twilio npm run dev    (default)
//   CALL_PROVIDER=telnyx npm run dev
//
// The selected provider is cached on `globalThis` so HMR doesn't reset the
// instance (and the cached `cursor` for round-robin behavior — though both
// current providers are stateless beyond per-call scheduling).

import { TelnyxProvider } from "./telnyx";
import { TwilioProvider } from "./twilio";
import type { CallProvider, ProviderName } from "./types";

const globalForProvider = globalThis as unknown as {
  audenaActiveProvider?: CallProvider;
};

function build(name: string): CallProvider {
  const normalized = name.toLowerCase() as ProviderName;
  if (normalized === "telnyx") return new TelnyxProvider();
  return new TwilioProvider();
}

export function getActiveProvider(): CallProvider {
  if (globalForProvider.audenaActiveProvider) {
    return globalForProvider.audenaActiveProvider;
  }
  const name = process.env.CALL_PROVIDER ?? "twilio";
  const provider = build(name);
  if (process.env.NODE_ENV !== "production") {
    globalForProvider.audenaActiveProvider = provider;
  }
  return provider;
}
