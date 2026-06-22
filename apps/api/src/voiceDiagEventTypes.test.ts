import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Phase 7c regression guard. The iOS cold-start "answers but doesn't connect"
// debugging was blocked because voice-diag event types drifted across three
// sources:
//   1. Prisma enum  VoiceDiagEventType  (packages/db/prisma/schema.prisma)
//   2. API Zod enum at POST /voice/diag/event (apps/api/src/server.ts)
//   3. Mobile client union in postVoiceDiagEvent (apps/mobile/src/api/client.ts)
// A type accepted by Zod but absent from the Prisma enum throws
// PrismaClientValidationError (HTTP 500) at persist time; a type the client emits
// but Zod rejects is a silent 400. These tests pin all three in sync.

// Resolve the monorepo root by walking up from the test runner's cwd (avoids
// import.meta/__dirname so this compiles under the API's tsconfig module setting).
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const repoRoot = findRepoRoot();

const schemaPath = path.join(repoRoot, "packages/db/prisma/schema.prisma");
const serverPath = path.join(repoRoot, "apps/api/src/server.ts");
const clientPath = path.join(repoRoot, "apps/mobile/src/api/client.ts");

function upperSnakeTokens(slice: string): Set<string> {
  return new Set(
    [...slice.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]),
  );
}

function prismaEnumValues(name: string): Set<string> {
  const src = readFileSync(schemaPath, "utf8");
  const m = new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`).exec(src);
  assert.ok(m, `enum ${name} not found in schema.prisma`);
  const values = m![1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
  return new Set(values);
}

// The z.enum([...]) for POST /voice/diag/event uniquely contains
// ANSWER_DEFERRED_AWAITING_SIP, so we bound the array around that marker.
function zodDiagEventTypes(): Set<string> {
  const src = readFileSync(serverPath, "utf8");
  const marker = src.indexOf("ANSWER_DEFERRED_AWAITING_SIP");
  assert.ok(marker > -1, "diag z.enum marker not found in server.ts");
  const start = src.lastIndexOf("z.enum([", marker);
  const end = src.indexOf("])", marker);
  assert.ok(start > -1 && end > -1, "could not bound the diag z.enum array");
  return upperSnakeTokens(src.slice(start, end));
}

// The mobile client union sits between `type:` and `payload?` in postVoiceDiagEvent.
function clientUnionTypes(): Set<string> {
  const src = readFileSync(clientPath, "utf8");
  const fnIdx = src.indexOf("postVoiceDiagEvent");
  assert.ok(fnIdx > -1, "postVoiceDiagEvent not found in client.ts");
  const typeIdx = src.indexOf("type:", fnIdx);
  const payloadIdx = src.indexOf("payload?", typeIdx);
  assert.ok(typeIdx > -1 && payloadIdx > -1, "could not bound client union");
  return upperSnakeTokens(src.slice(typeIdx, payloadIdx));
}

test("every API diag z.enum type exists in the Prisma VoiceDiagEventType enum (no 500 on persist)", () => {
  const prisma = prismaEnumValues("VoiceDiagEventType");
  const zod = zodDiagEventTypes();
  const missing = [...zod].filter((t) => !prisma.has(t));
  assert.deepEqual(
    missing,
    [],
    `API accepts diag types missing from the Prisma enum (would 500): ${missing.join(", ")}`,
  );
});

test("every mobile client diag type is accepted by the API (no 400) and storable by Prisma (no 500)", () => {
  const prisma = prismaEnumValues("VoiceDiagEventType");
  const zod = zodDiagEventTypes();
  const client = clientUnionTypes();
  const rejectedByApi = [...client].filter((t) => !zod.has(t));
  const unstorable = [...client].filter((t) => !prisma.has(t));
  assert.deepEqual(
    rejectedByApi,
    [],
    `client emits diag types the API rejects (400): ${rejectedByApi.join(", ")}`,
  );
  assert.deepEqual(
    unstorable,
    [],
    `client emits diag types Prisma cannot store (500): ${unstorable.join(", ")}`,
  );
});

test("cold-start answer telemetry types are present end-to-end", () => {
  const prisma = prismaEnumValues("VoiceDiagEventType");
  const zod = zodDiagEventTypes();
  const required = [
    "UI_SHOWN",
    "PUSH_RECEIVED",
    "INCOMING_PUSH_RECEIVED",
    "CALLKEEP_ANSWER_TAPPED",
    "INVITE_RESTORED",
    "SIP_ANSWER_REQUESTED",
    "ANSWER_DEFERRED_AWAITING_SIP",
    "ANSWER_DEFERRED_EXECUTED",
    "ANSWER_DEFERRED_TIMEOUT",
    "ANSWER_DEFERRED_STALE_CALL",
  ];
  for (const t of required) {
    assert.ok(prisma.has(t), `Prisma enum missing required cold-start type ${t}`);
    assert.ok(zod.has(t), `API z.enum missing required cold-start type ${t}`);
  }
});
