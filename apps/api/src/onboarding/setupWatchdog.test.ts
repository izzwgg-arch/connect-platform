// Tests for the onboarding setup watchdog (setupWatchdog.ts): the boot-time
// sweep that rescues paid sign-ups whose build died mid-run (API restart while
// "building"/"syncing"/"inviting", or a "failed" row nobody retried), and the
// 5-resume cap that escalates to an admin alert email instead of retrying
// forever. Also covers isSetupStalled, which the public progress endpoint
// uses to stop showing an infinite spinner.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

let seq = 0;
const nid = (p: string) => `${p}_${++seq}`;

const state = {
  submissions: new Map<string, any>(),
  events: [] as Array<{ submissionId: string; type: string; message: string }>,
  emailJobs: [] as any[],
};

// findMany interprets the exact where-shape the watchdog sends, so a test row
// only comes back when the real query would have matched it.
const dbMock: any = {
  onboardingSubmission: {
    findMany: async ({ where, take }: any) => {
      const unfinished: string[] = where.OR[1].pbxSetupStatus.in;
      return [...state.submissions.values()]
        .filter(
          (r) =>
            r.paidAt != null &&
            String(r.status) !== where.status.not &&
            new Date(r.updatedAt) < where.updatedAt.lt &&
            (r.pbxSetupStatus == null || unfinished.includes(String(r.pbxSetupStatus))),
        )
        .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
        .slice(0, take);
    },
  },
  onboardingEvent: {
    create: async ({ data }: any) => {
      state.events.push({ submissionId: data.submissionId, type: data.type, message: data.message });
      return data;
    },
    count: async ({ where }: any) =>
      state.events.filter(
        (e) => e.submissionId === where.submissionId && e.message.startsWith(where.message.startsWith),
      ).length,
    findFirst: async ({ where }: any) =>
      state.events.find(
        (e) => e.submissionId === where.submissionId && e.message.startsWith(where.message.startsWith),
      ) || null,
  },
  emailJob: {
    create: async ({ data }: any) => {
      state.emailJobs.push(data);
      return data;
    },
  },
};

mock.module("@connect/db", { namedExports: { db: dbMock } });

const applyNumberCalls: string[] = [];
let applyNumberError: Error | null = null;
mock.module("./voipMsProvisioning", {
  namedExports: {
    applyOnboardingNumber: async (id: string) => {
      applyNumberCalls.push(id);
      if (applyNumberError) throw applyNumberError;
      return { ok: true, detail: "ready" };
    },
  },
});

const runSetupCalls: string[] = [];
let runSetupBehavior: (id: string) => void | Promise<void> = () => {};
mock.module("./setupOrchestrator", {
  namedExports: {
    runOnboardingSetup: async (id: string) => {
      runSetupCalls.push(id);
      await runSetupBehavior(id);
    },
  },
});

let watchdog: typeof import("./setupWatchdog");
test.before(async () => {
  watchdog = await import("./setupWatchdog");
});

const MIN = 60_000;

function reset() {
  state.submissions.clear();
  state.events = [];
  state.emailJobs = [];
  applyNumberCalls.length = 0;
  runSetupCalls.length = 0;
  applyNumberError = null;
  runSetupBehavior = () => {};
  delete process.env.ONBOARDING_INFLIGHT_STALE_MS;
  delete process.env.ADMIN_ALERT_EMAIL;
}

function seedSubmission(over: Partial<any> = {}): string {
  const id = over.id || nid("sub");
  state.submissions.set(id, {
    id,
    companyName: "Bobs Plumbing",
    mainEmail: "bob@x.com",
    status: "SUBMITTED",
    paidAt: new Date(Date.now() - 60 * MIN),
    pbxSetupStatus: "building",
    setupError: null,
    updatedAt: new Date(Date.now() - 20 * MIN), // stale by default (window is 15 min)
    ...over,
  });
  return id;
}

/** Seed n prior watchdog-resume events (the shape the sweep itself writes). */
function seedResumeEvents(submissionId: string, n: number) {
  for (let i = 1; i <= n; i++) {
    state.events.push({
      submissionId,
      type: "STATUS_CHANGED",
      message: `${watchdog.WATCHDOG_RESUME_MESSAGE} (stuck in "building" for 20 min) — attempt ${i} of 5.`,
    });
  }
}

