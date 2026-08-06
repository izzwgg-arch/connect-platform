/**
 * Guard: the worker's direct-FCM call-wake channel must be WIRED, not just coded.
 *
 * ⛔ THE BUG THIS EXISTS FOR (found 2026-08-06)
 * The worker gained a direct-FCM sender on 2026-07-31 — `sendPushToUserDevices`
 * checks `isFcmDirectConfigured()` and sends call-critical pushes straight to
 * Google, bypassing the Expo relay that Samsung deprioritizes. It never sent a
 * single one. The api service had `FCM_SERVICE_ACCOUNT_PATH` **and** a mount
 * exposing the credential; the worker got neither. So `isFcmDirectConfigured()`
 * returned false on every push and 100% of INCOMING_CALL / INCOMING_CALL_WAKE /
 * INVITE_CANCELED / INVITE_CLAIMED fell back to the relay — including for the
 * devices that had reported a native FCM token specifically to avoid it.
 *
 * Verified live in production before the fix:
 *   docker exec app-worker-1 sh -c 'echo $FCM_SERVICE_ACCOUNT_PATH'  ->  (empty)
 *   docker inspect app-worker-1 --format '{{range .Mounts}}...'      ->  chat-attachments only
 *
 * The failure mode is SILENT and per-push by design (fail-closed → Expo), which
 * is why six days passed unnoticed. Code alone cannot assert this; the wiring
 * lives in compose. So assert the compose wiring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPOSE_PATH = join(__dirname, "..", "..", "..", "docker-compose.app.yml");

/**
 * Minimal indentation-aware slice of one top-level service block. Avoids adding
 * a YAML dependency to the worker for a single structural assertion.
 */
function serviceBlock(yaml: string, service: string): string {
  const lines = yaml.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => new RegExp(`^  ${service}:\\s*$`).test(l));
  assert.ok(startIdx >= 0, `service "${service}" not found in docker-compose.app.yml`);
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // A new top-level key (2-space indent, non-blank) ends the block.
    if (/^ {2}\S/.test(line)) break;
    if (/^\S/.test(line) && line.trim() !== "") break;
    out.push(line);
  }
  return out.join("\n");
}

const compose = readFileSync(COMPOSE_PATH, "utf8");
const worker = serviceBlock(compose, "worker");
const api = serviceBlock(compose, "api");

test("worker declares FCM_SERVICE_ACCOUNT_PATH", () => {
  assert.match(
    worker,
    /FCM_SERVICE_ACCOUNT_PATH:/,
    "worker has direct-FCM code but no credential path — every call-critical push silently falls back to the Expo relay",
  );
});

test("worker's FCM path points inside a path it actually mounts", () => {
  const match = worker.match(/FCM_SERVICE_ACCOUNT_PATH:\s*\$\{FCM_SERVICE_ACCOUNT_PATH:-([^}]+)\}/);
  assert.ok(match, "expected FCM_SERVICE_ACCOUNT_PATH with an explicit default");
  const defaultPath = match[1].trim();

  // Collect container-side mount destinations from the worker's volumes list.
  // A compose short-syntax volume is `source:destination[:mode]` — split on ':'
  // rather than regex-capturing, so an absolute source path containing no colon
  // and a trailing `:ro` cannot be confused for the destination.
  const destinations = worker
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && l.includes(":"))
    .map((l) => l.slice(2).split(":"))
    .filter((parts) => parts.length >= 2)
    .map((parts) => parts[1].trim())
    .filter(Boolean);
  assert.ok(destinations.length > 0, "worker declares no volumes");

  const covered = destinations.some((dest) => defaultPath.startsWith(dest.replace(/\/$/, "")));
  assert.ok(
    covered,
    `FCM_SERVICE_ACCOUNT_PATH default "${defaultPath}" is not inside any worker mount ` +
      `(${destinations.join(", ")}) — the file will not exist in the container and ` +
      `isFcmDirectConfigured() will return false forever`,
  );
});

test("worker mounts the credential directory read-only", () => {
  assert.match(
    worker,
    /-\s*\/opt\/connectcomms\/env:[^\s:]+:ro/,
    "the credential mount must be read-only — the worker only ever reads it",
  );
});

test("api and worker resolve the same credential file", () => {
  const pick = (block: string) =>
    block.match(/FCM_SERVICE_ACCOUNT_PATH:\s*\$\{FCM_SERVICE_ACCOUNT_PATH:-([^}]+)\}/)?.[1]?.trim();
  const apiPath = pick(api);
  const workerPath = pick(worker);
  assert.ok(apiPath, "api must declare FCM_SERVICE_ACCOUNT_PATH");
  assert.equal(
    workerPath,
    apiPath,
    "api and worker must read the SAME service account — divergence means one of " +
      "them silently degrades to the Expo relay",
  );
});
