import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createOrg, createUser, tdb, testApp, uniq } from "../testing/harness.js";
import { extractRfq } from "./extract.js";
import { rfqClosingSweep } from "./routes.js";

async function addMember(personId: string, organizationId: string, role: string, permissions: string[] = []) {
  await tdb().membership.create({ data: { personId, organizationId, role: role as any, affiliation: "VERIFIED_ADMIN", permissions } });
}

/* ── extraction (pure) ────────────────────────────────────────────────────── */

test("extractRfq: the brief's example fills quantity, location, category and a deadline", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");
  const e = extractRfq("Need 25 custom embroidered jackets delivered to Monroe before October 20", now);
  assert.equal(e.quantity, "25");
  assert.equal(e.location, "Monroe");
  assert.equal(e.categorySlug, "apparel-uniforms");
  assert.equal(e.deadline, "2026-10-20");
  assert.ok(e.requirements.length >= 1);
  assert.match(e.requirements[0], /delivered/i);
});

test("extractRfq: budget range, 'under Xk', and a bare 'budget N'", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");
  assert.deepEqual(extractRfq("Budget is $1,500–2,200 for this job.", now), {
    quantity: null,
    budgetMin: 1500,
    budgetMax: 2200,
    deadline: null,
    location: null,
    requirements: [],
    categorySlug: null,
  });
  assert.equal(extractRfq("Looking for something under 5k total.", now).budgetMax, 5000);
  assert.equal(extractRfq("budget 900 for the whole run", now).budgetMin, 900);
});

/* ── create + extraction fill ─────────────────────────────────────────────── */