const eventsFor = (id: string) =>
  state.events.filter((e) => e.submissionId === id).map((e) => e.message).join("\n");

// ── The sweep ────────────────────────────────────────────────────────────────

test("stale paid in-flight row: event logged, number stage + setup re-kicked", async () => {
  reset();
  const id = seedSubmission({ pbxSetupStatus: "building" });
  const summary = await watchdog.sweepStalledOnboardingSetups();

  assert.equal(summary.resumed, 1);
  assert.equal(summary.alerted, 0);
  assert.deepEqual(applyNumberCalls, [id]);
  assert.deepEqual(runSetupCalls, [id]);
  assert.match(eventsFor(id), /Watchdog resumed a stalled setup/);
  assert.match(eventsFor(id), /stuck in "building" for 20 min/);
  assert.match(eventsFor(id), /attempt 1 of 5/);
});

test("every unfinished status is swept — including failed and never-started (null)", async () => {
  reset();
  const ids = [
    seedSubmission({ pbxSetupStatus: null }),
    seedSubmission({ pbxSetupStatus: "queued" }),
    seedSubmission({ pbxSetupStatus: "building" }),
    seedSubmission({ pbxSetupStatus: "syncing" }),
    seedSubmission({ pbxSetupStatus: "inviting" }),
    seedSubmission({ pbxSetupStatus: "failed", setupError: "boom" }),
  ];
  const summary = await watchdog.sweepStalledOnboardingSetups();
  assert.equal(summary.resumed, 6);
  assert.deepEqual([...runSetupCalls].sort(), [...ids].sort());
  const nullRow = ids[0];
  assert.match(eventsFor(nullRow), /stuck in "not started"/);
});

test("rows that must NOT be touched: fresh, unpaid, done, dry_run_done, canceled", async () => {
  reset();
  seedSubmission({ updatedAt: new Date(Date.now() - 5 * MIN) }); // in flight, not stale
  seedSubmission({ paidAt: null }); // never paid — nothing owed
  seedSubmission({ pbxSetupStatus: "done" });
  seedSubmission({ pbxSetupStatus: "dry_run_done" });
  seedSubmission({ status: "CANCELED" });
  const summary = await watchdog.sweepStalledOnboardingSetups();

  assert.equal(summary.resumed, 0);
  assert.equal(summary.alerted, 0);
  assert.equal(runSetupCalls.length, 0);
  assert.equal(state.events.length, 0);
});

test("a failing number stage does not stop the setup re-kick (both are best-effort)", async () => {
  reset();
  const id = seedSubmission();
  applyNumberError = new Error("voipms_down");
  const summary = await watchdog.sweepStalledOnboardingSetups();
  assert.equal(summary.resumed, 1);
  assert.deepEqual(runSetupCalls, [id]);
});

test("one stuck row never blocks the rest of the sweep", async () => {
  reset();
  const bad = seedSubmission({ id: "bad", updatedAt: new Date(Date.now() - 30 * MIN) });
  const good = seedSubmission({ id: "good", updatedAt: new Date(Date.now() - 20 * MIN) });
  runSetupBehavior = (id) => {
    if (id === bad) throw new Error("panel exploded");
  };
  const summary = await watchdog.sweepStalledOnboardingSetups();
  assert.equal(summary.resumed, 2);
  assert.ok(runSetupCalls.includes(good));
});

// ── The 5-resume cap ─────────────────────────────────────────────────────────

