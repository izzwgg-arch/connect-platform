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
