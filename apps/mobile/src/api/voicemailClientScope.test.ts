/**
 * Run: pnpm --filter @connect/mobile exec tsx --test src/api/voicemailClientScope.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeVoicemailScopeKeyChange,
  distinctExtensionsFromVoicemails,
  filterVoicemailsToScopedMailboxes,
  mergeVoicemailScopeMeta,
  resetVoicemailScopeKeyGateForTests,
  voicemailTokenSessionKey,
} from "./voicemailClientScope";
import type { Voicemail } from "../types";

test("voicemailTokenSessionKey: different tokens => different keys", () => {
  assert.notEqual(voicemailTokenSessionKey("a.b.c"), voicemailTokenSessionKey("a.b.d"));
});

test("mergeVoicemailScopeMeta: JSON wins over headers", () => {
  const m = mergeVoicemailScopeMeta(
    { voicemailScopeVersion: "contained-owned", scopedMailboxesForUser: ["101"] },
    "super-admin",
    "999",
  );
  assert.equal(m.voicemailScopeVersion, "contained-owned");
  assert.deepEqual(m.scopedMailboxesForUser, ["101"]);
});

test("filterVoicemailsToScopedMailboxes: strips non-owned extension", () => {
  const vms: Voicemail[] = [
    {
      id: "1",
      callerId: "x",
      receivedAt: "2020-01-01",
      durationSec: 1,
      folder: "inbox",
      listened: false,
      extension: "101",
      tenantId: "t",
    },
    {
      id: "2",
      callerId: "y",
      receivedAt: "2020-01-02",
      durationSec: 1,
      folder: "inbox",
      listened: false,
      extension: "999",
      tenantId: "t",
    },
  ];
  const out = filterVoicemailsToScopedMailboxes(vms, {
    voicemailScopeVersion: "contained-owned",
    scopedMailboxesForUser: ["101"],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "1");
});

test("filterVoicemailsToScopedMailboxes: empty allowlist => no rows", () => {
  const vms: Voicemail[] = [
    {
      id: "1",
      callerId: "x",
      receivedAt: "2020-01-01",
      durationSec: 1,
      folder: "inbox",
      listened: false,
      extension: "101",
      tenantId: "t",
    },
  ];
  const out = filterVoicemailsToScopedMailboxes(vms, {
    voicemailScopeVersion: "contained-owned",
    scopedMailboxesForUser: [],
  });
  assert.equal(out.length, 0);
});

test("distinctExtensionsFromVoicemails", () => {
  const vms: Voicemail[] = [
    {
      id: "1",
      callerId: "x",
      receivedAt: "2020-01-01",
      durationSec: 1,
      folder: "inbox",
      listened: false,
      extension: "101",
      tenantId: "t",
    },
    {
      id: "2",
      callerId: "y",
      receivedAt: "2020-01-02",
      durationSec: 1,
      folder: "inbox",
      listened: false,
      extension: "102",
      tenantId: "t",
    },
  ];
  assert.deepEqual(distinctExtensionsFromVoicemails(vms).sort(), ["101", "102"]);
});

test("consumeVoicemailScopeKeyChange: same scope twice => false second time", () => {
  resetVoicemailScopeKeyGateForTests();
  assert.equal(consumeVoicemailScopeKeyChange("u1:t1:abc"), true);
  assert.equal(consumeVoicemailScopeKeyChange("u1:t1:abc"), false);
});

test("consumeVoicemailScopeKeyChange: logout then login clears gate", () => {
  resetVoicemailScopeKeyGateForTests();
  consumeVoicemailScopeKeyChange("u1:t1:abc");
  consumeVoicemailScopeKeyChange("_");
  assert.equal(consumeVoicemailScopeKeyChange("u2:t2:def"), true);
});
