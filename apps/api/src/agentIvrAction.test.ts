// M4: the IVR-option hardening matrix — pure validation, no DB, no PBX.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentIvrActionRequest, validateAgentIvrOption, CUSTOM_CONTEXT_ALLOWLIST } from "./agentIvrAction";

const CEP = "T21_cos-all,101,1";

test("request schema: action requirements", () => {
  const base = { tenantId: "21", agentActionId: "a" };
  assert.equal(AgentIvrActionRequest.safeParse({ ...base, action: "list" }).success, true);
  assert.equal(AgentIvrActionRequest.safeParse({ ...base, action: "set_option", profileId: "p" }).success, false); // needs digit+type+ref
  assert.equal(AgentIvrActionRequest.safeParse({ ...base, action: "set_option", profileId: "p", optionDigit: "1", destinationType: "extension", destinationRef: CEP }).success, true);
  assert.equal(AgentIvrActionRequest.safeParse({ ...base, action: "clear_option", profileId: "p", optionDigit: "1" }).success, true);
  assert.equal(AgentIvrActionRequest.safeParse({ ...base, action: "set_option", profileId: "p", optionDigit: "*", destinationType: "extension", destinationRef: CEP }).success, false); // raw * not allowed
});

test("EVERY destination type: a well-formed ref validates", () => {
  const ok: Array<[string, string]> = [
    ["extension", "T21_cos-all,101,1"],
    ["queue", "ext-queues,900,1"],
    ["ring_group", "ext-group,601,1"],
    ["voicemail", "ext-local,vmu101,1"],
    ["ivr", "connect-tenant-ivr,other-profile,1"],
    ["announcement", "app-announce,notice,1"],
    ["external_number", "+18455551234"],
    ["terminate", "connect-default-fallback,s,1"],
    ["custom", "connect-default-fallback,s,1"],
  ];
  for (const [type, ref] of ok) {
    assert.equal(validateAgentIvrOption({ destinationType: type, destinationRef: ref, profileId: "self" }), null, `${type} ${ref} should pass`);
  }
});

test("EVERY type: a malformed ref is refused", () => {
  const bad: Array<[string, string]> = [
    ["extension", "not a cep"],
    ["queue", "ext-queues,900"],           // missing priority
    ["voicemail", "ext-local,vmu101,x"],   // non-numeric priority
    ["external_number", "not-a-number"],
    ["ivr", "connect-tenant-ivr"],         // not CEP
  ];
  for (const [type, ref] of bad) {
    assert.ok(validateAgentIvrOption({ destinationType: type, destinationRef: ref, profileId: "self" }), `${type} ${ref} should refuse`);
  }
});

test("unknown destination type refused", () => {
  assert.ok(validateAgentIvrOption({ destinationType: "webhook", destinationRef: CEP, profileId: "p" }));
});

test("custom restricted to the allow-list", () => {
  assert.equal(validateAgentIvrOption({ destinationType: "custom", destinationRef: "connect-tenant-ivr,p2,1", profileId: "p1" }), null);
  assert.ok(validateAgentIvrOption({ destinationType: "custom", destinationRef: "from-sip-external,911,1", profileId: "p1" }));
  assert.ok(validateAgentIvrOption({ destinationType: "custom", destinationRef: "evil-context,s,1", profileId: "p1" }));
  // allow-list is the source of truth
  assert.ok(CUSTOM_CONTEXT_ALLOWLIST.has("connect-default-fallback"));
});

test("sub-menu (ivr) LOOP GUARD: a digit cannot point at its own profile", () => {
  assert.ok(validateAgentIvrOption({ destinationType: "ivr", destinationRef: "connect-tenant-ivr,pSelf,1", profileId: "pSelf" }));
  assert.equal(validateAgentIvrOption({ destinationType: "ivr", destinationRef: "connect-tenant-ivr,pOther,1", profileId: "pSelf", tenantProfileIds: new Set(["pSelf", "pOther"]) }), null);
});

test("sub-menu (ivr) OWNERSHIP: target profile must belong to the tenant", () => {
  const owned = new Set(["pSelf", "pOther"]);
  assert.equal(validateAgentIvrOption({ destinationType: "ivr", destinationRef: "connect-tenant-ivr,pOther,1", profileId: "pSelf", tenantProfileIds: owned }), null);
  assert.ok(validateAgentIvrOption({ destinationType: "ivr", destinationRef: "connect-tenant-ivr,pForeign,1", profileId: "pSelf", tenantProfileIds: owned }));
});

test("terminate ignores ref (always OK)", () => {
  assert.equal(validateAgentIvrOption({ destinationType: "terminate", destinationRef: "", profileId: "p" }), null);
});
