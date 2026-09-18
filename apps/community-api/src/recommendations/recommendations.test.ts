import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createOrg, createUser, grantStaff, tdb, testApp, uniq } from "../testing/harness.js";

test("organizationsYouMayNeed: same-industry org surfaces with a reason + impression id; dismissing removes it", async () => {
  const app = await testApp();
  const viewer = await createUser(app);
  await api(app, { method: "PATCH", url: "/me/profile", token: viewer.accessToken, payload: { industry: "Technology" } });

  const founder = await createUser(app);
  const org = await api(app, { method: "POST", url: "/organizations", token: founder.accessToken, payload: { displayName: uniq("TechCo "), industry: "Technology" } });
  assert.equal(org.status, 201);

  const list = await api(app, { method: "GET", url: "/recommendations/organizations?limit=25", token: viewer.accessToken });
  assert.equal(list.status, 200);
  const item = list.body.organizations.find((o: any) => o.id === org.body.id);
  assert.ok(item, "same-industry org should appear in the rail");
  assert.ok(item.reason, "it must say why");
  assert.ok(item.recommendationId, "it must carry an impression id");

  const dismiss = await api(app, { method: "POST", url: `/recommendations/${item.recommendationId}/dismiss`, token: viewer.accessToken });
  assert.equal(dismiss.status, 200);

  const list2 = await api(app, { method: "GET", url: "/recommendations/organizations?limit=25", token: viewer.accessToken });
  assert.ok(!list2.body.organizations.some((o: any) => o.id === org.body.id), "a dismissed org must not reappear for 90 days");
});

test("recommendations/explain: returns the reason and evidence used, without leaking a private tag identity", async () => {
  const app = await testApp();
  const viewer = await createUser(app);
  await api(app, { method: "PATCH", url: "/me/profile", token: viewer.accessToken, payload: { industry: "Real estate" } });
  const founder = await createUser(app);
  const org = await api(app, { method: "POST", url: "/organizations", token: founder.accessToken, payload: { displayName: uniq("RealCo "), industry: "Real estate" } });

  const list = await api(app, { method: "GET", url: "/recommendations/organizations?limit=25", token: viewer.accessToken });
  const item = list.body.organizations.find((o: any) => o.id === org.body.id);
  assert.ok(item);

  const explain = await api(app, { method: "GET", url: `/recommendations/explain/${item.recommendationId}`, token: viewer.accessToken });
  assert.equal(explain.status, 200);
  assert.equal(explain.body.reason, item.reason);
  assert.ok(explain.body.evidence);
  assert.equal(explain.body.evidence.industryMatch, true);
  // Never a name, a person id, or a specific relationship tag — counts only.
  assert.equal(JSON.stringify(explain.body.evidence).match(/personId|ownerId|tagId/), null);

  const stranger = await createUser(app);
  const denied = await api(app, { method: "GET", url: `/recommendations/explain/${item.recommendationId}`, token: stranger.accessToken });
  assert.equal(denied.status, 404, "explain must never reveal another person's impression");
});

test("jobsYouMayLike: empty without the objective, non-empty once 'Find employment' is declared", async () => {
  const app = await testApp();
  const viewer = await createUser(app);
  const employer = await createUser(app);
  const org = await createOrg(app, employer);
  const job = await tdb().job.create({
    data: { organizationId: org.id, createdById: employer.personId, title: uniq("Welder "), description: "Welding work on-site.", requirements: [], languages: [], status: "OPEN" },
  });

  const before = await api(app, { method: "GET", url: "/recommendations/jobs", token: viewer.accessToken });
  assert.equal(before.status, 200);
  assert.equal(before.body.jobs.length, 0, "no objective declared yet — never a fake list");

  await api(app, { method: "PATCH", url: "/me/profile", token: viewer.accessToken, payload: { objectives: ["Find employment"] } });
  const after = await api(app, { method: "GET", url: "/recommendations/jobs", token: viewer.accessToken });
  assert.equal(after.status, 200);
  assert.ok(after.body.jobs.some((j: any) => j.id === job.id), "the OPEN job should now surface");
  assert.ok(after.body.jobs.every((j: any) => j.reason && j.recommendationId));
});

test("candidatesForJob: recruiters only — gated on org.hire", async () => {
  const app = await testApp();
  const employer = await createUser(app);
  const org = await createOrg(app, employer);
  const job = await tdb().job.create({
    data: { organizationId: org.id, createdById: employer.personId, title: "Machinist", description: "Shop floor work.", requirements: ["lathe"], languages: [], status: "OPEN" },
  });
  const outsider = await createUser(app);

  const forbidden = await api(app, { method: "GET", url: `/recommendations/candidates?jobId=${job.id}`, token: outsider.accessToken });
  assert.equal(forbidden.status, 403);

  const allowed = await api(app, { method: "GET", url: `/recommendations/candidates?jobId=${job.id}`, token: employer.accessToken });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(allowed.body.candidates));

  const missingJob = await api(app, { method: "GET", url: "/recommendations/candidates?jobId=doesnotexist", token: employer.accessToken });
  assert.equal(missingJob.status, 404);
});

