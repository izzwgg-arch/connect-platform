import { NextResponse } from "next/server";

/**
 * Loopback readiness for blue/green deploys (scripts/lib/deploy-portal-rollout.sh).
 * No auth, no DB — must return 200 only when the Node server accepts HTTP.
 */
export function GET() {
  return NextResponse.json(
    { ok: true },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
