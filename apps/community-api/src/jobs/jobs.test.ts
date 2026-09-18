import { test } from "node:test";
import assert from "node:assert/strict";
import { api, connectUsers, createOrg, createUser, tdb, testApp, uniq } from "../testing/harness.js";
import { runJobAlerts } from "./routes.js";

async function addMember(personId: string, organizationId: string, role: string, permissions: string[] = [], affiliation = "VERIFIED_ADMIN") {
  await tdb().membership.create({ data: { personId, organizationId, role: role as any, affiliation: affiliation as any, permissions } });
}

async function openJob(app: any, owner: any, org: { id: string }, overrides: Record<string, unknown> = {}) {
  const r = await api(app, {
    method: "POST",
    url: "/jobs",
    token: owner.accessToken,
    payload: { organizationId: org.id, title: "Office Manager", description: "Run the counter office and keep the books straight.", location: "Boro Park, Brooklyn", employmentType: "FULL_TIME", workMode: "ONSITE", ...overrides },
  });
  return r;
}

test("creating a job needs org.manage_jobs — a bare employee is refused", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const employee = await createUser(app);
  const org = await createOrg(app, owner);
  await addMember(employee.personId, org.id, "EMPLOYEE", []);

  const asOwner = await openJob(app, owner, org);
  assert.equal(asOwner.status, 201, JSON.stringify(asOwner.body));
  assert.equal(asOwner.body.job.status, "OPEN");

  const asEmployee = await api(app, { method: "POST", url: "/jobs", token: employee.accessToken, payload: { organizationId: org.id, title: "Anything", description: "x" } });
  assert.equal(asEmployee.status, 403);
});

test("public search finds a job by keyword and by location", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner, uniq("Kaufman & Sons "));
  // The shared dev db accumulates jobs from other concurrent test runs, so a
  // generic word like "embroidery" is not a reliable needle — use a unique token.
  const needle = uniq("embroiderytok");
  const created = await openJob(app, owner, org, { title: `Embroidery machine operator (${needle})`, description: `Run a 4-head ${needle} machine for our uniform shop.`, location: "Monroe, NY" });
  assert.equal(created.status, 201);

  const seeker = await createUser(app);
  const byKeyword = await api(app, { method: "GET", url: `/jobs?q=${needle}`, token: seeker.accessToken });
  assert.equal(byKeyword.status, 200);
  assert.ok(byKeyword.body.items.some((it: any) => it.job.id === created.body.job.id), JSON.stringify(byKeyword.body.items.map((i: any) => i.job.title)));

  const byLocation = await api(app, { method: "GET", url: `/jobs?q=${needle}&location=Monroe`, token: seeker.accessToken });
  assert.ok(byLocation.body.items.some((it: any) => it.job.id === created.body.job.id));

  const item = byKeyword.body.items.find((it: any) => it.job.id === created.body.job.id);
  assert.equal(item.earlyApplicant, true);
  assert.equal(item.organization.displayName, org.displayName);
});

test("apply builds a snapshot with only the chosen sections, refuses a duplicate, and needs verification", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const created = await openJob(app, owner, org);
  const jobId = created.body.job.id;

  const candidate = await createUser(app, { verify: false, headline: "Bookkeeper" });
  const unverifiedTry = await api(app, { method: "POST", url: `/jobs/${jobId}/apply`, token: candidate.accessToken, payload: { sections: ["headline"] } });
  assert.equal(unverifiedTry.status, 403);

  // verify the candidate the same way createUser(verify:true) would
  const codeRes = await api(app, { method: "GET", url: `/dev/last-code?target=${encodeURIComponent(candidate.email)}` });
  await api(app, { method: "POST", url: "/auth/verify/confirm", token: candidate.accessToken, payload: { purpose: "email", target: candidate.email, code: codeRes.body.code } });
  await api(app, { method: "PATCH", url: "/me/profile", token: candidate.accessToken, payload: { about: "Ten years of QuickBooks.", skills: ["QuickBooks", "AR/AP"] } });

  const applied = await api(app, { method: "POST", url: `/jobs/${jobId}/apply`, token: candidate.accessToken, payload: { sections: ["headline", "about"], coverNote: "Happy to start Monday." } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));

  const pipeline = await api(app, { method: "GET", url: `/jobs/${jobId}/applications`, token: owner.accessToken });
  assert.equal(pipeline.status, 200);
  const row = pipeline.body.items.find((r: any) => r.applicant.id === candidate.personId);
  assert.ok(row);
  assert.equal(row.profileSnapshot.headline, "Bookkeeper");
  assert.equal(row.profileSnapshot.about, "Ten years of QuickBooks.");
  assert.equal(row.profileSnapshot.skills, undefined, "skills was not a chosen section and must not be stored");
  assert.ok(row.viewedAt, "GET applications marks the row as viewed");

  const dupe = await api(app, { method: "POST", url: `/jobs/${jobId}/apply`, token: candidate.accessToken, payload: { sections: ["headline"] } });
  assert.equal(dupe.status, 409);
});

