import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDeepLinkPath } from "./deepLink";

// Deliberately imports only ./deepLink, not ./linking — the latter pulls in
// expo-linking, which plain `node --import tsx --test` cannot resolve
// outside of Metro/the app runtime.

test("people/:username -> PersonProfile", () => {
  assert.deepEqual(resolveDeepLinkPath("people/jdoe"), { screen: "PersonProfile", params: { username: "jdoe" } });
});

test("a full https URL resolves the same as the bare path", () => {
  assert.deepEqual(resolveDeepLinkPath("https://community.loopcom.net/people/jdoe"), { screen: "PersonProfile", params: { username: "jdoe" } });
});

test("companies/:slug -> Company", () => {
  assert.deepEqual(resolveDeepLinkPath("companies/acme-signs"), { screen: "Company", params: { slug: "acme-signs" } });
});

test("posts/:id -> PostDetail", () => {
  assert.deepEqual(resolveDeepLinkPath("posts/abc123"), { screen: "PostDetail", params: { id: "abc123" } });
});

test("messages/:threadId -> Conversation, and bare messages -> Threads", () => {
  assert.deepEqual(resolveDeepLinkPath("messages/t1"), { screen: "Conversation", params: { threadId: "t1" } });
  assert.deepEqual(resolveDeepLinkPath("messages"), { screen: "Threads", params: {} });
});

test("notifications and search have no params", () => {
  assert.deepEqual(resolveDeepLinkPath("notifications"), { screen: "Notifications", params: {} });
  assert.deepEqual(resolveDeepLinkPath("search"), { screen: "Search", params: {} });
});

test("jobs/:id -> JobDetail, and bare jobs -> JobsList", () => {
  assert.deepEqual(resolveDeepLinkPath("jobs/xyz"), { screen: "JobDetail", params: { id: "xyz" } });
  assert.deepEqual(resolveDeepLinkPath("jobs"), { screen: "JobsList", params: {} });
});

test("rfq/:id -> RfqDetail, and bare rfq -> RfqHome", () => {
  assert.deepEqual(resolveDeepLinkPath("rfq/xyz"), { screen: "RfqDetail", params: { id: "xyz" } });
  assert.deepEqual(resolveDeepLinkPath("rfq"), { screen: "RfqHome", params: {} });
});

test("events/:slug -> EventDetail (keyed by slug, not id), and bare events -> EventsList", () => {
  assert.deepEqual(resolveDeepLinkPath("events/fall-mixer"), { screen: "EventDetail", params: { slug: "fall-mixer" } });
  assert.deepEqual(resolveDeepLinkPath("events"), { screen: "EventsList", params: {} });
});

test("groups/:slug -> GroupDetail, and bare groups -> GroupsList", () => {
  assert.deepEqual(resolveDeepLinkPath("groups/hvac-pros"), { screen: "GroupDetail", params: { slug: "hvac-pros" } });
  assert.deepEqual(resolveDeepLinkPath("groups"), { screen: "GroupsList", params: {} });
});

test("opportunities/:id -> OpportunityDetail, and bare opportunities -> OpportunitiesList", () => {
  assert.deepEqual(resolveDeepLinkPath("opportunities/xyz"), { screen: "OpportunityDetail", params: { id: "xyz" } });
  assert.deepEqual(resolveDeepLinkPath("opportunities"), { screen: "OpportunitiesList", params: {} });
});

test("marketplace/:id -> ListingDetail, and bare marketplace -> MarketplaceList", () => {
  assert.deepEqual(resolveDeepLinkPath("marketplace/xyz"), { screen: "ListingDetail", params: { id: "xyz" } });
  assert.deepEqual(resolveDeepLinkPath("marketplace"), { screen: "MarketplaceList", params: {} });
});

test("a full https URL resolves a jobs deep link the same as the bare path", () => {
  assert.deepEqual(resolveDeepLinkPath("https://community.loopcom.net/jobs/xyz"), { screen: "JobDetail", params: { id: "xyz" } });
});

test("an unknown path segment resolves to null (caller falls back to no-op)", () => {
  assert.equal(resolveDeepLinkPath("something-unrecognized/1"), null);
});

test("a bare kind with no id is not resolvable for people/companies/posts", () => {
  assert.equal(resolveDeepLinkPath("people"), null);
  assert.equal(resolveDeepLinkPath("companies"), null);
  assert.equal(resolveDeepLinkPath("posts"), null);
});

test("an empty path resolves to the Feed", () => {
  assert.deepEqual(resolveDeepLinkPath(""), { screen: "Feed", params: {} });
});
