import { z } from "zod";
import { WORKFLOWS } from "@/lib/types";

// E.164-ish: optional leading +, then 8-15 digits. Loose on purpose; real
// validation belongs at the provider boundary, not the UI.
const PHONE_REGEX = /^\+?\d{8,15}$/;

export const createCallSchema = z.object({
  customerName: z.string().trim().min(1, "Customer name is required").max(120),
  phoneNumber: z
    .string()
    .trim()
    .regex(PHONE_REGEX, "Phone must be 8-15 digits, optional leading +"),
  workflow: z.enum(WORKFLOWS),
});

// Per-provider webhook payloads are validated inside their respective
// parsers (lib/providers/{twilio,telnyx}.ts) — there's no single zod schema
// that covers both, because the whole point of the per-provider layer is
// that the shapes are different.
