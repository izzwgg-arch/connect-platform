import { NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * GET /version — the id of the portal build this server is running.
 *
 * The client captures the value at load time and re-polls; a change means a
 * portal deploy landed and the open window is serving a stale bundle. This is
 * what lets long-lived desktop windows (open for weeks in offices) learn that
 * a deploy happened — without it, "it's deployed" reaches nobody until each
 * machine is manually restarted (2026-08-10 softphone handoff lesson).
 *
 * Unauthenticated on purpose: it leaks only an opaque build hash, and the
 * mini-dialer window must be able to ask before login completes.
 */
export const dynamic = "force-dynamic";

function readBuildId(): string {
  // Production runs the standalone server from /app (CMD node apps/portal/server.js),
  // so BUILD_ID sits at apps/portal/.next/BUILD_ID from cwd; a bare `next start`
  // finds it at .next/BUILD_ID. Dev has no BUILD_ID — report "dev" and the
  // client ignores it (never shows a reload banner off a dev server).
  for (const candidate of [
    path.join(process.cwd(), ".next", "BUILD_ID"),
    path.join(process.cwd(), "apps", "portal", ".next", "BUILD_ID"),
  ]) {
    try {
      const id = fs.readFileSync(candidate, "utf8").trim();
      if (id) return id;
    } catch {
      /* try the next candidate */
    }
  }
  return "dev";
}

export async function GET() {
  return NextResponse.json(
    { buildId: readBuildId() },
    { headers: { "cache-control": "no-store" } },
  );
}
