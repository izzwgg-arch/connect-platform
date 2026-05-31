import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCampaignContactHref,
  campaignLeadNeighbors,
  findCampaignMemberIndex,
  resolveStartOutreach,
  sortCampaignNavMembers,
  splitWorkspaceTabs,
  workspaceTabLabel,
} from "./contactWorkspaceHelpers";

test("splitWorkspaceTabs keeps overflow tabs out of primary row", () => {
  const { primary, overflow } = splitWorkspaceTabs(undefined, 5);
  assert.equal(primary.length, 5);
  assert.equal(overflow.length, 5);
  assert.equal(primary[0]?.id, "timeline");
  assert.equal(overflow[0]?.id, "notes");
});

test("campaignLeadNeighbors returns previous and next members", () => {
  const members = sortCampaignNavMembers([
    { id: "m1", contactId: "c1", sortOrder: 1 },
    { id: "m2", contactId: "c2", sortOrder: 2 },
    { id: "m3", contactId: "c3", sortOrder: 3 },
  ]);
  const nav = campaignLeadNeighbors(members, 1);
  assert.equal(nav.position, 2);
  assert.equal(nav.total, 3);
  assert.equal(nav.previous?.id, "m1");
  assert.equal(nav.next?.id, "m3");
});

test("findCampaignMemberIndex prefers memberId over contactId", () => {
  const members = [
    { id: "m1", contactId: "c1", sortOrder: 1 },
    { id: "m2", contactId: "c2", sortOrder: 2 },
  ];
  assert.equal(findCampaignMemberIndex(members, { memberId: "m2", contactId: "c1" }), 1);
  assert.equal(findCampaignMemberIndex(members, { contactId: "c1" }), 0);
});

test("buildCampaignContactHref preserves campaign and return context", () => {
  const href = buildCampaignContactHref("c2", "camp-1", "m2", "/crm/campaigns/camp-1");
  assert.match(href, /^\/crm\/contacts\/c2\?/);
  assert.match(href, /campaignId=camp-1/);
  assert.match(href, /memberId=m2/);
  assert.match(href, /returnTo=/);
});

test("resolveStartOutreach fails when composer is not mounted", () => {
  const result = resolveStartOutreach({ isArchived: false, composerMounted: false });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "composer_unavailable");
  }
});

test("resolveStartOutreach succeeds when composer is available", () => {
  const result = resolveStartOutreach({ isArchived: false, composerMounted: true });
  assert.equal(result.ok, true);
});

test("workspaceTabLabel resolves active section title", () => {
  assert.equal(workspaceTabLabel("intelligence"), "AI Intelligence");
});
