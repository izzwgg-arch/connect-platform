import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCrmContactWorkspaceHref,
  buildCrmLiveWorkspaceHref,
  inboundCallerDisplayName,
  phonesLikelyMatch,
  shouldShowCrmInboundQuickAction,
  shouldShowCrmLiveWorkspaceShortcut,
} from "./crmInboundCallDisplay";

test("phonesLikelyMatch: E.164 and formatted NANP last-10", () => {
  assert.equal(phonesLikelyMatch("+15125550100", "(512) 555-0100"), true);
});

test("inboundCallerDisplayName prefers CRM name over PBX fromName", () => {
  assert.equal(
    inboundCallerDisplayName({
      crmContactName: "Jane Lead",
      fromName: "WIRELESS CALLER",
      from: "+15125550100",
    }),
    "Jane Lead",
  );
});

test("shouldShowCrmInboundQuickAction: inbound with CRM id and profile URL", () => {
  assert.equal(
    shouldShowCrmInboundQuickAction({
      direction: "inbound",
      crmContactId: "c1",
      crmProfileUrl: "/crm/contacts/c1",
    }),
    true,
  );
});

test("shouldShowCrmInboundQuickAction: hides for outbound", () => {
  assert.equal(
    shouldShowCrmInboundQuickAction({
      direction: "outbound",
      crmContactId: "c1",
      crmProfileUrl: "/crm/contacts/c1",
    }),
    false,
  );
});

test("shouldShowCrmInboundQuickAction: hides without CRM fields", () => {
  assert.equal(shouldShowCrmInboundQuickAction({ direction: "inbound" }), false);
});

test("shouldShowCrmLiveWorkspaceShortcut: requires matched inbound or outbound CRM contact", () => {
  assert.equal(
    shouldShowCrmLiveWorkspaceShortcut({
      direction: "inbound",
      crmContactId: "c1",
    }),
    true,
  );
  assert.equal(
    shouldShowCrmLiveWorkspaceShortcut({
      direction: "outbound",
      crmContactId: "c1",
      linkedId: "l1",
    }),
    true,
  );
  assert.equal(shouldShowCrmLiveWorkspaceShortcut({ direction: "inbound" }), false);
});

test("buildCrmContactWorkspaceHref: builds safe contact workspace URL", () => {
  assert.equal(
    buildCrmContactWorkspaceHref({
      crmContactId: "c 1",
      linkedId: "l/1",
    }),
    "/crm/contacts/c%201?workspace=timeline&linkedId=l%2F1",
  );
});

test("buildCrmLiveWorkspaceHref: builds safe active live workspace URL", () => {
  assert.equal(
    buildCrmLiveWorkspaceHref({
      crmContactId: "c 1",
      linkedId: "l/1",
      from: "+1 (512) 555-0100",
    }),
    "/crm/live-call?contactId=c+1&linkedId=l%2F1&from=%2B1+%28512%29+555-0100",
  );
});

test("workspace href helpers return null without contact", () => {
  assert.equal(buildCrmContactWorkspaceHref({ linkedId: "l1" }), null);
  assert.equal(buildCrmLiveWorkspaceHref({ linkedId: "l1" }), null);
});
