import test from "node:test";
import assert from "node:assert/strict";
import { chooseExtensionForVoicemailNotify } from "./voicemailNotifyResolveExtensionCore";

type Row = { tenantId: string; extNumber: string };

test("chooseExtension: empty → no match", () => {
  const r = chooseExtensionForVoicemailNotify<Row>([], "ctx", () => false);
  assert.equal(r.choice, null);
  assert.equal(r.reason, "no_active_extension_for_mailbox");
});

test("chooseExtension: single candidate wins without context match", () => {
  const rows: Row[] = [{ tenantId: "t1", extNumber: "101" }];
  const r = chooseExtensionForVoicemailNotify(rows, "default", () => false);
  assert.equal(r.choice?.tenantId, "t1");
  assert.equal(r.reason, "unique_mailbox_across_tenants");
});

test("chooseExtension: two tenants, one context match", () => {
  const rows: Row[] = [
    { tenantId: "t-wrong", extNumber: "101" },
    { tenantId: "t-right", extNumber: "101" },
  ];
  const r = chooseExtensionForVoicemailNotify(rows, "acme-vm", (tid) => tid === "t-right");
  assert.equal(r.choice?.tenantId, "t-right");
  assert.equal(r.reason, "disambiguated_by_voicemail_context");
});

test("chooseExtension: two context matches → ambiguous", () => {
  const rows: Row[] = [
    { tenantId: "t1", extNumber: "101" },
    { tenantId: "t2", extNumber: "101" },
  ];
  const r = chooseExtensionForVoicemailNotify(rows, "x", () => true);
  assert.equal(r.choice, null);
  assert.equal(r.reason, "ambiguous_multiple_context_matches");
});

test("chooseExtension: duplicate mailbox, default context → refuse", () => {
  const rows: Row[] = [
    { tenantId: "t1", extNumber: "101" },
    { tenantId: "t2", extNumber: "101" },
  ];
  const r = chooseExtensionForVoicemailNotify(rows, "default", () => false);
  assert.equal(r.choice, null);
  assert.equal(r.reason, "ambiguous_default_context_duplicate_mailbox");
});

test("chooseExtension: duplicate mailbox, unknown context → refuse", () => {
  const rows: Row[] = [
    { tenantId: "t1", extNumber: "101" },
    { tenantId: "t2", extNumber: "101" },
  ];
  const r = chooseExtensionForVoicemailNotify(rows, "unknown-ctx", () => false);
  assert.equal(r.choice, null);
  assert.equal(r.reason, "no_tenant_matches_voicemail_context");
});
