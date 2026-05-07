import test from "node:test";
import assert from "node:assert/strict";
import { buildVmRecordJobPublicView, createVmRecordJob, getVmRecordJobForUser } from "./vmRecordCallJobs";

test("createVmRecordJob / getVmRecordJobForUser — owner vs stranger", () => {
  const id = createVmRecordJob({
    ownerUserId: "user-a",
    connectTenantId: "tenant-1",
    connectExtensionId: "ext-1",
    extNumber: "101",
    pbxTenantId: "21",
    greetingType: "unavailable",
    pjsipEndpointHint: "T21_101_2",
    pbxInstanceId: null,
  });
  assert.equal(getVmRecordJobForUser(id, "user-b", "tenant-1", "ext-1"), null);
  const j = getVmRecordJobForUser(id, "user-a", "tenant-1", "ext-1");
  assert.ok(j);
  const view = buildVmRecordJobPublicView(j!);
  assert.equal(view.jobId, id);
  assert.equal(view.state, "preparing_call");
  assert.equal(view.extension, "101");
});

test("buildVmRecordJobPublicView — wake meta shape exposes Phase A diagnostic fields", () => {
  // Regression guard: the public view must continue to expose the wake meta
  // object so the portal/diag UIs can render device counts / endpoint-avail
  // signals. We don't populate the optional fields here (the runner does
  // that at runtime); we only assert the wake object is preserved verbatim
  // so additions don't get accidentally stripped.
  const id = createVmRecordJob({
    ownerUserId: "user-a",
    connectTenantId: "tenant-1",
    connectExtensionId: "ext-1",
    extNumber: "101",
    pbxTenantId: "21",
    greetingType: "unavailable",
    pjsipEndpointHint: "T21_101_2",
    pbxInstanceId: null,
  });
  const j = getVmRecordJobForUser(id, "user-a", "tenant-1", "ext-1");
  assert.ok(j);
  const view = buildVmRecordJobPublicView(j!);
  assert.ok(view.wake && typeof view.wake === "object", "view.wake must be an object");
  // Initial defaults from createVmRecordJob — keep them stable for portal consumers.
  const w = view.wake as Record<string, unknown>;
  assert.equal(w.devicesNotified, 0);
  assert.equal(w.waitedMs, 0);
  assert.equal(w.sent, false);
});