test("after 5 watchdog resumes: no more retries — ONE plain-English admin alert instead", async () => {
  reset();
  const id = seedSubmission({ pbxSetupStatus: "failed", setupError: "panel_not_configured" });
  seedResumeEvents(id, 5);

  const summary = await watchdog.sweepStalledOnboardingSetups();
  assert.equal(summary.resumed, 0);
  assert.equal(summary.alerted, 1);
  assert.equal(runSetupCalls.length, 0, "a capped row must not be re-kicked");
  assert.equal(applyNumberCalls.length, 0);

  // The give-up is on the timeline (the admin page shows it)…
  assert.match(eventsFor(id), /Watchdog gave up after 5 automatic resumes/);
  // …and the alert email rides the ADMIN_ALERT channel like the sign-up reports.
  assert.equal(state.emailJobs.length, 1);
  const job = state.emailJobs[0];
  assert.equal(job.type, "ADMIN_ALERT");
  assert.equal(job.toEmail, "tod10950@gmail.com");
  assert.match(job.subject, /Onboarding stuck: Bobs Plumbing/);
  assert.match(job.textBody, /paid for their phone system/);
  assert.match(job.textBody, /panel_not_configured/);
  assert.match(job.textBody, /Retry button/);

  // A second sweep stays quiet: the give-up event marks it handled.
  const again = await watchdog.sweepStalledOnboardingSetups();
  assert.equal(again.alerted, 0);
  assert.equal(state.emailJobs.length, 1, "the admin must not be spammed every minute");
});

test("4 prior resumes: still retried (the cap is >5, not >=4)", async () => {
  reset();
  const id = seedSubmission();
  seedResumeEvents(id, 4);
  const summary = await watchdog.sweepStalledOnboardingSetups();
  assert.equal(summary.resumed, 1);
  assert.equal(summary.alerted, 0);
  assert.deepEqual(runSetupCalls, [id]);
  assert.match(eventsFor(id), /attempt 5 of 5/);
});

test("ADMIN_ALERT_EMAIL overrides the alert recipient", async () => {
  reset();
  process.env.ADMIN_ALERT_EMAIL = "owner@example.com";
  const id = seedSubmission();
  seedResumeEvents(id, 5);
  await watchdog.sweepStalledOnboardingSetups();
  assert.equal(state.emailJobs[0].toEmail, "owner@example.com");
});

// ── isSetupStalled (drives the customer's "we hit a snag" message) ──────────

test("isSetupStalled: paid + in-flight + past the stale window ⇒ stalled", () => {
  reset();
  const base = { paidAt: new Date(), status: "SUBMITTED" };
  const stale = new Date(Date.now() - 20 * MIN);
  const fresh = new Date(Date.now() - 5 * MIN);

  for (const pbxSetupStatus of [null, "queued", "building", "syncing", "inviting", "failed"]) {
    assert.equal(
      watchdog.isSetupStalled({ ...base, pbxSetupStatus, updatedAt: stale }),
      true,
      `${pbxSetupStatus} + stale must count as stalled`,
    );
    assert.equal(
      watchdog.isSetupStalled({ ...base, pbxSetupStatus, updatedAt: fresh }),
      false,
      `${pbxSetupStatus} + fresh must NOT count as stalled`,
    );
  }
});

test("isSetupStalled: finished, unpaid, or canceled rows are never stalled", () => {
  reset();
  const stale = new Date(Date.now() - 20 * MIN);
  assert.equal(watchdog.isSetupStalled({ paidAt: new Date(), status: "ACTIVE", pbxSetupStatus: "done", updatedAt: stale }), false);
  assert.equal(watchdog.isSetupStalled({ paidAt: new Date(), status: "SUBMITTED", pbxSetupStatus: "dry_run_done", updatedAt: stale }), false);
  assert.equal(watchdog.isSetupStalled({ paidAt: null, status: "SUBMITTED", pbxSetupStatus: "building", updatedAt: stale }), false);
  assert.equal(watchdog.isSetupStalled({ paidAt: new Date(), status: "CANCELED", pbxSetupStatus: "building", updatedAt: stale }), false);
  assert.equal(watchdog.isSetupStalled(null), false);
});

test("isSetupStalled honors ONBOARDING_INFLIGHT_STALE_MS", () => {
  reset();
  process.env.ONBOARDING_INFLIGHT_STALE_MS = String(2 * MIN);
  try {
    const row = { paidAt: new Date(), status: "SUBMITTED", pbxSetupStatus: "building", updatedAt: new Date(Date.now() - 5 * MIN) };
    assert.equal(watchdog.isSetupStalled(row), true);
    process.env.ONBOARDING_INFLIGHT_STALE_MS = String(10 * MIN);
    assert.equal(watchdog.isSetupStalled(row), false);
  } finally {
    delete process.env.ONBOARDING_INFLIGHT_STALE_MS;
  }
});
