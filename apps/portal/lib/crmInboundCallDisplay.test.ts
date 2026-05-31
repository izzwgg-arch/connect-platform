import test from "node:test";
import assert from "node:assert/strict";
import {
  inboundCallerDisplayName,
  phonesLikelyMatch,
  shouldShowCrmInboundQuickAction,
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
