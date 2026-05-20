// GET /api/agents/snapshot
//
// Returns the current state of the agent pool. Polled by the UI's
// `AgentPoolStrip` so a reviewer can watch capacity move in real time as
// calls land and complete. Bearer-auth-guarded for parity with the other
// `/api/*` routes.

import { NextRequest, NextResponse } from "next/server";
import { checkApiAuth } from "@/lib/auth";
import { poolSnapshot } from "@/lib/agent-pool";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = checkApiAuth(req);
  if (unauthorized) return unauthorized;

  return NextResponse.json({ agents: poolSnapshot() });
}
