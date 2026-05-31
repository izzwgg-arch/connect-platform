import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedCall } from "../types";

function shouldShowDialerQuickAction(call: NormalizedCall): boolean {
  return (
    call.direction === "inbound" &&
    !!call.crmContactId &&
    !!call.crmProfileUrl
  );
}

describe("inbound CRM dialer quick action contract", () => {
  it("shows when inbound call has crmContactId and profile URL", () => {
    assert.equal(
      shouldShowDialerQuickAction({
        direction: "inbound",
        crmContactId: "c-1",
        crmProfileUrl: "/crm/contacts/c-1",
      } as NormalizedCall),
      true,
    );
  });

  it("hides for outbound calls even with CRM fields", () => {
    assert.equal(
      shouldShowDialerQuickAction({
        direction: "outbound",
        crmContactId: "c-1",
        crmProfileUrl: "/crm/contacts/c-1",
      } as NormalizedCall),
      false,
    );
  });

  it("hides without CRM match fields", () => {
    assert.equal(
      shouldShowDialerQuickAction({ direction: "inbound" } as NormalizedCall),
      false,
    );
  });
});
