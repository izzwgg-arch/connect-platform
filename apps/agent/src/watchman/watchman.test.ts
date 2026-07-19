import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHealth, evaluateSecurity, highestSeverity } from "./watchman";

test("critical container down → critical signal", () => {
  const s = evaluateHealth({ containers: { "app-api-1": false, "app-portal-1": true }, diskUsedPct: 20, dbReachable: true });
  assert.ok(s.some((x) => x.type === "service_down" && x.severity === "critical"));
});

test("non-critical container down → warning", () => {
  const s = evaluateHealth({ containers: { "obs-grafana": false }, diskUsedPct: 20, dbReachable: true });
  assert.equal(s.find((x) => x.type === "service_down")?.severity, "warning");
});

test("disk thresholds", () => {
  assert.equal(evaluateHealth({ containers: {}, diskUsedPct: 82, dbReachable: true }).find((s) => s.type === "disk_high")?.severity, "warning");
  assert.equal(evaluateHealth({ containers: {}, diskUsedPct: 95, dbReachable: true }).find((s) => s.type === "disk_high")?.severity, "critical");
});

test("db unreachable is critical", () => {
  assert.ok(evaluateHealth({ containers: {}, diskUsedPct: 10, dbReachable: false }).some((s) => s.type === "db_unreachable" && s.severity === "critical"));
});

test("cert expiry ladder", () => {
  assert.equal(evaluateHealth({ containers: {}, diskUsedPct: 10, dbReachable: true, certExpiryHours: 24 }).find((s) => s.type === "cert_expiry")?.severity, "critical");
  assert.equal(evaluateHealth({ containers: {}, diskUsedPct: 10, dbReachable: true, certExpiryHours: 200 }).find((s) => s.type === "cert_expiry")?.severity, "warning");
});

test("toll-fraud pattern is critical", () => {
  assert.ok(evaluateSecurity({ authFailures: 0, distinctSourceIps: 0, offHoursIntlAttempts: 15, unexpectedGeoRegs: 0 }).some((s) => s.type === "toll_fraud_pattern" && s.severity === "critical"));
});

test("sip bruteforce severity depends on source spread", () => {
  assert.equal(evaluateSecurity({ authFailures: 800, distinctSourceIps: 3, offHoursIntlAttempts: 0, unexpectedGeoRegs: 0 }).find((s) => s.type === "sip_bruteforce")?.severity, "warning");
  assert.equal(evaluateSecurity({ authFailures: 800, distinctSourceIps: 40, offHoursIntlAttempts: 0, unexpectedGeoRegs: 0 }).find((s) => s.type === "sip_bruteforce")?.severity, "critical");
});

test("clean inputs produce no signals", () => {
  assert.equal(evaluateHealth({ containers: { "app-api-1": true }, diskUsedPct: 40, dbReachable: true }).length, 0);
  assert.equal(evaluateSecurity({ authFailures: 0, distinctSourceIps: 0, offHoursIntlAttempts: 0, unexpectedGeoRegs: 0 }).length, 0);
  assert.equal(highestSeverity([]), null);
});
