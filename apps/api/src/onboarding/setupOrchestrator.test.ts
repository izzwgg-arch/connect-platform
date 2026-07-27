// Stress tests for the post-launch orchestrator (setupOrchestrator.ts):
// number-stage gating, the PBX build hand-off, tenant linking, the RETRIED
// extension sync with the deterministic verify+repair pass (the part that has
// historically been flaky), invitation emails, status transitions, and
// failure recording.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

// ── World state (all Prisma models the flow touches) ─────────────────────────

let seq = 0;
const nid = (p: string) => `${p}_${++seq}`;

const state = {
  submissions: new Map<string, any>(),
  events: [] as Array<{ submissionId: string; message: string }>,
  pbxInstance: null as any,
  pbxDirs: [] as any[],
  tenantLinks: [] as any[],
  tenants: new Map<string, any>(),
  extensions: [] as any[],
  users: new Map<string, any>(), // by email
  passwordTokens: [] as any[],
  emailJobs: [] as any[],
  voipmsConfig: null as any,
};

function findExt(tenantId: string, extNumber: string) {
  return state.extensions.find((e) => e.tenantId === tenantId && e.extNumber === extNumber) || null;
}

const dbMock: any = {
  onboardingSubmission: {
    findUnique: async ({ where }: any) => {
      const row = state.submissions.get(where.id);
      return row ? { ...row, requestedExtensions: row.requestedExtensions || [] } : null;
    },
    update: async ({ where, data }: any) => {
      const row = state.submissions.get(where.id);
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  },
  onboardingEvent: {
    create: async ({ data }: any) => {
      state.events.push({ submissionId: data.submissionId, message: data.message });
      return data;
    },
  },
  globalVoipMsConfig: { findUnique: async () => state.voipmsConfig },
  pbxInstance: { findFirst: async () => state.pbxInstance },
  pbxTenantDirectory: { findMany: async () => state.pbxDirs },
  tenantPbxLink: {
    findFirst: async ({ where }: any) =>
      state.tenantLinks.find(
        (l) => l.pbxInstanceId === where.pbxInstanceId && l.pbxTenantId === where.pbxTenantId,
      ) || null,
    update: async ({ where, data }: any) => {
      const l = state.tenantLinks.find((x) => x.id === where.id);
      Object.assign(l, data);
      return l;
    },
    create: async ({ data }: any) => {
      const l = { id: nid("link"), ...data };
      state.tenantLinks.push(l);
      return l;
    },
  },
  tenant: {
    create: async ({ data }: any) => {
      const t = { id: nid("tenant"), ...data };
      state.tenants.set(t.id, t);
      return t;
    },
    update: async ({ where, data }: any) => {
      const t = state.tenants.get(where.id);
      if (!t) throw new Error("tenant_not_found");
      Object.assign(t, data);
      return t;
    },
  },
  extension: {
    findUnique: async ({ where }: any) => {
      const e = findExt(where.tenantId_extNumber.tenantId, where.tenantId_extNumber.extNumber);
      return e ? { ...e } : null;
    },
    update: async ({ where, data }: any) => {
      const e = state.extensions.find((x) => x.id === where.id);
      Object.assign(e, data);
      return e;
    },
  },
  user: {
    findUnique: async ({ where }: any) => state.users.get(where.email) || null,
    create: async ({ data }: any) => {
      const u = { id: nid("user"), ...data };
      state.users.set(u.email, u);
      return u;
    },
    update: async ({ where, data }: any) => {
      const u = [...state.users.values()].find((x) => x.id === where.id);
      if (!u) throw new Error("user_not_found");
      Object.assign(u, data);
      return u;
    },
  },
  userPasswordToken: {
    create: async ({ data }: any) => {
      state.passwordTokens.push(data);
      return data;
    },
  },
  emailJob: {
    create: async ({ data }: any) => {
      state.emailJobs.push(data);
      return data;
    },
  },
  $transaction: async (fn: any) => fn(dbMock),
};

mock.module("@connect/db", { namedExports: { db: dbMock } });
mock.module("@connect/security", {
  namedExports: {
    encryptJson: (v: unknown) => "enc:" + JSON.stringify(v),
    decryptJson: (s: string) => JSON.parse(String(s).replace(/^enc:/, "")),
  },
});

// VitalPbxClient is only constructed and passed through to the (mocked) sync.
mock.module("@connect/integrations", {
  namedExports: {
    VitalPbxClient: class {
      constructor(_cfg: any) {}
      async listTenants() {
        return state.pbxDirs.map((d) => ({ id: d.vitalTenantId, name: d.tenantSlug }));
      }
    },
  },
});

const dirSyncCalls: any[] = [];
mock.module("../pbxTenantDirectorySync", {
  namedExports: {
    syncPbxTenantDirectoryFromRows: async (_db: any, instanceId: string, rows: unknown[]) => {
      dirSyncCalls.push({ instanceId, rows });
      return { created: 0, updated: 0, deleted: 0 };
    },
  },
});

// The extension sync is replaced with a per-test behavior so we can simulate
// lag, partial results, and total failure.
let syncBehavior: (attempt: number) => void | Promise<void> = () => {};
let syncAttempts = 0;
mock.module("../pbxExtensionSync", {
  namedExports: {
    syncExtensionsFromPbx: async () => {
      syncAttempts++;
      await syncBehavior(syncAttempts);
      return { totalExtensions: 0, totalUpserted: 0, totalErrors: 0 };
    },
  },
});

mock.module("../userEmailTemplates", {
  namedExports: {
    welcomeCreatePasswordEmail: (input: any) => ({
      subject: `Welcome ${input.userName} (${input.tenantName} ext ${input.extensionNumber})`,
      html: `<a href="${input.setupUrl}">setup</a>`,
      text: input.setupUrl,
    }),
  },
});

let panelConfig: any = {
  baseUrl: "https://panel.example",
  accounts: [{ id: "robot", user: "r@x.com", pass: "pw" }],
  mainTenant: "main0000000000ff",
};
const panelLogins: string[] = [];
mock.module("./panelClient", {
  namedExports: {
    loadPanelConfig: () => panelConfig,
    PanelSession: class {
      account: any;
      constructor(_base: string, account: any) {
        this.account = account;
      }
      async login() {
        panelLogins.push(this.account.id);
        return this;
      }
      setTenant() {
        return this;
      }
    },
  },
});

let buildResult: any = { tenantPath: "feedfacefeedface" };
let buildError: Error | null = null;
const buildCalls: any[] = [];
mock.module("./pbxTenantBuild", {
  namedExports: {
    slugify: (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
    buildPbxTenant: async (_s: any, mainTenant: string, job: any, log?: (m: string) => void) => {
      buildCalls.push({ mainTenant, job });
      log?.("trunk ok (id 1)");
      if (buildError) throw buildError;
      return { company: job.company, slug: "bobs_plumbing", ...buildResult };
    },
  },
});

let orchestrator: typeof import("./setupOrchestrator");
test.before(async () => {
  orchestrator = await import("./setupOrchestrator");
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function reset(opts: { live?: boolean } = {}) {
  state.submissions.clear();
  state.events = [];
  state.pbxInstance = { id: "inst1", isEnabled: true, apiAuthEncrypted: "enc:" + JSON.stringify({ token: "t" }), baseUrl: "https://pbx.example" };
  state.pbxDirs = [];
  state.tenantLinks = [];
  state.tenants.clear();
  state.extensions = [];
  state.users.clear();
  state.passwordTokens = [];
  state.emailJobs = [];
  state.voipmsConfig = { credentialsEncrypted: "enc:" + JSON.stringify({ username: "344022", password: "pw" }) };
  dirSyncCalls.length = 0;
  buildCalls.length = 0;
  panelLogins.length = 0;
  buildError = null;
  buildResult = { tenantPath: "feedfacefeedface" };
  syncAttempts = 0;
  syncBehavior = () => {};
  panelConfig = {
    baseUrl: "https://panel.example",
    accounts: [{ id: "robot", user: "r@x.com", pass: "pw" }],
    mainTenant: "main0000000000ff",
  };
  process.env.ONBOARDING_RETRY_BASE_MS = "5";
  delete process.env.VOIPMS_AUTO_PROVISION;
  if (opts.live !== false) process.env.ONBOARDING_PBX_AUTO_SETUP = "on";
  else delete process.env.ONBOARDING_PBX_AUTO_SETUP;
}

test.afterEach(() => {
  delete process.env.ONBOARDING_PBX_AUTO_SETUP;
  delete process.env.ONBOARDING_RETRY_BASE_MS;
});

function seedSubmission(over: Partial<any> = {}): string {
  const id = over.id || nid("sub");
  state.submissions.set(id, {
    id,
    companyName: "Bobs Plumbing",
    phoneNumberChoice: "new",
    smsEnabled: false,
    status: "SUBMITTED",
    numberStatus: "ready",
    provisionedDid: "8455577726",
    didIsTemporary: false,
    voipmsSubaccountEncrypted:
      "enc:" + JSON.stringify({ username: "344022_BobsPlumbing1", password: "pw9a", server: "newyork1.voip.ms" }),
    pbxSetupStatus: null,
    setupError: null,
    createdTenantId: null,
    updatedAt: new Date(),
    answers: { phone: { choice: "new", selectedNumber: "8455577726" } },
    requestedExtensions: [
      { extNumber: "101", displayName: "John Doe", email: "john@x.com", vmPassword: "4321", cellMode: null, cellNumber: null },
      { extNumber: "102", displayName: "Jane Roe", email: "jane@x.com", cellMode: "also", cellNumber: "5622096644" },
    ],
    ...over,
  });
  return id;
}

/** Standard "the PBX build worked and sync finds everything" world. */
function wireHealthySync(tenantIdRef: { current: string | null } = { current: null }) {
  state.pbxDirs = [{ vitalTenantId: "9", tenantSlug: "bobs_plumbing", displayName: "Bobs Plumbing", tenantCode: "T9" }];
  syncBehavior = () => {
    const link = state.tenantLinks.find((l) => l.pbxTenantId === "9");
    if (!link) return;
    tenantIdRef.current = link.tenantId;
    for (const extNumber of ["101", "102"]) {
      if (!findExt(link.tenantId, extNumber)) {
        state.extensions.push({
          id: nid("ext"),
          tenantId: link.tenantId,
          extNumber,
          ownerUserId: null,
          pbxLink: { pbxSipUsername: `${extNumber}_1`, webrtcEnabled: true, sipPasswordEncrypted: "enc:sip" },
        });
      }
    }
  };
  return tenantIdRef;
}

const events = () => state.events.map((e) => e.message).join("\n");

// ── Dry run ───────────────────────────────────────────────────────────────────

test("gate off: fully-logged dry run, nothing created, status dry_run_done", async () => {
  reset({ live: false });
  const id = seedSubmission();
  await orchestrator.runOnboardingSetup(id);

  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "dry_run_done");
  assert.equal(buildCalls.length, 0);
  assert.equal(state.tenants.size, 0);
  assert.equal(state.emailJobs.length, 0);
  assert.match(events(), /\[dry-run\] Build VitalPBX tenant "Bobs Plumbing"/);
  assert.match(events(), /trunk 344022_BobsPlumbing1@newyork1\.voip\.ms/);
  assert.match(events(), /DID 8455577726/);
});

// ── Happy path ────────────────────────────────────────────────────────────────

test("happy path: build → link → sync → verify → invites → ACTIVE", async () => {
  reset();
  const id = seedSubmission();
  wireHealthySync();
  await orchestrator.runOnboardingSetup(id);

  const row = state.submissions.get(id);
  assert.equal(row.setupError, null);
  assert.equal(row.pbxSetupStatus, "done");
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.pbxTenantPath, "feedfacefeedface");

  // build got the exact job (subaccount trunk creds, DID, people incl. cell)
  assert.equal(buildCalls.length, 1);
  const job = buildCalls[0].job;
  assert.equal(job.company, "Bobs Plumbing");
  assert.equal(job.did, "8455577726");
  assert.deepEqual(job.voipms, { user: "344022_BobsPlumbing1", pass: "pw9a", server: "newyork1.voip.ms" });
  assert.equal(job.people.length, 2);
  assert.equal(job.people[1].cellMode, "also");
  assert.equal(job.people[1].cellNumber, "5622096644");
  assert.equal(job.people[0].vmPassword, "4321");

  // Connect tenant created with the REAL company name and LINKED
  assert.equal(row.createdTenantId, state.tenantLinks[0].tenantId);
  assert.equal(state.tenants.get(row.createdTenantId).name, "Bobs Plumbing");
  assert.equal(state.tenantLinks[0].status, "LINKED");
  assert.equal(state.tenantLinks[0].pbxTenantId, "9");

  // users created + ownership repaired + invites queued
  assert.ok(state.users.get("john@x.com"));
  assert.ok(state.users.get("jane@x.com"));
  for (const ext of state.extensions) assert.ok(ext.ownerUserId, `ext ${ext.extNumber} has no owner`);
  assert.equal(state.passwordTokens.length, 2);
  assert.ok(state.passwordTokens.every((t) => t.type === "INVITE"));
  assert.equal(state.emailJobs.length, 2);
  assert.ok(state.emailJobs.every((j) => j.type === "USER_INVITE" && j.status === "QUEUED"));
  assert.match(state.emailJobs[0].subject, /ext 101/);

  // invited users carry the same flags the admin invite path sets
  for (const email of ["john@x.com", "jane@x.com"]) {
    const u = state.users.get(email);
    assert.equal(u.status, "INVITED", `${email} not marked INVITED`);
    assert.equal(u.forcePasswordReset, true, `${email} missing forcePasswordReset`);
  }
});

test("sync lag: extensions only appear on the 3rd attempt — retries make it succeed", async () => {
  reset();
  const id = seedSubmission();
  state.pbxDirs = [{ vitalTenantId: "9", tenantSlug: "bobs_plumbing", displayName: "Bobs Plumbing" }];
  syncBehavior = (attempt) => {
    if (attempt < 3) return;
    const link = state.tenantLinks.find((l) => l.pbxTenantId === "9")!;
    for (const extNumber of ["101", "102"]) {
      if (!findExt(link.tenantId, extNumber)) {
        state.extensions.push({ id: nid("ext"), tenantId: link.tenantId, extNumber, ownerUserId: null, pbxLink: { pbxSipUsername: `${extNumber}_1`, webrtcEnabled: true, sipPasswordEncrypted: "enc:sip" } });
      }
    }
  };
  await orchestrator.runOnboardingSetup(id);
  assert.equal(state.submissions.get(id).pbxSetupStatus, "done");
  assert.equal(syncAttempts, 3);
  assert.equal(state.emailJobs.length, 2);
});

test("user repair: sync brings extensions but never creates users — orchestrator creates + owns + invites them", async () => {
  reset();
  const id = seedSubmission();
  wireHealthySync(); // healthy sync here never creates users (like the flaky real one)
  await orchestrator.runOnboardingSetup(id);

  const john = state.users.get("john@x.com");
  assert.ok(john, "user was not repaired into existence");
  assert.equal(john.role, "USER");
  assert.equal(john.displayName, "John Doe");
  const ext101 = state.extensions.find((e) => e.extNumber === "101")!;
  assert.equal(ext101.ownerUserId, john.id);
});

test("tenant reuse: background auto-sync already provisioned a slug-named tenant — reused and renamed, no duplicate", async () => {
  reset();
  const id = seedSubmission();
  wireHealthySync();
  // Simulate the auto-sync having auto-provisioned first (ugly derived name):
  const t = { id: nid("tenant"), name: "Bobs Plumbing (auto)", kind: "CUSTOMER" };
  state.tenants.set(t.id, t);
  state.tenantLinks.push({ id: nid("link"), tenantId: t.id, pbxInstanceId: "inst1", pbxTenantId: "9", status: "ERROR" });

  await orchestrator.runOnboardingSetup(id);
  assert.equal(state.tenants.size, 1); // no duplicate tenant
  assert.equal(state.tenants.get(t.id).name, "Bobs Plumbing"); // renamed to the real company
  assert.equal(state.tenantLinks[0].status, "LINKED"); // un-poisoned
  assert.equal(state.submissions.get(id).createdTenantId, t.id);
});

test("email conflict: address owned by ANOTHER tenant — no hijack, no invite, flow still completes, conflict logged", async () => {
  reset();
  const id = seedSubmission();
  wireHealthySync();
  state.users.set("john@x.com", { id: "other_user", tenantId: "someone_elses_tenant", email: "john@x.com" });

  await orchestrator.runOnboardingSetup(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "done");
  assert.equal(state.emailJobs.length, 1); // only jane
  assert.equal(state.emailJobs[0].toEmail, "jane@x.com");
  assert.match(events(), /Email already in use by another organization.*101.*john@x\.com/);
  const ext101 = state.extensions.find((e) => e.extNumber === "101")!;
  assert.equal(ext101.ownerUserId, null); // never hijacked
});

test("extension without an email: provisioned but simply not invited", async () => {
  reset();
  const id = seedSubmission({
    requestedExtensions: [
      { extNumber: "101", displayName: "John", email: "john@x.com" },
      { extNumber: "102", displayName: "Lobby Phone", email: null },
    ],
  });
  wireHealthySync();
  await orchestrator.runOnboardingSetup(id);
  assert.equal(state.submissions.get(id).pbxSetupStatus, "done");
  assert.equal(state.emailJobs.length, 1);
  // ...but the event log must SAY so — "Sent 0/1 invitation email(s)" alone
  // left the owner guessing (live confusion 2026-07-27).
  assert.match(events(), /No email entered for extension\(s\) 102 — they cannot receive a login invite/);
});

// ── The apply-number ⇄ submit race (live incident 2026-07-26) ─────────────────
// The customer hit "Launch" 6 seconds after leaving the number step: the
// number stage was still "provisioning", the orchestrator refused with
// number_stage_not_ready, and nothing ever picked the setup back up.

test("RACE: submit while the number stage is provisioning — setup WAITS, then completes", async () => {
  reset();
  wireHealthySync();
  const id = seedSubmission({ numberStatus: "provisioning" });
  // the background number task finishes shortly after submit
  setTimeout(() => {
    const row = state.submissions.get(id);
    row.numberStatus = "ready";
    row.updatedAt = new Date();
  }, 40);
  await orchestrator.runOnboardingSetup(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "done");
  assert.equal(buildCalls.length, 1);
  assert.match(events(), /waiting for it before building/i);
});

test("RACE: number stage finishes after submit failed — resumeSetupIfSubmitted carries it forward", async () => {
  reset();
  wireHealthySync();
  const id = seedSubmission({
    numberStatus: "ready",
    pbxSetupStatus: "failed",
    setupError: "number_stage_not_ready (already_running)",
  });
  await orchestrator.resumeSetupIfSubmitted(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "done");
  assert.equal(row.setupError, null);
  assert.equal(buildCalls.length, 1);
});

test("resumeSetupIfSubmitted is a no-op before submit and after done", async () => {
  reset();
  const notSubmitted = seedSubmission({ status: "ACTIVE" });
  await orchestrator.resumeSetupIfSubmitted(notSubmitted);
  assert.equal(buildCalls.length, 0);

  const done = seedSubmission({ pbxSetupStatus: "done" });
  await orchestrator.resumeSetupIfSubmitted(done);
  assert.equal(buildCalls.length, 0);
});

test("RACE: concurrent kicks run the setup exactly once", async () => {
  reset();
  wireHealthySync();
  const id = seedSubmission();
  await Promise.all([
    orchestrator.runOnboardingSetup(id),
    orchestrator.runOnboardingSetup(id),
    orchestrator.resumeSetupIfSubmitted(id),
  ]);
  assert.equal(state.submissions.get(id).pbxSetupStatus, "done");
  assert.equal(buildCalls.length, 1);
  assert.equal(state.emailJobs.length, 2, "invites must not be duplicated");
});

test("RACE: wait for number stage times out — fails, but a later resume kick succeeds", async () => {
  reset();
  wireHealthySync();
  process.env.ONBOARDING_NUMBER_WAIT_MS = "30"; // stuck "provisioning" past the wait window
  try {
    const id = seedSubmission({ numberStatus: "provisioning" });
    await orchestrator.runOnboardingSetup(id);
    let row = state.submissions.get(id);
    assert.equal(row.pbxSetupStatus, "failed");
    assert.match(row.setupError, /number_stage_not_ready/);

    // …the number task eventually finishes and fires the completion hook:
    row.numberStatus = "ready";
    row.updatedAt = new Date();
    await orchestrator.resumeSetupIfSubmitted(id);
    row = state.submissions.get(id);
    assert.equal(row.pbxSetupStatus, "done");
  } finally {
    delete process.env.ONBOARDING_NUMBER_WAIT_MS;
  }
});

// ── Failure paths ─────────────────────────────────────────────────────────────

test("number stage failed + unretryable: setup fails with number_stage_not_ready", async () => {
  reset();
  state.voipmsConfig = null; // retry inside the orchestrator can't succeed
  const id = seedSubmission({ numberStatus: "failed" });
  await orchestrator.runOnboardingSetup(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "failed");
  assert.match(row.setupError, /number_stage_not_ready/);
  assert.equal(buildCalls.length, 0);
});

test("panel not configured: fails before touching anything", async () => {
  reset();
  panelConfig = null;
  const id = seedSubmission();
  await orchestrator.runOnboardingSetup(id);
  assert.match(state.submissions.get(id).setupError, /panel_not_configured/);
});

test("PBX build failure surfaces the step error and marks failed", async () => {
  reset();
  const id = seedSubmission();
  buildError = new Error("[trunk] The trunk name already exists");
  await orchestrator.runOnboardingSetup(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "failed");
  assert.match(row.setupError, /trunk name already exists/);
  assert.equal(state.emailJobs.length, 0);
});

test("new PBX tenant never appears in the directory: fails with pbx_tenant_not_in_directory", async () => {
  reset();
  const id = seedSubmission();
  state.pbxDirs = []; // never shows up
  await orchestrator.runOnboardingSetup(id);
  assert.match(state.submissions.get(id).setupError, /pbx_tenant_not_in_directory/);
});

test("extensions never sync: fails with the missing list, no invites go out", async () => {
  reset();
  const id = seedSubmission();
  state.pbxDirs = [{ vitalTenantId: "9", tenantSlug: "bobs_plumbing", displayName: "Bobs Plumbing" }];
  syncBehavior = () => {}; // sync "succeeds" but never lands anything
  await orchestrator.runOnboardingSetup(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "failed");
  assert.match(row.setupError, /extensions_missing_after_sync: 101, 102/);
  assert.equal(syncAttempts, 5); // exhausted all retries
  assert.equal(state.emailJobs.length, 0);
});

test("extension exists but SIP never syncs: fails with sip_not_synced", async () => {
  reset();
  const id = seedSubmission();
  state.pbxDirs = [{ vitalTenantId: "9", tenantSlug: "bobs_plumbing", displayName: "Bobs Plumbing" }];
  syncBehavior = () => {
    const link = state.tenantLinks.find((l) => l.pbxTenantId === "9");
    if (!link) return;
    for (const extNumber of ["101", "102"]) {
      if (!findExt(link.tenantId, extNumber)) {
        state.extensions.push({ id: nid("ext"), tenantId: link.tenantId, extNumber, ownerUserId: null, pbxLink: null });
      }
    }
  };
  await orchestrator.runOnboardingSetup(id);
  assert.match(state.submissions.get(id).setupError, /sip_not_synced: 101, 102/);
});

test("WebRTC device exists but SIP password never captured: fails sip_not_synced (Sync SIP bar)", async () => {
  reset();
  const id = seedSubmission();
  state.pbxDirs = [{ vitalTenantId: "9", tenantSlug: "bobs_plumbing", displayName: "Bobs Plumbing" }];
  syncBehavior = () => {
    const link = state.tenantLinks.find((l) => l.pbxTenantId === "9");
    if (!link) return;
    for (const extNumber of ["101", "102"]) {
      if (!findExt(link.tenantId, extNumber)) {
        // link row + webrtc flag but no captured secret — the real Sync SIP
        // button would 409 with SIP_CREDENTIAL_NOT_SET here
        state.extensions.push({
          id: nid("ext"),
          tenantId: link.tenantId,
          extNumber,
          ownerUserId: null,
          pbxLink: { pbxSipUsername: `${extNumber}_1`, webrtcEnabled: true, sipPasswordEncrypted: null },
        });
      }
    }
  };
  await orchestrator.runOnboardingSetup(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "failed");
  assert.match(row.setupError, /sip_not_synced: 101, 102/);
  assert.equal(state.emailJobs.length, 0); // never invite before SIP is truly ready
});

test("throwing sync attempts are logged and retried, and a late success still completes", async () => {
  reset();
  const id = seedSubmission();
  state.pbxDirs = [{ vitalTenantId: "9", tenantSlug: "bobs_plumbing", displayName: "Bobs Plumbing" }];
  syncBehavior = (attempt) => {
    if (attempt < 2) throw new Error("PBX request failed");
    const link = state.tenantLinks.find((l) => l.pbxTenantId === "9")!;
    for (const extNumber of ["101", "102"]) {
      if (!findExt(link.tenantId, extNumber)) {
        state.extensions.push({ id: nid("ext"), tenantId: link.tenantId, extNumber, ownerUserId: null, pbxLink: { pbxSipUsername: extNumber, webrtcEnabled: true, sipPasswordEncrypted: "enc:sip" } });
      }
    }
  };
  await orchestrator.runOnboardingSetup(id);
  assert.equal(state.submissions.get(id).pbxSetupStatus, "done");
  assert.match(events(), /Extension sync attempt 1 failed: PBX request failed/);
});

// ── Guards ────────────────────────────────────────────────────────────────────

test("in-flight and completed runs are never restarted", async () => {
  reset();
  for (const status of ["building", "syncing", "inviting", "done"]) {
    const id = seedSubmission({ id: `guard_${status}`, pbxSetupStatus: status });
    await orchestrator.runOnboardingSetup(id);
    assert.equal(buildCalls.length, 0, `status ${status} must not re-run`);
  }
});

test("gate flipped on after a dry run: the same submission provisions for REAL on re-kick", async () => {
  reset(); // gate ON
  // The dry run left dry_run_done + a live-provisioned number stage.
  const id = seedSubmission({ pbxSetupStatus: "dry_run_done", numberStatus: "ready" });
  wireHealthySync();
  await orchestrator.runOnboardingSetup(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "done");
  assert.equal(buildCalls.length, 1); // actually built this time
  assert.equal(state.emailJobs.length, 2);
});

test("gate still off: a finished dry run is NOT spammed again", async () => {
  reset({ live: false });
  const id = seedSubmission({ pbxSetupStatus: "dry_run_done" });
  const eventsBefore = state.events.length;
  await orchestrator.runOnboardingSetup(id);
  assert.equal(state.events.length, eventsBefore); // returned early, no new logs
});

test("stale in-flight run (API restarted mid-build) is resumed instead of blocked forever", async () => {
  reset();
  const id = seedSubmission({
    pbxSetupStatus: "building",
    updatedAt: new Date(Date.now() - 20 * 60_000), // untouched for 20 min
  });
  wireHealthySync();
  await orchestrator.runOnboardingSetup(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "done");
  assert.match(events(), /interrupted mid-run.*resuming/i);
});

test("failed runs CAN be retried", async () => {
  reset();
  const id = seedSubmission({ pbxSetupStatus: "failed", setupError: "old_error" });
  wireHealthySync();
  await orchestrator.runOnboardingSetup(id);
  const row = state.submissions.get(id);
  assert.equal(row.pbxSetupStatus, "done");
  assert.equal(row.setupError, null);
});

// ── verifyAndRepairTenantExtensions (direct) ─────────────────────────────────

test("verifyAndRepair reports exactly what's missing without inventing success", async () => {
  reset();
  const tenantId = "tv1";
  state.extensions.push({ id: "e1", tenantId, extNumber: "101", ownerUserId: null, pbxLink: { pbxSipUsername: "101_1", webrtcEnabled: true, sipPasswordEncrypted: "enc:sip" } });
  state.extensions.push({ id: "e2", tenantId, extNumber: "102", ownerUserId: null, pbxLink: null });

  const out = await orchestrator.verifyAndRepairTenantExtensions(tenantId, [
    { extNumber: "101", displayName: "John", email: "john@x.com" },
    { extNumber: "102", displayName: "Jane", email: "JANE@X.COM" }, // case-normalized
    { extNumber: "103", displayName: "Ghost", email: "ghost@x.com" }, // never synced
  ]);

  const by = (n: string) => out.find((v) => v.extNumber === n)!;
  assert.deepEqual(
    { extensionOk: by("101").extensionOk, sipOk: by("101").sipOk, userOk: by("101").userOk },
    { extensionOk: true, sipOk: true, userOk: true },
  );
  assert.equal(by("102").sipOk, false); // no pbx link
  assert.equal(by("102").userOk, true); // user still created (lowercased)
  assert.ok(state.users.get("jane@x.com"));
  assert.equal(by("103").extensionOk, false);
  assert.equal(state.users.get("ghost@x.com"), undefined); // no user without an extension
});

// ── Stress: parallel onboardings through a 2-account panel pool ─────────────

test("stress: 6 concurrent onboardings share the panel account pool safely", async () => {
  reset();
  panelConfig.accounts = [
    { id: "robot-1", user: "r1@x.com", pass: "pw" },
    { id: "robot-2", user: "r2@x.com", pass: "pw" },
  ];
  state.pbxDirs = [];
  const companies = ["Alpha Co", "Beta LLC", "Gamma Inc", "Delta Corp", "Epsilon Ltd", "Zeta Group"];
  const ids = companies.map((company, i) => {
    state.pbxDirs.push({ vitalTenantId: String(10 + i), tenantSlug: company.toLowerCase().replace(/[^a-z0-9]+/g, "_"), displayName: company });
    return seedSubmission({
      id: `par_${i}`,
      companyName: company,
      requestedExtensions: [{ extNumber: "101", displayName: `P${i}`, email: `p${i}@x.com` }],
    });
  });
  syncBehavior = () => {
    for (const link of state.tenantLinks) {
      if (!findExt(link.tenantId, "101")) {
        state.extensions.push({ id: nid("ext"), tenantId: link.tenantId, extNumber: "101", ownerUserId: null, pbxLink: { pbxSipUsername: "101_1", webrtcEnabled: true, sipPasswordEncrypted: "enc:sip" } });
      }
    }
  };

  await Promise.all(ids.map((id) => orchestrator.runOnboardingSetup(id)));

  for (const id of ids) {
    const row = state.submissions.get(id);
    assert.equal(row.pbxSetupStatus, "done", `${id}: ${row.setupError}`);
    assert.ok(row.createdTenantId);
  }
  assert.equal(state.tenantLinks.length, 6);
  assert.equal(new Set(state.tenantLinks.map((l) => l.tenantId)).size, 6);
  assert.equal(state.emailJobs.length, 6);
  // both pool accounts were exercised
  assert.ok(panelLogins.includes("robot-1") && panelLogins.includes("robot-2"));
});
