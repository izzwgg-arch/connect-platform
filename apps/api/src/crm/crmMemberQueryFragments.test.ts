import test from "node:test";
import assert from "node:assert/strict";
import {
  crmCampaignMemberActionableNonTerminalWhere,
  crmCampaignMemberQueueLiveContactWhere,
} from "./crmMemberQueryFragments";

test("actionable non-terminal where uses same live-contact predicate as queue (16C)", () => {
  assert.deepEqual(crmCampaignMemberActionableNonTerminalWhere.status, {
    in: ["PENDING", "IN_PROGRESS", "CALLBACK"],
  });
  assert.deepEqual(
    crmCampaignMemberActionableNonTerminalWhere.contact,
    crmCampaignMemberQueueLiveContactWhere.contact,
  );
});