test("creating an RFQ from plain text fills quantity/deadline/location from extraction and flags it unconfirmed", async () => {
  const app = await testApp();
  const buyer = await createUser(app);
  const res = await api(app, {
    method: "POST",
    url: "/rfq",
    token: buyer.accessToken,
    payload: { title: "Jackets for camp staff", description: "Need 25 custom embroidered jackets delivered to Monroe before October 20" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.rfq.quantity, "25");
  assert.equal(res.body.rfq.location, "Monroe");
  assert.equal(res.body.extracted.categorySlug, "apparel-uniforms");

  const detail = await api(app, { method: "GET", url: `/rfq/${res.body.rfq.id}`, token: buyer.accessToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.extractionConfirmed, false);
  assert.equal(detail.body.myRole, "buyer");
});

/* ── matching ─────────────────────────────────────────────────────────────── */

test("matching invites an org whose page mentions the category and skips an unrelated one", async () => {
  const app = await testApp();
  const buyer = await createUser(app);
  const vendorOwner = await createUser(app);
  const otherOwner = await createUser(app);
  const embroidery = await createOrg(app, vendorOwner, uniq("Stitch Embroidery Co "));
  const unrelated = await createOrg(app, otherOwner, uniq("Quiet Bookkeeping "));

  const res = await api(app, {
    method: "POST",
    url: "/rfq",
    token: buyer.accessToken,
    payload: { title: "Need embroidered jackets for staff", description: "25 jackets, embroidered logo, delivered to Brooklyn.", visibility: "MATCHED" },
  });
  assert.equal(res.status, 201);
  const invited = await tdb().rfqInvite.findMany({ where: { rfqId: res.body.rfq.id } });
  const invitedIds = invited.map((i) => i.organizationId);
  assert.ok(invitedIds.includes(embroidery.id), "embroidery vendor should be matched");
  assert.ok(!invitedIds.includes(unrelated.id), "unrelated vendor should not be matched");
});

/* ── permission gate ──────────────────────────────────────────────────────── */

test("a member without org.quote is refused when submitting a quote", async () => {
  const app = await testApp();
  const buyer = await createUser(app);
  const vendorOwner = await createUser(app);
  const employee = await createUser(app);
  const org = await createOrg(app, vendorOwner, uniq("Weiss Uniforms "));
  await addMember(employee.personId, org.id, "EMPLOYEE", []);

  const rfqRes = await api(app, { method: "POST", url: "/rfq", token: buyer.accessToken, payload: { title: "Uniforms needed", description: "60 uniforms for staff.", inviteOrganizationIds: [org.id] } });
  assert.equal(rfqRes.status, 201);

  const quoteRes = await api(app, {
    method: "POST",
    url: `/rfq/${rfqRes.body.rfq.id}/quotes`,
    token: employee.accessToken,
    payload: { organizationId: org.id, total: 500 },
  });
  assert.equal(quoteRes.status, 403);
});

/* ── quote versions, visibility, shortlist, accept ────────────────────────── */

test("quote submit twice keeps one row at version 2; buyer sees all quotes, a vendor sees only its own; shortlist then accept declines the rest and locks a second accept", async () => {
  const app = await testApp();
  const buyer = await createUser(app);
  const vendorAOwner = await createUser(app);
  const vendorBOwner = await createUser(app);
  const orgA = await createOrg(app, vendorAOwner, uniq("Vendor A "));
  const orgB = await createOrg(app, vendorBOwner, uniq("Vendor B "));

  const rfqRes = await api(app, {
    method: "POST",
    url: "/rfq",
    token: buyer.accessToken,
    payload: { title: "Printing job", description: "500 flyers printed, need a sample first.", inviteOrganizationIds: [orgA.id, orgB.id] },
  });
  const rfqId = rfqRes.body.rfq.id;

  const q1 = await api(app, { method: "POST", url: `/rfq/${rfqId}/quotes`, token: vendorAOwner.accessToken, payload: { organizationId: orgA.id, total: 900 } });
  assert.equal(q1.status, 201);
  const q1b = await api(app, { method: "POST", url: `/rfq/${rfqId}/quotes`, token: vendorAOwner.accessToken, payload: { organizationId: orgA.id, total: 850 } });
  assert.equal(q1b.status, 200);
  assert.equal(q1b.body.quote.version, 2);
  assert.equal(q1b.body.quote.id, q1.body.quote.id, "resubmitting stays the same row");

  const q2 = await api(app, { method: "POST", url: `/rfq/${rfqId}/quotes`, token: vendorBOwner.accessToken, payload: { organizationId: orgB.id, total: 1100 } });
  assert.equal(q2.status, 201);

  const quoteRows = await tdb().quote.findMany({ where: { rfqId } });
  assert.equal(quoteRows.length, 2, "still exactly one row per vendor");

  const buyerView = await api(app, { method: "GET", url: `/rfq/${rfqId}`, token: buyer.accessToken });
  assert.equal(buyerView.body.quotes.length, 2);

  const vendorAView = await api(app, { method: "GET", url: `/rfq/${rfqId}`, token: vendorAOwner.accessToken });
  assert.equal(vendorAView.body.quotes.length, 1);
  assert.equal(vendorAView.body.quotes[0].organization.id, orgA.id);
  assert.equal(vendorAView.body.myRole, "vendor");

  const shortlist = await api(app, { method: "POST", url: `/rfq/${rfqId}/quotes/${q1.body.quote.id}/shortlist`, token: buyer.accessToken });
  assert.equal(shortlist.status, 200);

  const accept = await api(app, { method: "POST", url: `/rfq/${rfqId}/quotes/${q1.body.quote.id}/accept`, token: buyer.accessToken });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.status, "ACCEPTED");

  const other = await tdb().quote.findUnique({ where: { id: q2.body.quote.id } });
  assert.equal(other?.status, "DECLINED", "the other quote was declined automatically");

  const rfqRow = await tdb().rfq.findUnique({ where: { id: rfqId } });
  assert.equal(rfqRow?.status, "ACCEPTED");
  assert.equal(rfqRow?.acceptedQuoteId, q1.body.quote.id);

  const verification = await tdb().verification.findFirst({ where: { organizationId: orgA.id, kind: "TRANSACTION", status: "VERIFIED" } });
  assert.ok(verification, "a TRANSACTION verification was recorded for the winning vendor");

  const tag = await tdb().relationshipTag.findFirst({ where: { ownerId: buyer.personId, targetOrgId: orgA.id, kind: "CUSTOMER" } });
  assert.equal(tag?.mutual, true);

  // Simulate the race the partial unique index exists for: another quote is
  // still (or again) SUBMITTED so the app-level status check passes, but the
  // rfq already has an accepted quote — the DB's partial unique index must
  // still refuse a second ACCEPTED row, and the route turns that into a 409.
  await tdb().quote.update({ where: { id: q2.body.quote.id }, data: { status: "SUBMITTED" } });
  const secondAccept = await api(app, { method: "POST", url: `/rfq/${rfqId}/quotes/${q2.body.quote.id}/accept`, token: buyer.accessToken });
  assert.equal(secondAccept.status, 409);

  const winnerNotif = await tdb().notification.findFirst({ where: { personId: vendorAOwner.personId, kind: "rfq.decision" } });
  assert.ok(winnerNotif);
  const loserNotif = await tdb().notification.findFirst({ where: { personId: vendorBOwner.personId, kind: "rfq.decision" } });
  assert.ok(loserNotif);
});

/* ── visibility: MATCHED vs PUBLIC ────────────────────────────────────────── */

test("a MATCHED rfq 404s for a stranger; a PUBLIC one is readable anonymously", async () => {
  const app = await testApp();
  const buyer = await createUser(app);
  const stranger = await createUser(app);

  const matched = await api(app, { method: "POST", url: "/rfq", token: buyer.accessToken, payload: { title: "Private request", description: "Just for invited vendors.", visibility: "MATCHED" } });
  const matchedGet = await api(app, { method: "GET", url: `/rfq/${matched.body.rfq.id}`, token: stranger.accessToken });
  assert.equal(matchedGet.status, 404);

  const pub = await api(app, { method: "POST", url: "/rfq", token: buyer.accessToken, payload: { title: "Public request", description: "Anyone can see this one.", visibility: "PUBLIC" } });
  const anon = await api(app, { method: "GET", url: `/public/rfq/${pub.body.rfq.id}` });
  assert.equal(anon.status, 200);
  assert.equal(anon.body.title, "Public request");
});

/* ── questions ────────────────────────────────────────────────────────────── */

test("a vendor can ask a question and the buyer's answer notifies the asker", async () => {
  const app = await testApp();
  const buyer = await createUser(app);
  const vendorOwner = await createUser(app);
  const org = await createOrg(app, vendorOwner, uniq("Question Vendor "));
  const rfqRes = await api(app, { method: "POST", url: "/rfq", token: buyer.accessToken, payload: { title: "Signage job", description: "Need banners.", inviteOrganizationIds: [org.id] } });
  const rfqId = rfqRes.body.rfq.id;

  const ask = await api(app, { method: "POST", url: `/rfq/${rfqId}/questions`, token: vendorOwner.accessToken, payload: { organizationId: org.id, question: "Can delivery be split into two shipments?" } });
  assert.equal(ask.status, 201);

  const answer = await api(app, { method: "POST", url: `/rfq/${rfqId}/questions/${ask.body.question.id}/answer`, token: buyer.accessToken, payload: { answer: "Yes, that works.", isPublic: true } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.question.answer, "Yes, that works.");

  const notif = await tdb().notification.findFirst({ where: { personId: vendorOwner.personId, kind: "rfq.question" } });
  assert.ok(notif);
});

/* ── closing job ──────────────────────────────────────────────────────────── */

test("the closing sweep notifies invited-not-quoted vendors and auto-closes an overdue rfq with no accepted quote", async () => {
  const app = await testApp();
  const buyer = await createUser(app);
  const vendorOwner = await createUser(app);
  const org = await createOrg(app, vendorOwner, uniq("Closing Vendor "));
  const rfqRes = await api(app, { method: "POST", url: "/rfq", token: buyer.accessToken, payload: { title: "Closing soon job", description: "Need this fast.", inviteOrganizationIds: [org.id] } });
  const rfqId = rfqRes.body.rfq.id;

  await tdb().rfq.update({ where: { id: rfqId }, data: { closesAt: new Date(Date.now() + 60_000) } });
  await rfqClosingSweep(tdb());
  const notif = await tdb().notification.findFirst({ where: { personId: vendorOwner.personId, kind: "rfq.closing" } });
  assert.ok(notif, "vendor is notified the rfq is closing soon");

  await tdb().rfq.update({ where: { id: rfqId }, data: { closesAt: new Date(Date.now() - 60_000) } });
  await rfqClosingSweep(tdb());
  const closed = await tdb().rfq.findUnique({ where: { id: rfqId } });
  assert.equal(closed?.status, "CLOSED");
});

/* ── chat without a connection ────────────────────────────────────────────── */

test("an RFQ thread can be created between a buyer and a vendor with no prior connection", async () => {
  const app = await testApp();
  const buyer = await createUser(app);
  const vendorOwner = await createUser(app);
  const org = await createOrg(app, vendorOwner, uniq("Thread Vendor "));
  const rfqRes = await api(app, { method: "POST", url: "/rfq", token: buyer.accessToken, payload: { title: "Thread job", description: "Need a quick chat.", inviteOrganizationIds: [org.id] } });
  const rfqId = rfqRes.body.rfq.id;
  const quote = await api(app, { method: "POST", url: `/rfq/${rfqId}/quotes`, token: vendorOwner.accessToken, payload: { organizationId: org.id, total: 300 } });

  const degree = await tdb().connection.findFirst({ where: { OR: [{ aId: buyer.personId }, { bId: buyer.personId }] } });
  assert.equal(degree, null, "no connection exists between them");

  const thread = await api(app, { method: "POST", url: `/rfq/${rfqId}/quotes/${quote.body.quote.id}/thread`, token: buyer.accessToken });
  assert.equal(thread.status, 200);
  assert.ok(thread.body.threadId);

  const participants = await tdb().threadParticipant.findMany({ where: { threadId: thread.body.threadId } });
  assert.equal(participants.length, 2);
});
