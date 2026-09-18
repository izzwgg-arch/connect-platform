import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createOrg, createUser, grantStaff, tdb, testApp, uniq } from "../testing/harness.js";
import { antispamSweep } from "./signals.js";
import { liftExpiredSuspensions } from "./jobs.js";
import { rollupAnalytics } from "../core/schedulers.js";
import { track } from "../lib/analytics.js";

async function openReport(app: Awaited<ReturnType<typeof testApp>>, reporter: any, target: any) {
  const r = await api(app, { method: "POST", url: "/reports", token: reporter.accessToken, payload: { targetType: "person", targetId: target.personId, reason: "SPAM", details: "spamming everyone" } });
  assert.equal(r.status, 201);
  return r.body.caseId as string;
}

test("non-staff is refused the moderation queue", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const r = await api(app, { method: "GET", url: "/admin/moderation/cases", token: a.accessToken });
  assert.equal(r.status, 403);
});

test("a report opens a case that shows up in the queue with account signals", async () => {
  const app = await testApp();
  const reporter = await createUser(app);
  const target = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");

  const caseId = await openReport(app, reporter, target);

  const queue = await api(app, { method: "GET", url: "/admin/moderation/cases", token: mod.accessToken });
  assert.equal(queue.status, 200);
  assert.ok(queue.body.items.some((c: any) => c.id === caseId));
  assert.equal(queue.body.statusCounts.OPEN >= 1, true);

  const detail = await api(app, { method: "GET", url: `/admin/moderation/cases/${caseId}`, token: mod.accessToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.subjectKind, "person");
  assert.ok(Array.isArray(detail.body.accountSignals) && detail.body.accountSignals.length > 0);
  assert.ok(detail.body.reports.length >= 1);
});

test("WARN notifies the subject", async () => {
  const app = await testApp();
  const reporter = await createUser(app);
  const target = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");
  const caseId = await openReport(app, reporter, target);

  const act = await api(app, { method: "POST", url: `/admin/moderation/cases/${caseId}/action`, token: mod.accessToken, payload: { kind: "WARN", note: "First warning for spam-like behavior.", userMessage: "Please stop mass-messaging strangers." } });
  assert.equal(act.status, 200);
  assert.equal(act.body.case.status, "ACTIONED");

  const notifs = await api(app, { method: "GET", url: "/notifications", token: target.accessToken });
  assert.ok(notifs.body.items.some((n: any) => n.kind === "moderation.action" && n.body === "Please stop mass-messaging strangers."));
});

test("RESTRICT_OUTREACH blocks a connection request with the moderator's sentence, and doubles on repeat", async () => {
  const app = await testApp();
  const reporter = await createUser(app);
  const target = await createUser(app);
  const stranger = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");

  const caseId1 = await openReport(app, reporter, target);
  const act1 = await api(app, { method: "POST", url: `/admin/moderation/cases/${caseId1}/action`, token: mod.accessToken, payload: { kind: "RESTRICT_OUTREACH", note: "Mass outreach complaints.", userMessage: "You can't send new connection requests for 7 days.", days: 7 } });
  assert.equal(act1.status, 200);
  assert.equal(act1.body.action.expiresAt != null, true);

  const blocked = await api(app, { method: "POST", url: "/connections/request", token: target.accessToken, payload: { personId: stranger.personId } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.message, "You can't send new connection requests for 7 days.");

  // A restriction created with a past expiry should stop blocking (sanity on the expiry check itself).
  await tdb().restriction.updateMany({ where: { personId: target.personId, kind: "OUTREACH" }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const allowedNow = await api(app, { method: "POST", url: "/connections/request", token: target.accessToken, payload: { personId: stranger.personId } });
  assert.equal(allowedNow.status, 201);

  // Second restriction within 90 days doubles the previous day count (7 -> 14), regardless of what's requested.
  const target2 = await createUser(app);
  const caseId2 = await openReport(app, reporter, target2);
  const first = await api(app, { method: "POST", url: `/admin/moderation/cases/${caseId2}/action`, token: mod.accessToken, payload: { kind: "RESTRICT_OUTREACH", note: "First restriction.", days: 7 } });
  assert.equal(first.status, 200);

  // A second, DIFFERENT reporter (the Report unique key is per reporter+target, so
  // reusing `reporter` here would just return the old, already-ACTIONED caseId).
  const secondReporter = await createUser(app);
  const caseId3 = await api(app, { method: "POST", url: "/reports", token: secondReporter.accessToken, payload: { targetType: "person", targetId: target2.personId, reason: "MASS_SOLICITATION", details: "again" } });
  // targetType+targetId already has a resolved case from before (ACTIONED) — a new report reopens a fresh OPEN case for the same target.
  assert.equal(caseId3.status, 201);
  const second = await api(app, { method: "POST", url: `/admin/moderation/cases/${caseId3.body.caseId}/action`, token: mod.accessToken, payload: { kind: "RESTRICT_OUTREACH", note: "Second restriction within 90 days.", days: 3 } });
  assert.equal(second.status, 200);
  assert.equal(second.body.action.userMessage, null);
  const restriction = await tdb().restriction.findFirst({ where: { personId: target2.personId, kind: "OUTREACH" }, orderBy: { createdAt: "desc" } });
  const days = Math.round(((restriction!.expiresAt!.getTime() - Date.now()) / 86_400_000));
  assert.ok(days >= 13 && days <= 14, `expected ~14 days, got ${days}`);
});

test("SUSPEND revokes sessions (old token 403 account_restricted) and the lift job restores ACTIVE", async () => {
  const app = await testApp();
  const reporter = await createUser(app);
  const target = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");
  const caseId = await openReport(app, reporter, target);

  const act = await api(app, { method: "POST", url: `/admin/moderation/cases/${caseId}/action`, token: mod.accessToken, payload: { kind: "SUSPEND", note: "Repeated spam reports.", days: 1 } });
  assert.equal(act.status, 200);

  const me = await api(app, { method: "GET", url: "/auth/me", token: target.accessToken });
  assert.equal(me.status, 403);
  assert.equal(me.body.error, "account_restricted");

  await tdb().restriction.updateMany({ where: { personId: target.personId, kind: "SUSPENSION" }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await liftExpiredSuspensions(tdb());
  const person = await tdb().person.findUnique({ where: { id: target.personId }, select: { status: true } });
  assert.equal(person?.status, "ACTIVE");
});

test("BAN sets the person BANNED and clears device tokens", async () => {
  const app = await testApp();
  const reporter = await createUser(app);
  const target = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");
  await api(app, { method: "POST", url: "/me/devices", token: target.accessToken, payload: { platform: "ios", token: uniq("devtok") } });
  const caseId = await openReport(app, reporter, target);

  const act = await api(app, { method: "POST", url: `/admin/moderation/cases/${caseId}/action`, token: mod.accessToken, payload: { kind: "BAN", note: "Scam links sent to multiple members." } });
  assert.equal(act.status, 200);
  const person = await tdb().person.findUnique({ where: { id: target.personId }, select: { status: true } });
  assert.equal(person?.status, "BANNED");
  const tokens = await tdb().deviceToken.findMany({ where: { personId: target.personId } });
  assert.equal(tokens.length, 0);
});

test("REMOVE_CONTENT soft-deletes a post", async () => {
  const app = await testApp();
  const author = await createUser(app);
  const reporter = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");
  const post = await api(app, { method: "POST", url: "/posts", token: author.accessToken, payload: { kind: "TEXT", body: "buy my miracle supplement now" } });
  assert.equal(post.status, 201);
  const postId = post.body.post.id as string;

  const report = await api(app, { method: "POST", url: "/reports", token: reporter.accessToken, payload: { targetType: "post", targetId: postId, reason: "SCAM" } });
  assert.equal(report.status, 201);

  const act = await api(app, { method: "POST", url: `/admin/moderation/cases/${report.body.caseId}/action`, token: mod.accessToken, payload: { kind: "REMOVE_CONTENT", note: "Scam product post." } });
  assert.equal(act.status, 200);

  const got = await api(app, { method: "GET", url: `/posts/${postId}`, token: author.accessToken });
  assert.equal(got.status, 404);
});

test("DISMISS closes a case without touching the account", async () => {
  const app = await testApp();
  const reporter = await createUser(app);
  const target = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");
  const caseId = await openReport(app, reporter, target);

  const act = await api(app, { method: "POST", url: `/admin/moderation/cases/${caseId}/action`, token: mod.accessToken, payload: { kind: "DISMISS", note: "Not a violation on review." } });
  assert.equal(act.status, 200);
  assert.equal(act.body.case.status, "DISMISSED");
  const person = await tdb().person.findUnique({ where: { id: target.personId }, select: { status: true } });
  assert.equal(person?.status, "ACTIVE");
});

test("appeal granted lifts the restriction", async () => {
  const app = await testApp();
  const reporter = await createUser(app);
  const target = await createUser(app);
  const stranger = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");
  const caseId = await openReport(app, reporter, target);
  const act = await api(app, { method: "POST", url: `/admin/moderation/cases/${caseId}/action`, token: mod.accessToken, payload: { kind: "RESTRICT_OUTREACH", note: "Outreach complaint.", days: 7 } });
  assert.equal(act.status, 200);

  const appeal = await api(app, { method: "POST", url: "/appeals", token: target.accessToken, payload: { actionId: act.body.action.id, body: "This was a misunderstanding, I only messaged people I know." } });
  assert.equal(appeal.status, 201);

  const caseAfterAppeal = await tdb().moderationCase.findUnique({ where: { id: caseId } });
  assert.equal(caseAfterAppeal?.status, "APPEALED");

  const decide = await api(app, { method: "POST", url: `/admin/moderation/appeals/${appeal.body.id}/decide`, token: mod.accessToken, payload: { decision: "GRANTED", note: "Confirmed — restriction lifted." } });
  assert.equal(decide.status, 200);

  const allowed = await api(app, { method: "POST", url: "/connections/request", token: target.accessToken, payload: { personId: stranger.personId } });
  assert.equal(allowed.status, 201);
});

test("a suspended/banned organization's public page is a 404", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "ADMIN");
  const org = await createOrg(app, owner);

  const before = await api(app, { method: "GET", url: `/public/companies/${org.slug}` });
  assert.equal(before.status, 200);

  const suspend = await api(app, { method: "POST", url: `/admin/organizations/${org.id}/status`, token: mod.accessToken, payload: { status: "SUSPENDED", note: "Impersonating another business." } });
  assert.equal(suspend.status, 200);

  const after = await api(app, { method: "GET", url: `/public/companies/${org.slug}` });
  assert.equal(after.status, 404);
});

test("antispam sweep opens a case for a person with heavy outreach volume", async () => {
  const app = await testApp();
  const person = await createUser(app);
  await tdb().outreachStat.upsert({ where: { personId: person.personId }, create: { personId: person.personId, messagesLast24h: 500 }, update: { messagesLast24h: 500 } });

  await antispamSweep(tdb());

  const kase = await tdb().moderationCase.findFirst({ where: { targetType: "person", targetId: person.personId, status: { in: ["OPEN", "IN_REVIEW"] } } });
  assert.ok(kase, "expected the sweep to open a case");
  assert.equal(kase!.reason, "MASS_SOLICITATION");
  assert.equal((kase!.signals as any).auto, true);
  assert.equal((kase!.signals as any).messagesLast24h, 500);
});

test("admin overview returns real counts", async () => {
  const app = await testApp();
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");
  const r = await api(app, { method: "GET", url: "/admin/overview", token: mod.accessToken });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.counts.organizations, "number");
  assert.equal(typeof r.body.systemHealth.dbMs, "number");
  assert.ok("sockets" in r.body.systemHealth);
});

test("company analytics tiles change after a company_view event and a rollup", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);

  const before = await api(app, { method: "GET", url: `/organizations/${org.id}/analytics?range=30`, token: owner.accessToken });
  assert.equal(before.status, 200);
  const startViews = before.body.tiles.pageViews;

  await track(tdb(), { personId: owner.personId, event: "company_view", objectType: "Organization", objectId: org.id, surface: "search" });
  await rollupAnalytics(tdb());

  const after = await api(app, { method: "GET", url: `/organizations/${org.id}/analytics?range=30`, token: owner.accessToken });
  assert.equal(after.status, 200);
  assert.ok(after.body.tiles.pageViews > startViews);
  assert.ok(after.body.series.length > 0);
  assert.ok(after.body.sources.some((s: any) => s.surface === "search"));
});

test("audit log lists moderation actions", async () => {
  const app = await testApp();
  const reporter = await createUser(app);
  const target = await createUser(app);
  const mod = await createUser(app);
  await grantStaff(mod.personId, "MODERATOR");
  const caseId = await openReport(app, reporter, target);
  await api(app, { method: "POST", url: `/admin/moderation/cases/${caseId}/action`, token: mod.accessToken, payload: { kind: "WARN", note: "Logged for the audit trail check." } });

  const auditLog = await api(app, { method: "GET", url: "/admin/audit", token: mod.accessToken });
  assert.equal(auditLog.status, 200);
  assert.ok(auditLog.body.items.some((r: any) => r.action === "moderation.warn" && r.targetId === target.personId));
});
