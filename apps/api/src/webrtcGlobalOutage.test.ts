import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateGlobalWebrtcOutage,
  GLOBAL_WEBRTC_OUTAGE_TYPE,
} from "@connect/shared/webrtcGlobalOutageAlerts";

test("GLOBAL_WEBRTC_OUTAGE type is stable", () => {
  assert.equal(GLOBAL_WEBRTC_OUTAGE_TYPE, "GLOBAL_WEBRTC_OUTAGE");
});

test("platform outage routes require can_manage_global_settings permission", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.ts");
  const src = fs.readFileSync(serverPath, "utf8");
  assert.match(src, /\/admin\/webrtc-platform\/outage\/active/);
  assert.match(src, /\/admin\/webrtc-platform\/health/);
  assert.match(src, /prefix: "\/admin\/webrtc-platform", permission: "can_manage_global_settings"/);
  assert.match(src, /requireSuperAdmin/);
});

test("non-admin agents never receive global outage from evaluate when below thresholds", () => {
  const now = Date.now();
  const rows = [
    {
      id: "e1",
      tenantId: "T2",
      userId: "u1",
      createdAt: new Date(now - 60_000),
      payload: { kind: "WEBRTC_CALL_DEBUG", debugKind: "WEBRTC_OUTBOUND_FAIL", direction: "outbound" },
    },
  ];
  const snap = evaluateGlobalWebrtcOutage({ diagRows: rows, nowMs: now });
  assert.equal(snap, null, "single-tenant failure should not create global outage");
});

test("admin aggregation counts match evaluator snapshot fields", () => {
  const now = Date.now();
  const rows = ["T2", "T25", "T7"].map((tenantId, i) => ({
    id: `e_${tenantId}`,
    tenantId,
    userId: `u_${tenantId}`,
    createdAt: new Date(now - i * 10_000),
    payload: { kind: "WEBRTC_CALL_DEBUG", debugKind: "WEBRTC_OUTBOUND_FAIL", direction: "outbound" },
  }));
  const snap = evaluateGlobalWebrtcOutage({ diagRows: rows, activeOpenIncidentCount: 3, nowMs: now });
  assert.ok(snap);
  assert.equal(snap!.affectedTenantIds.length, 3);
  assert.equal(snap!.outboundFailureCount, 3);
  assert.equal(snap!.activeIncidentCount, 3);
  assert.ok(snap!.sampleDiagEventIds.length >= 3);
});
