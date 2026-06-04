import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GLOBAL_OUTAGE_DISMISS_COOLDOWN_MS,
  buildGlobalOutageFingerprint,
} from "@connect/shared/webrtcGlobalOutageAlerts";
import { platformOutageHiddenForAdmin } from "./webrtcPlatformOutageService";

test("dismiss hides outage for admin within cooldown window", () => {
  const dismissedAt = new Date("2026-06-04T12:00:00.000Z");
  const lastSeenAt = new Date("2026-06-04T12:05:00.000Z");
  const nowMs = dismissedAt.getTime() + 60_000;
  assert.equal(platformOutageHiddenForAdmin(dismissedAt, lastSeenAt, nowMs), true);
});

test("outage reopens for admin when lastSeen advances past dismiss cooldown", () => {
  const dismissedAt = new Date("2026-06-04T12:00:00.000Z");
  const lastSeenAt = new Date(dismissedAt.getTime() + GLOBAL_OUTAGE_DISMISS_COOLDOWN_MS + 5_000);
  const nowMs = lastSeenAt.getTime() + 1_000;
  assert.equal(platformOutageHiddenForAdmin(dismissedAt, lastSeenAt, nowMs), false);
});

test("no dismissal means outage visible", () => {
  const lastSeenAt = new Date("2026-06-04T12:00:00.000Z");
  assert.equal(platformOutageHiddenForAdmin(null, lastSeenAt, lastSeenAt.getTime()), false);
});

test("dedupe fingerprint differs across 15-minute buckets", () => {
  const bucketMs = 15 * 60 * 1000;
  const t0 = 1_700_000_000_000;
  const a = buildGlobalOutageFingerprint(t0);
  const b = buildGlobalOutageFingerprint(t0 + bucketMs);
  assert.notEqual(a, b);
});
