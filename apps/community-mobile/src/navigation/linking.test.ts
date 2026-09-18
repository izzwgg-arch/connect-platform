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

for (const kind of ["jobs", "events", "groups", "rfq", "opportunities"]) {
  test(`${kind}/:id -> ExternalLink (not yet built natively)`, () => {
    assert.deepEqual(resolveDeepLinkPath(`${kind}/xyz`), { screen: "ExternalLink", params: { kind, id: "xyz" } });
  });
}

test("an unknown path segment resolves to null (caller falls back to no-op)", () => {
  assert.equal(resolveDeepLinkPath("something-unrecognized/1"), null);
});

test("a bare kind with no id is not resolvable for people/companies/posts/external kinds", () => {
  assert.equal(resolveDeepLinkPath("people"), null);
  assert.equal(resolveDeepLinkPath("companies"), null);
  assert.equal(resolveDeepLinkPath("posts"), null);
  assert.equal(resolveDeepLinkPath("jobs"), null);
});

test("an empty path resolves to the Feed", () => {
  assert.deepEqual(resolveDeepLinkPath(""), { screen: "Feed", params: {} });
});
