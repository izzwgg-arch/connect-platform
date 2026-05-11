import test from "node:test";
import assert from "node:assert/strict";
import { buildVoicemailListWhere, voicemailRowInOwnedScope } from "./voicemailResourceScope";

const scope = { tenantIds: ["t-cuid", "vpbx:acme"], extensions: ["101", "102"] };

test("buildVoicemailListWhere: multi tenant + multi ext uses Prisma in", () => {
  const w = buildVoicemailListWhere("inbox", scope);
  assert.deepEqual(w.deletedAt, null);
  assert.equal(w.folder, "inbox");
  assert.deepEqual(w.tenantId, { in: ["t-cuid", "vpbx:acme"] });
  assert.deepEqual(w.extension, { in: ["101", "102"] });
});

test("buildVoicemailListWhere: single tenant + single ext uses scalars", () => {
  const w = buildVoicemailListWhere("old", { tenantIds: ["t1"], extensions: ["101"] });
  assert.equal(w.tenantId, "t1");
  assert.equal(w.extension, "101");
});

test("voicemailRowInOwnedScope: allows matching tenant + extension", () => {
  assert.equal(
    voicemailRowInOwnedScope({ tenantId: "t-cuid", extension: "101" }, scope),
    true,
  );
});

test("voicemailRowInOwnedScope: denies wrong extension same tenant", () => {
  assert.equal(
    voicemailRowInOwnedScope({ tenantId: "t-cuid", extension: "999" }, scope),
    false,
  );
});

test("voicemailRowInOwnedScope: denies cross-tenant same extension", () => {
  assert.equal(
    voicemailRowInOwnedScope({ tenantId: "other-tenant", extension: "101" }, scope),
    false,
  );
});

test("voicemailRowInOwnedScope: denies null tenant", () => {
  assert.equal(voicemailRowInOwnedScope({ tenantId: null, extension: "101" }, scope), false);
});

test("voicemailRowInOwnedScope: trims extension", () => {
  assert.equal(
    voicemailRowInOwnedScope({ tenantId: "t-cuid", extension: " 101 " }, scope),
    true,
  );
});