test("a stage change notifies the candidate, and messaging opens a thread the candidate can read", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const recruiter = await createUser(app);
  const org = await createOrg(app, owner);
  await addMember(recruiter.personId, org.id, "RECRUITER", ["org.hire", "org.manage_jobs"]);
  const created = await openJob(app, owner, org);
  const jobId = created.body.job.id;

  const candidate = await createUser(app);
  await api(app, { method: "POST", url: `/jobs/${jobId}/apply`, token: candidate.accessToken, payload: { sections: ["headline"] } });

  const pipeline = await api(app, { method: "GET", url: `/jobs/${jobId}/applications`, token: recruiter.accessToken });
  const appId = pipeline.body.items[0].id;

  const notifsBefore = await api(app, { method: "GET", url: "/notifications", token: candidate.accessToken });
  const staged = await api(app, { method: "PATCH", url: `/jobs/${jobId}/applications/${appId}`, token: recruiter.accessToken, payload: { stage: "INTERVIEW" } });
  assert.equal(staged.status, 200);
  assert.equal(staged.body.application.stage, "INTERVIEW");
  const notifsAfter = await api(app, { method: "GET", url: "/notifications", token: candidate.accessToken });
  assert.ok(notifsAfter.body.items.length > notifsBefore.body.items.length);
  assert.ok(notifsAfter.body.items.some((n: any) => n.kind === "job.stage"));

  const messaged = await api(app, { method: "POST", url: `/jobs/${jobId}/applications/${appId}/message`, token: recruiter.accessToken, payload: { body: "Are you free Thursday at 10:30?" } });
  assert.equal(messaged.status, 201, JSON.stringify(messaged.body));
  const threadId = messaged.body.threadId;

  const candidateReads = await api(app, { method: "GET", url: `/threads/${threadId}/messages`, token: candidate.accessToken });
  assert.equal(candidateReads.status, 200);
  assert.ok(candidateReads.body.items.some((m: any) => m.body === "Are you free Thursday at 10:30?"));
});

test("save and unsave a job", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const created = await openJob(app, owner, org);
  const jobId = created.body.job.id;

  const seeker = await createUser(app);
  const saved = await api(app, { method: "POST", url: `/jobs/${jobId}/save`, token: seeker.accessToken });
  assert.equal(saved.status, 201);
  const list = await api(app, { method: "GET", url: "/me/saved-jobs", token: seeker.accessToken });
  assert.ok(list.body.items.some((i: any) => i.job.id === jobId));

  const unsaved = await api(app, { method: "DELETE", url: `/jobs/${jobId}/save`, token: seeker.accessToken });
  assert.equal(unsaved.status, 204);
  const list2 = await api(app, { method: "GET", url: "/me/saved-jobs", token: seeker.accessToken });
  assert.ok(!list2.body.items.some((i: any) => i.job.id === jobId));
});

test("a job alert notifies on a new matching job once the alert runs", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner, uniq("Hamaspik "));
  const seeker = await createUser(app);

  const alertRes = await api(app, { method: "POST", url: "/me/job-alerts", token: seeker.accessToken, payload: { query: "intake coordinator" } });
  assert.equal(alertRes.status, 201);

  const created = await openJob(app, owner, org, { title: "Intake Coordinator", description: "Yiddish/English intake coordinator role." });
  assert.equal(created.status, 201);

  await runJobAlerts(tdb());

  const notifs = await api(app, { method: "GET", url: "/notifications", token: seeker.accessToken });
  assert.ok(notifs.body.items.some((n: any) => n.kind === "job.match"), JSON.stringify(notifs.body.items));
});

test("ask-referral requires a verified-member connection", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const created = await openJob(app, owner, org);
  const jobId = created.body.job.id;

  const asker = await createUser(app);
  const memberNotConnected = await createUser(app);
  const connectedNotMember = await createUser(app);
  await addMember(memberNotConnected.personId, org.id, "EMPLOYEE", [], "VERIFIED_ADMIN");
  await connectUsers(app, asker, connectedNotMember);

  const notConnected = await api(app, { method: "POST", url: `/jobs/${jobId}/ask-referral`, token: asker.accessToken, payload: { personId: memberNotConnected.personId } });
  assert.equal(notConnected.status, 403);

  const notAMember = await api(app, { method: "POST", url: `/jobs/${jobId}/ask-referral`, token: asker.accessToken, payload: { personId: connectedNotMember.personId } });
  assert.equal(notAMember.status, 403);

  await connectUsers(app, asker, memberNotConnected);
  const ok = await api(app, { method: "POST", url: `/jobs/${jobId}/ask-referral`, token: asker.accessToken, payload: { personId: memberNotConnected.personId } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.threadId);
});

test("closing a job hides it from search, and analytics counts views/applications", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const org = await createOrg(app, owner);
  const created = await openJob(app, owner, org, { title: "Front desk & order entry" });
  const jobId = created.body.job.id;

  const seeker = await createUser(app);
  await api(app, { method: "GET", url: `/public/jobs/${jobId}`, token: seeker.accessToken });
  await api(app, { method: "POST", url: `/jobs/${jobId}/apply`, token: seeker.accessToken, payload: { sections: ["headline"] } });

  const analytics = await api(app, { method: "GET", url: `/jobs/${jobId}/analytics`, token: owner.accessToken });
  assert.equal(analytics.status, 200);
  assert.equal(analytics.body.views, 1);
  assert.equal(analytics.body.applications, 1);
  assert.equal(analytics.body.byStage.APPLIED, 1);

  const closed = await api(app, { method: "POST", url: `/jobs/${jobId}/close`, token: owner.accessToken });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.job.status, "CLOSED");

  const list = await api(app, { method: "GET", url: "/jobs?q=Front desk", token: seeker.accessToken });
  assert.ok(!list.body.items.some((i: any) => i.job.id === jobId));
});
