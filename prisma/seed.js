// Seed the dashboard with ~12 already-settled calls so the operator console
// looks like a real surface on first paint — not an empty shell.
//
// Idempotent: bails out if the DB already has any calls. To re-seed a dirty
// DB, delete prisma/dev.db and run `npm run setup` again.
//
// CommonJS on purpose — keeps the file zero-dep (no tsx, no ts-node) so
// `prisma db seed` runs with plain Node. Everything else in the codebase is
// strict TypeScript; this is the one tolerated exception.

const { PrismaClient } = require("@prisma/client");
const { randomBytes } = require("crypto");

const prisma = new PrismaClient();

const AGENTS = ["agent-eu-1", "agent-eu-2"];

function callSid() {
  // Twilio CallSid shape: CA + 32 hex.
  return "CA" + randomBytes(16).toString("hex");
}
function controlId() {
  // Telnyx call_control_id shape: v3: + base64url.
  return "v3:" + randomBytes(18).toString("base64url");
}

// Mix of:
//   5 completed (human)
//   3 voicemail (2 machine_end_beep, 1 machine)
//   2 no_answer
//   1 busy
//   1 failed (carrier_rejected)
// Spread across the last ~96 minutes, alternating agent endpoints.
// Mixed providerCallId formats (CA... and v3:...) makes the multi-provider
// abstraction visible without any explanation.
const SEED = [
  { name: "Maria Rossi",         phone: "+393331240867", workflow: "support",  status: "completed",  answeredBy: "human",            agent: 0, pidFn: callSid,    ageMin: 4  },
  { name: "Luca Bianchi",        phone: "+393348820114", workflow: "sales",    status: "voicemail",  answeredBy: "machine_end_beep", agent: 1, pidFn: controlId, ageMin: 9  },
  { name: "Giulia Russo",        phone: "+447700900213", workflow: "reminder", status: "completed",  answeredBy: "human",            agent: 0, pidFn: callSid,    ageMin: 14 },
  { name: "Marco Romano",        phone: "+393475561029", workflow: "support",  status: "no_answer",  answeredBy: null,               agent: 1, pidFn: controlId, ageMin: 22 },
  { name: "Sofia Esposito",      phone: "+393395518402", workflow: "sales",    status: "completed",  answeredBy: "human",            agent: 0, pidFn: callSid,    ageMin: 31 },
  { name: "Alessandro Conti",    phone: "+393428170446", workflow: "support",  status: "voicemail",  answeredBy: "machine",          agent: 1, pidFn: controlId, ageMin: 38 },
  { name: "Anna De Luca",        phone: "+447961554210", workflow: "reminder", status: "busy",       answeredBy: null,               agent: 0, pidFn: callSid,    ageMin: 47 },
  { name: "Giovanni Marino",     phone: "+393515547009", workflow: "sales",    status: "completed",  answeredBy: "human",            agent: 1, pidFn: controlId, ageMin: 53 },
  { name: "Francesca Greco",     phone: "+393664401185", workflow: "support",  status: "failed",     answeredBy: null,               agent: 0, pidFn: callSid,    ageMin: 62, errorMessage: "carrier_rejected" },
  { name: "Davide Costa",        phone: "+491631234567", workflow: "reminder", status: "voicemail",  answeredBy: "machine_end_beep", agent: 1, pidFn: controlId, ageMin: 71 },
  { name: "Chiara Ferrari",      phone: "+393881102249", workflow: "sales",    status: "completed",  answeredBy: "human",            agent: 0, pidFn: callSid,    ageMin: 83 },
  { name: "Roberto Galli",       phone: "+393282299145", workflow: "support",  status: "no_answer",  answeredBy: null,               agent: 1, pidFn: controlId, ageMin: 96 },
];

async function main() {
  const existing = await prisma.call.count();
  if (existing > 0) {
    console.log(`[seed] ${existing} call(s) already in DB — skipping. Delete prisma/dev.db and re-run \`npm run setup\` to re-seed.`);
    return;
  }

  const now = Date.now();
  for (const c of SEED) {
    const ts = new Date(now - c.ageMin * 60_000);
    await prisma.call.create({
      data: {
        customerName: c.name,
        phoneNumber: c.phone,
        workflow: c.workflow,
        status: c.status,
        answeredBy: c.answeredBy,
        errorMessage: c.errorMessage ?? null,
        providerCallId: c.pidFn(),
        agentId: AGENTS[c.agent],
        createdAt: ts,
        updatedAt: ts,
      },
    });
  }
  console.log(`[seed] inserted ${SEED.length} settled calls — dashboard will look populated on first paint.`);
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
