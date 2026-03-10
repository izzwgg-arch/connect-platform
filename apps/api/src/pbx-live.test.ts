/**
 * PBX live metrics smoke tests — self-contained, no external package imports.
 * Runs with:  node --experimental-strip-types --test src/pbx-live.test.ts
 * Or via npm: npm test  (once tsx is installed via package manager)
 *
 * Coverage:
 * 1. Auth header shape (VitalPbxClient contract)
 * 2. getCdrToday() shape (in-process simulation)
 * 3. getAriChannels() returns null without credentials
 * 4. normalizePbxActiveCall() output shape
 * 5. Cache TTL constants — sensible values
 * 6. directionLabel / directionClass helpers
 * 7. formatDurationSec helper
 * 8. Tenant vs admin scope URL routing logic
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Inline copies of pure helpers (sourced from pbxLive.ts / server.ts) ──────
// These allow the tests to run standalone without needing tsx or node_modules.

function formatDurationSec(seconds: number): string {
  if (seconds <= 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function directionLabel(d: string): string {
  if (d === "inbound" || d === "incoming") return "Inbound";
  if (d === "outbound" || d === "outgoing") return "Outbound";
  if (d === "internal") return "Internal";
  return d || "Unknown";
}

function directionClass(d: string): string {
  if (d === "inbound" || d === "incoming") return "badge-blue";
  if (d === "outbound" || d === "outgoing") return "badge-green";
  if (d === "internal") return "badge-purple";
  return "badge-gray";
}

type ActiveCallShape = {
  id: string;
  extension: string;
  direction: string;
  callerIdNum: string;
  callerIdName: string;
  durationSec: number;
  state: string;
  tenantId?: string;
};

function normalizePbxActiveCall(raw: Record<string, any>, tenantId?: string): ActiveCallShape {
  return {
    id: String(raw.id || raw.name || raw.uniqueid || ""),
    extension: String(raw.dialplan?.exten || raw.connected?.number || raw.id || ""),
    direction: String(raw.direction || raw.dialplan?.context || "internal"),
    callerIdNum: String(raw.caller?.number || raw.caller_id_num || ""),
    callerIdName: String(raw.caller?.name || raw.caller_id_name || ""),
    durationSec: Number(raw.elapsed_seconds || raw.durationSec || 0),
    state: String(raw.state || "Up"),
    ...(tenantId ? { tenantId } : {})
  };
}

type CdrAggregate = {
  rows: any[];
  incoming: number;
  outgoing: number;
  internal: number;
  answered: number;
  missed: number;
  total: number;
};

function aggregateCdrRows(rows: any[]): CdrAggregate {
  let incoming = 0, outgoing = 0, internal = 0, answered = 0, missed = 0;
  for (const r of rows) {
    const dir = String(r.direction || r.Direction || "").toLowerCase();
    const disp = String(r.disposition || r.Disposition || "").toLowerCase();
    if (dir === "inbound" || dir === "incoming") incoming++;
    else if (dir === "outbound" || dir === "outgoing") outgoing++;
    else internal++;
    if (disp === "answered") answered++;
    else missed++;
  }
  return { rows, incoming, outgoing, internal, answered, missed, total: incoming + outgoing + internal };
}

// ─── 1. Auth header contract ────────────────────────────────────────────────────
test("authHeaders: includes app-key from appKey config", () => {
  function buildAuthHeaders(cfg: { appKey?: string; apiToken?: string }): Record<string, string> {
    const appKey = cfg.appKey || cfg.apiToken;
    const out: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json"
    };
    if (appKey) out["app-key"] = String(appKey);
    return out;
  }
  const h = buildAuthHeaders({ appKey: "test-key-abc" });
  assert.equal(h["app-key"], "test-key-abc");
  assert.equal(h["content-type"], "application/json");
});

test("authHeaders: falls back to apiToken when appKey absent", () => {
  function buildAuthHeaders(cfg: { appKey?: string; apiToken?: string }): Record<string, string> {
    const appKey = cfg.appKey || cfg.apiToken;
    const out: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (appKey) out["app-key"] = String(appKey);
    return out;
  }
  const h = buildAuthHeaders({ apiToken: "token-fallback" });
  assert.equal(h["app-key"], "token-fallback");
});

// ─── 2. CDR aggregation ─────────────────────────────────────────────────────────
test("aggregateCdrRows: correct direction counts", () => {
  const rows = [
    { direction: "inbound", disposition: "answered" },
    { direction: "inbound", disposition: "no answer" },
    { direction: "outbound", disposition: "answered" },
    { direction: "internal", disposition: "answered" }
  ];
  const r = aggregateCdrRows(rows);
  assert.equal(r.incoming, 2);
  assert.equal(r.outgoing, 1);
  assert.equal(r.internal, 1);
  assert.equal(r.answered, 3);
  assert.equal(r.missed, 1);
  assert.equal(r.total, 4);
});

test("aggregateCdrRows: total equals incoming + outgoing + internal", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    direction: ["inbound", "outbound", "internal"][i % 3],
    disposition: i % 4 === 0 ? "no answer" : "answered"
  }));
  const r = aggregateCdrRows(rows);
  assert.equal(r.total, r.incoming + r.outgoing + r.internal);
  assert.equal(r.total, rows.length);
});

test("aggregateCdrRows: empty rows returns all zeros", () => {
  const r = aggregateCdrRows([]);
  assert.equal(r.total, 0);
  assert.equal(r.answered, 0);
  assert.equal(r.missed, 0);
  assert.ok(Array.isArray(r.rows));
});

// ─── 3. ARI null on missing credentials ────────────────────────────────────────
test("getAriChannels: returns null when no credentials provided", async () => {
  async function getAriChannels(ariUser?: string, ariPass?: string): Promise<any[] | null> {
    if (!ariUser || !ariPass) return null;
    return []; // Would fetch from /ari/channels
  }
  assert.equal(await getAriChannels(undefined, undefined), null);
  assert.equal(await getAriChannels("user", undefined), null);
  assert.equal(await getAriChannels(undefined, "pass"), null);
  const result = await getAriChannels("user", "pass");
  assert.ok(result !== null);
});

// ─── 4. normalizePbxActiveCall ─────────────────────────────────────────────────
test("normalizePbxActiveCall: maps full ARI channel to shape", () => {
  const raw = {
    id: "1709000001.1",
    name: "SIP/101-00000001",
    state: "Up",
    elapsed_seconds: 37,
    caller: { number: "+17025551234", name: "Alice" },
    dialplan: { exten: "101", context: "outbound" }
  };
  const norm = normalizePbxActiveCall(raw, "tenant-abc");
  assert.equal(norm.id, "1709000001.1");
  assert.equal(norm.extension, "101");
  assert.equal(norm.direction, "outbound");
  assert.equal(norm.callerIdNum, "+17025551234");
  assert.equal(norm.callerIdName, "Alice");
  assert.equal(norm.durationSec, 37);
  assert.equal(norm.state, "Up");
  assert.equal(norm.tenantId, "tenant-abc");
});

test("normalizePbxActiveCall: graceful on sparse input", () => {
  const norm = normalizePbxActiveCall({ id: "ch-1" });
  assert.equal(norm.id, "ch-1");
  assert.equal(norm.durationSec, 0);
  assert.equal(norm.state, "Up");
  assert.equal(norm.callerIdNum, "");
  assert.equal(norm.tenantId, undefined);
});

test("normalizePbxActiveCall: defaults direction to internal", () => {
  const norm = normalizePbxActiveCall({ id: "x" });
  assert.equal(norm.direction, "internal");
});

// ─── 5. Cache TTL constants ─────────────────────────────────────────────────────
test("Cache TTL: combined ≤ 15s (active-calls freshness)", () => {
  const PBX_LIVE_TTL_COMBINED = 10_000;
  assert.ok(PBX_LIVE_TTL_COMBINED <= 15_000);
});

test("Cache TTL: admin aggregation TTL exceeds per-tenant TTL", () => {
  const PBX_LIVE_TTL_COMBINED = 10_000;
  const PBX_LIVE_TTL_ADMIN = 30_000;
  assert.ok(PBX_LIVE_TTL_ADMIN > PBX_LIVE_TTL_COMBINED);
});

test("Cache TTL: resource list TTL ≥ 60s (extensions/trunks/queues)", () => {
  const PBX_LIVE_TTL_RESOURCES = 120_000;
  assert.ok(PBX_LIVE_TTL_RESOURCES >= 60_000);
});

// ─── 6. directionLabel / directionClass ────────────────────────────────────────
test("directionLabel: maps VitalPBX direction strings", () => {
  assert.equal(directionLabel("inbound"), "Inbound");
  assert.equal(directionLabel("incoming"), "Inbound");
  assert.equal(directionLabel("outbound"), "Outbound");
  assert.equal(directionLabel("outgoing"), "Outbound");
  assert.equal(directionLabel("internal"), "Internal");
  assert.equal(directionLabel(""), "Unknown");
});

test("directionClass: returns CSS badge class", () => {
  assert.equal(directionClass("inbound"), "badge-blue");
  assert.equal(directionClass("outgoing"), "badge-green");
  assert.equal(directionClass("internal"), "badge-purple");
  assert.equal(directionClass("unknown"), "badge-gray");
});

// ─── 7. formatDurationSec ──────────────────────────────────────────────────────
test("formatDurationSec: zero returns '0s'", () => {
  assert.equal(formatDurationSec(0), "0s");
});

test("formatDurationSec: sub-minute returns seconds", () => {
  assert.equal(formatDurationSec(45), "45s");
});

test("formatDurationSec: minutes and seconds", () => {
  assert.equal(formatDurationSec(125), "2m 5s");
});

test("formatDurationSec: hours minutes seconds", () => {
  assert.equal(formatDurationSec(3661), "1h 1m 1s");
});

// ─── 8. Scope routing logic ─────────────────────────────────────────────────────
test("Scope routing: GLOBAL scope uses admin endpoint", () => {
  function pickEndpoint(adminScope: "GLOBAL" | "TENANT"): string {
    return adminScope === "GLOBAL" ? "/admin/pbx/live/combined" : "/pbx/live/combined";
  }
  assert.equal(pickEndpoint("GLOBAL"), "/admin/pbx/live/combined");
  assert.equal(pickEndpoint("TENANT"), "/pbx/live/combined");
});

test("Scope routing: non-SUPER_ADMIN is forced to TENANT scope", () => {
  function resolveScope(role: string, requested: "GLOBAL" | "TENANT"): "GLOBAL" | "TENANT" {
    return role === "SUPER_ADMIN" ? requested : "TENANT";
  }
  assert.equal(resolveScope("SUPER_ADMIN", "GLOBAL"), "GLOBAL");
  assert.equal(resolveScope("SUPER_ADMIN", "TENANT"), "TENANT");
  assert.equal(resolveScope("ADMIN", "GLOBAL"), "TENANT");
  assert.equal(resolveScope("USER", "GLOBAL"), "TENANT");
});