test("experiments: assignment is stable per person, splits across a population, and results count real events", async () => {
  const app = await testApp();
  const staff = await createUser(app);
  await grantStaff(staff.personId);
  const key = uniq("exp-reco-");

  const missing = await api(app, { method: "POST", url: "/admin/experiments", token: staff.accessToken, payload: { key: uniq("exp-bad-") } });
  assert.equal(missing.status, 400, "every field is required");

  const create = await api(app, {
    method: "POST",
    url: "/admin/experiments",
    token: staff.accessToken,
    payload: {
      key,
      hypothesis: "Showing byn-v1 first increases follows.",
      population: "All signed-in members",
      treatment: "New ranking order (treatment:50)",
      control: "Existing ranking order",
      successMetrics: ["follow"],
      guardrailMetrics: ["unfollow"],
      minSample: 5,
      rollbackCriteria: "Guardrail regresses by more than 5%.",
    },
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.status, "DRAFT");

  const beforeRunning = await api(app, { method: "GET", url: "/experiments/active", token: staff.accessToken });
  assert.equal(beforeRunning.body.experiments[key], undefined, "a DRAFT experiment is not active yet");

  const run = await api(app, { method: "PATCH", url: `/admin/experiments/${create.body.id}`, token: staff.accessToken, payload: { status: "RUNNING" } });
  assert.equal(run.status, 200);
  assert.equal(run.body.status, "RUNNING");

  const badTransition = await api(app, { method: "PATCH", url: `/admin/experiments/${create.body.id}`, token: staff.accessToken, payload: { status: "DRAFT" } });
  assert.equal(badTransition.status, 400);

  const people = [] as Awaited<ReturnType<typeof createUser>>[];
  for (let i = 0; i < 40; i++) people.push(await createUser(app));

  const variants = new Set<string>();
  const expectedFollowCount: Record<string, number> = { control: 0, treatment: 0 };
  for (const p of people) {
    const first = await api(app, { method: "GET", url: "/experiments/active", token: p.accessToken });
    assert.equal(first.status, 200);
    const v1 = first.body.experiments[key];
    variants.add(v1);
    expectedFollowCount[v1] = (expectedFollowCount[v1] ?? 0) + 1;
    await api(app, { method: "POST", url: "/analytics/events", token: p.accessToken, payload: { events: [{ event: "follow" }] } });

    const second = await api(app, { method: "GET", url: "/experiments/active", token: p.accessToken });
    assert.equal(second.body.experiments[key], v1, "the same person must keep the same variant across calls");
  }
  assert.ok(variants.has("control") && variants.has("treatment"), "40 people at 50/50 should produce both variants");

  const results = await api(app, { method: "GET", url: `/admin/experiments/${create.body.id}/results`, token: staff.accessToken });
  assert.equal(results.status, 200);
  assert.equal(results.body.variants.control.success.follow, expectedFollowCount.control);
  assert.equal(results.body.variants.treatment.success.follow, expectedFollowCount.treatment);
  assert.equal(results.body.variants.control.sampleSize, expectedFollowCount.control);
  assert.equal(results.body.variants.treatment.sampleSize, expectedFollowCount.treatment);

  const pause = await api(app, { method: "PATCH", url: `/admin/experiments/${create.body.id}`, token: staff.accessToken, payload: { status: "PAUSED" } });
  assert.equal(pause.status, 200);
  const freshPerson = await createUser(app);
  const afterPause = await api(app, { method: "GET", url: "/experiments/active", token: freshPerson.accessToken });
  assert.equal(afterPause.body.experiments[key], undefined, "a PAUSED experiment must not appear as active");
});

test("feature flags: PUT is audited, and GET /flags reflects a PERCENT rollout deterministically", async () => {
  const app = await testApp();
  const staff = await createUser(app);
  await grantStaff(staff.personId);
  const key = uniq("flag.reco.");

  const notStaff = await createUser(app);
  const denied = await api(app, { method: "PUT", url: `/admin/flags/${key}`, token: notStaff.accessToken, payload: { enabled: true, rollout: 50, audience: "PERCENT" } });
  assert.equal(denied.status, 403);

  const put = await api(app, {
    method: "PUT",
    url: `/admin/flags/${key}`,
    token: staff.accessToken,
    payload: { enabled: true, rollout: 50, audience: "PERCENT", allowPersons: [], allowOrgs: [], description: "test flag" },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.audience, "PERCENT");

  const auditRow = await tdb().auditLog.findFirst({ where: { action: "flag.updated", targetId: key }, orderBy: { createdAt: "desc" } });
  assert.ok(auditRow, "a flag change must be audited");
  assert.equal(auditRow!.actorId, staff.personId);

  const list = await api(app, { method: "GET", url: "/admin/flags", token: staff.accessToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.flags.some((f: any) => f.key === key));

  const person = await createUser(app);
  const flagsRes1 = await api(app, { method: "GET", url: "/flags", token: person.accessToken });
  const flagsRes2 = await api(app, { method: "GET", url: "/flags", token: person.accessToken });
  assert.equal(flagsRes1.body.flags[key], flagsRes2.body.flags[key], "a PERCENT rollout must bucket the same person the same way every time");

  // Emergency disable = enabled:false, and it too is audited.
  const off = await api(app, { method: "PUT", url: `/admin/flags/${key}`, token: staff.accessToken, payload: { enabled: false, rollout: 50, audience: "PERCENT" } });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  const flagsAfterOff = await api(app, { method: "GET", url: "/flags", token: person.accessToken });
  assert.equal(flagsAfterOff.body.flags[key], false);
});
