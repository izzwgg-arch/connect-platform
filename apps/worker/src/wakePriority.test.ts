/**
 * Guards for the 2026-09-01 push-quota changes on the WORKER side:
 *   • the registration watchdog's recovery wake rides NORMAL priority (it was
 *     burning ~62 invisible HIGH pushes/day of one device's ~10/day
 *     standby-bucket quota — Relax Tires census),
 *   • no other worker sender may adopt NORMAL (call-critical pushes REQUIRE
 *     HIGH to beat Doze),
 *   • FCM UNREGISTERED (typed, 404-only) retires the device row.
 *
 * These are SOURCE guards on purpose: the defect class is a caller passing
 * (or omitting) an option, which a unit test of sendFcmDirectData can't see.
 * Reads are CRLF-normalised (source-reading-tests-must-normalise-crlf).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const src = read(path.join(__dirname, "main.ts"))
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim()))
  .join("\n");

test("the registration watchdog is the ONLY sender on NORMAL priority", () => {
  const normals = src.match(/fcmPriority: "NORMAL"/g) ?? [];
  assert.equal(normals.length, 1, "exactly one NORMAL-priority sender (the watchdog recovery wake)");
  // …and that one site is the watchdog's WATCHDOG_REREGISTER push, not a ring.
  const idx = src.indexOf('fcmPriority: "NORMAL"');
  const windowAround = src.slice(Math.max(0, idx - 2500), idx + 500);
  assert.ok(
    windowAround.includes("WATCHDOG_REREGISTER_PUSH_QUEUED") || windowAround.includes("watchdog-"),
    "the NORMAL-priority send must be the registration watchdog's recovery wake",
  );
});

test("sendPushToUserDevices threads NORMAL into the direct-FCM send with the longer recovery ttl", () => {
  assert.ok(
    src.includes('input.fcmPriority === "NORMAL" ? { priority: "NORMAL", ttl: "300s" } : undefined'),
    "the direct-FCM call must pass NORMAL + 300s ttl only when the caller asked for it — everything else defaults HIGH/45s",
  );
});

test("the INCOMING_CALL / INVITE_CANCELED senders never pass a priority (default HIGH preserved)", () => {
  // Only ONE spot in the file may mention fcmPriority as a payload option
  // besides the input declaration and the threading expression: the watchdog.
  const mentions = src.match(/fcmPriority/g) ?? [];
  // input type field + threading read + the watchdog call site = 3.
  assert.equal(mentions.length, 3, "no additional sender may adopt fcmPriority without its own census entry");
});

test("worker FCM_DIRECT_FAILED retires the device row ONLY on the typed UNREGISTERED signal", () => {
  const site = src.indexOf("fcm_unregistered_deactivated");
  assert.ok(site >= 0, "worker must deactivate on FCM UNREGISTERED");
  const before = src.slice(Math.max(0, site - 1500), site);
  assert.ok(
    before.includes("err instanceof FcmSendError && err.unregistered"),
    "deactivation must be gated on the typed FcmSendError.unregistered",
  );
  const around = src.slice(Math.max(0, site - 400), site + 400);
  assert.ok(around.includes("deactivatedAt: new Date()"), "deactivation must stamp deactivatedAt");
});
