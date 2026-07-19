import { test } from "node:test";
import assert from "node:assert/strict";
import { runCertification } from "./harness";

test("certification suite runs fully green in simulation", async () => {
  const report = await runCertification();
  const failed = report.cases.filter((c) => !c.passed);
  assert.deepEqual(failed.map((c) => c.name), [], `failing cases: ${JSON.stringify(failed, null, 2)}`);
  assert.equal(report.failed, 0);
  assert.equal(report.zeroImpactProven, true);
});

test("every PBX provisioning capability certifies (all cases pass)", async () => {
  const report = await runCertification();
  for (const cap of ["pbx.P1", "pbx.P2", "pbx.P3", "pbx.P4", "pbx.P5", "pbx.P7", "pbx.P8", "pbx.P9", "pbx.P10", "pbx.P11", "pbx.P12", "pbx.P13", "pbx.P14"]) {
    assert.equal(report.byCapability[cap]?.certified, true, `${cap} not certified`);
  }
  assert.equal(report.byCapability["pbx.safety"].certified, true);
  assert.equal(report.byCapability["pbx.structure"].certified, true);
});
