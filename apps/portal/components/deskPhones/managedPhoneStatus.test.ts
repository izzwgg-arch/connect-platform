import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { managedPhoneErrorText, managedPhoneStatus } from "./managedPhoneStatus";

test("configuration, RPS, response delivery and physical online are distinct", () => {
  const base: any = { retiredAt: null, registrationState: "unknown", lastSeenAt: null, configVersion: 1, servedVersion: null, rpsState: "pending_credentials" };
  assert.match(managedPhoneStatus(base), /assignment pending/);
  assert.match(managedPhoneStatus({ ...base, rpsState: "assigned" }), /Waiting for the phone to connect/);
  assert.match(managedPhoneStatus({ ...base, lastSeenAt: "now" }), /Downloading/);
  assert.match(managedPhoneStatus({ ...base, servedVersion: 1 }), /Waiting for the phone to register/);
  assert.match(managedPhoneStatus({ ...base, registrationState: "endpoint_registered_device_unverified" }), /Confirm/);
  assert.equal(managedPhoneStatus({ ...base, registrationState: "online" }), "Online");
  assert.equal(managedPhoneStatus({ ...base, retiredAt: "now", registrationState: "online" }), "Removed");
  for (const s of ["pending_credentials", "assigned", "failed"]) assert.doesNotMatch(managedPhoneStatus({ ...base, rpsState: s }), /complete|online/i);
});
test("errors read the ApiError body and never show a raw slug", () => {
  assert.match(managedPhoneErrorText({ body: { error: "invalid_mac" } }), /sticker/);
  assert.doesNotMatch(managedPhoneErrorText({ body: { error: "rps_authentication_failed" } }), /_/);
  assert.doesNotMatch(managedPhoneErrorText({ payload: { error: "invalid_mac" }, message: "invalid_mac" }), /_/);
});
test("the panel uses this module, never `.payload` or a slug-replace", () => {
  const src = readFileSync(join(__dirname, "ManagedPhonePanel.tsx"), "utf8");
  assert.match(src, /managedPhoneErrorText/);
  assert.doesNotMatch(src, /\.payload|replace\(\/_\/g/);
});
