// Port landing + port watchdog: the automation that runs when a ported
// number arrives from the old carrier. Covers the stage machine (route →
// SMS → mapping → switch → retire → email), the two gates (switch landed,
// port order completed), idempotency, and the sweep's filtering/alerting.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

mock.module("@connect/db", { namedExports: { db: {} } });
mock.module("@connect/security", {
  namedExports: {
    encryptJson: (v: unknown) => "enc:" + JSON.stringify(v),
    decryptJson: (s: string) => JSON.parse(String(s).replace(/^enc:/, "")),
  },
});

let landing: typeof import("./portLanding");
let watchdog: typeof import("./portWatchdog");
test.before(async () => {
  landing = await import("./portLanding");
  watchdog = await import("./portWatchdog");
});

// ── In-memory DB fake ─────────────────────────────────────────────────────────

function makeState() {
  return {
    submissions: new Map<string, any>(),
    events: [] as Array<{ submissionId: string; message: string }>,
    billing: null as any,
    smsNumbers: [] as any[],
    smsNumberUsers: [] as any[],
    mappings: [] as any[],
    schedules: [] as any[],
    emails: [] as any[],
  };
}
type S = ReturnType<typeof makeState>;

let idSeq = 0;
const nextId = () => `id_${++idSeq}`;

function makeDb(s: S) {
  return {
    onboardingSubmission: {
      findMany: async () => [...s.submissions.values()],
      update: async ({ where, data }: any) => {
        const row = s.submissions.get(where.id);
        Object.assign(row, data);
        return row;
      },
    },
    onboardingEvent: {
      create: async ({ data }: any) => {
        s.events.push({ submissionId: data.submissionId, message: data.message });
        return data;
      },
    },
    tenantBillingSettings: {
      findUnique: async () => s.billing,
    },
    tenantSmsNumber: {
      findUnique: async ({ where }: any) =>
        s.smsNumbers.find((r) => (where.phoneE164 ? r.phoneE164 === where.phoneE164 : r.id === where.id)) || null,
      upsert: async ({ where, create, update }: any) => {
        let row = s.smsNumbers.find((r) => r.phoneE164 === where.phoneE164);
        if (row) Object.assign(row, update);
        else {
          row = { id: nextId(), tenantId: null, assignedUserId: null, assignedExtensionId: null, isTenantDefault: false, active: true, ...create };
          s.smsNumbers.push(row);
        }
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = s.smsNumbers.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        for (const r of s.smsNumbers) {
          if (where.tenantId && r.tenantId !== where.tenantId) continue;
          if (where.isTenantDefault !== undefined && r.isTenantDefault !== where.isTenantDefault) continue;
          Object.assign(r, data);
        }
        return { count: 1 };
      },
    },
    tenantSmsNumberUser: {
      findMany: async ({ where }: any) => s.smsNumberUsers.filter((r) => r.tenantSmsNumberId === where.tenantSmsNumberId),
      createMany: async ({ data }: any) => {
        s.smsNumberUsers.push(...data.map((d: any) => ({ id: nextId(), ...d })));
        return { count: data.length };
      },
      deleteMany: async ({ where }: any) => {
        s.smsNumberUsers = s.smsNumberUsers.filter((r) => r.tenantSmsNumberId !== where.tenantSmsNumberId);
        return { count: 1 };
      },
    },
    didRouteMapping: {
      findUnique: async ({ where }: any) =>
        s.mappings.find((r) => (where.e164 ? r.e164 === where.e164 : r.id === where.id)) || null,
      create: async ({ data }: any) => {
        const row = { id: nextId(), routingMode: "pbx", ...data };
        s.mappings.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = s.mappings.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: any) => {
        const i = s.mappings.findIndex((r) => r.id === where.id);
        if (i < 0) throw new Error("not found");
        return s.mappings.splice(i, 1)[0];
      },
    },
    didSwitchSchedule: {
      create: async ({ data }: any) => {
        const row = { id: nextId(), status: "pending", ...data };
        s.schedules.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => s.schedules.find((r) => r.id === where.id) || null,
      updateMany: async ({ where, data }: any) => {
        for (const r of s.schedules) {
          if (where.mappingId && r.mappingId !== where.mappingId) continue;
          if (where.status && r.status !== where.status) continue;
          Object.assign(r, data);
        }
        return { count: 1 };
      },
    },
    emailJob: {
      create: async ({ data }: any) => {
        s.emails.push(data);
        return data;
      },
    },
  };
}

// ── VoIP.ms fake (injected, not fetch-level — the deps take a vms function) ──

type VmsCall = { method: string; params: Record<string, string> };
function makeVms(handlers: Record<string, (p: Record<string, string>) => any>, calls: VmsCall[]) {
  return async (_creds: any, method: string, params: Record<string, string> = {}) => {
    calls.push({ method, params });
    const h = handlers[method];
    const body = h ? h(params) : { status: "success" };
    if (String(body?.status || "").toLowerCase() !== "success") throw new Error(`voipms ${method} failed: ${body?.status}`);
    return body;
  };
}

const CREDS = { username: "344022", password: "pw" };

function submission(s: S, over: Partial<any> = {}) {
  const row: any = {
    id: "sub1",
    companyName: "Anymini",
    paidAt: new Date(),
    status: "ACTIVE",
    phoneNumberChoice: "port",
    createdTenantId: "tenant1",
    provisionedDid: "8452605692",
    voipmsSubaccountEncrypted: "enc:" + JSON.stringify({ username: "344022_anymini1", password: "x", server: "newyork1.voip.ms" }),
    answers: {
      phone: { choice: "port", details: { numbers: "646-984-6023" } },
      provisioning: { portFiled: true, portId: "217760" },
    },
    ...over,
  };
  s.submissions.set(row.id, row);
  return row;
}

/** The usual pre-existing Connect state: temp number claimed + on Connect. */
function seedTempState(s: S) {
  s.billing = { smsBillingEnabled: true };
  s.smsNumbers.push({
    id: "sms_temp",
    phoneE164: "+18452605692",
    tenantId: "tenant1",
    assignedUserId: "user_baila",
    assignedExtensionId: "ext_101",
    isTenantDefault: true,
    active: true,
    smsCapable: true,
  });
  s.mappings.push({
    id: "map_temp",
    tenantId: "tenant1",
    e164: "+8452605692",
    routingMode: "connect",
    ivrProfileId: "menu1",
    mohProfileId: null,
    holdAnnouncePromptRef: null,
    holdRepeatSec: 30,
    fallbackBehavior: "default_ivr",
    pbxInstanceId: "pbx1",
  });
}

function deps(s: S, handlers: Record<string, (p: Record<string, string>) => any>, calls: VmsCall[], smsOk = true) {
  return {
    db: makeDb(s),
    vms: makeVms(handlers, calls),
    enableSmsOnDid: async () => (smsOk ? { ok: true, detail: "enabled" } : { ok: false, detail: "sms_wait_message" }),
  };
}

const ROUTED_OK = {
  setDIDRouting: () => ({ status: "success" }),
  getDIDsInfo: (p: any) => ({
    status: "success",
    dids: [{ did: p.did, routing: p.did === "8452605692" ? "account:344022" : "account:344022_anymini1", sms_enabled: "1" }],
  }),
};

// ── runPortLanding: the stage machine ─────────────────────────────────────────

test("arrival before completion: routes, moves SMS, mirrors the mapping, books the switch — and does NOT retire the temp number", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];

  const r = await landing.runPortLanding(row, CREDS, /*portCompleted*/ false, deps(s, ROUTED_OK, calls));
  assert.equal(r.done, false);
  assert.equal(r.stage, "waiting_for_switch");

  // 1 — routed to the subaccount, verified by re-read
  const route = calls.find((c) => c.method === "setDIDRouting")!;
  assert.equal(route.params.did, "6469846023");
  assert.equal(route.params.routing, "account:344022_anymini1");

  // 2 — SMS: real number claimed, tenant default moved, assignment copied
  const ported = s.smsNumbers.find((r2) => r2.phoneE164 === "+16469846023")!;
  assert.equal(ported.tenantId, "tenant1");
  assert.equal(ported.assignedUserId, "user_baila");
  assert.equal(ported.assignedExtensionId, "ext_101");
  assert.equal(ported.isTenantDefault, true);
  assert.equal(s.smsNumbers.find((r2) => r2.id === "sms_temp")!.isTenantDefault, false);

  // 3 — mapping mirrors the temp number's menu
  const map = s.mappings.find((m) => m.e164 === "+6469846023")!;
  assert.equal(map.ivrProfileId, "menu1");
  assert.equal(map.tenantId, "tenant1");

  // 4 — switch booked through the real scheduler machinery
  assert.equal(s.schedules.length, 1);
  assert.equal(s.schedules[0].mappingId, map.id);
  assert.equal(s.schedules[0].status, "pending");

  // temp number untouched, no email yet
  assert.ok(!calls.find((c) => c.method === "setDIDRouting" && c.params.did === "8452605692"));
  assert.equal(s.emails.length, 0);
});

test("switch landed + port completed: retires the temp number back to the master account and emails once", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];
  const d = deps(s, ROUTED_OK, calls);

  // First pass books the switch…
  await landing.runPortLanding(row, CREDS, true, d);
  // …the scheduler tick then flips the mapping to connect:
  s.mappings.find((m) => m.e164 === "+6469846023")!.routingMode = "connect";
  s.schedules[0].status = "activated";

  const r = await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(r.done, true);

  // temp DID re-routed to the MASTER account (spare pool)
  const retire = calls.filter((c) => c.method === "setDIDRouting" && c.params.did === "8452605692");
  assert.equal(retire.length, 1);
  assert.equal(retire[0].params.routing, "account:344022");

  // temp texting row un-claimed
  const temp = s.smsNumbers.find((r2) => r2.id === "sms_temp")!;
  assert.equal(temp.tenantId, null);
  assert.equal(temp.assignedUserId, null);
  assert.equal(temp.isTenantDefault, false);

  // temp mapping deleted so a future customer can claim the number
  assert.ok(!s.mappings.find((m) => m.e164 === "+8452605692"));

  // exactly one completion email, and running again changes nothing
  assert.equal(s.emails.length, 1);
  assert.match(s.emails[0].subject, /Port complete/);
  const again = await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(again.done, true);
  assert.equal(s.emails.length, 1);
  assert.equal(retire.length, 1);
});

test("port completed but the switch has not landed yet: retirement waits", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];
  const d = deps(s, ROUTED_OK, calls);

  const r = await landing.runPortLanding(row, CREDS, true, d); // books the switch, still pending
  assert.equal(r.done, false);
  assert.equal(r.stage, "waiting_for_switch");
  assert.ok(!calls.find((c) => c.method === "setDIDRouting" && c.params.did === "8452605692"));
});

test("temp number was never on Connect: no switch booked, retirement happens straight away once completed", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  s.mappings.find((m) => m.e164 === "+8452605692")!.routingMode = "pbx";
  const calls: VmsCall[] = [];

  const r = await landing.runPortLanding(row, CREDS, true, deps(s, ROUTED_OK, calls));
  assert.equal(r.done, true);
  assert.equal(s.schedules.length, 0);
  assert.ok(calls.find((c) => c.method === "setDIDRouting" && c.params.did === "8452605692"));
});

test("no texting on the account: SMS stage skips cleanly, everything else proceeds", async () => {
  const s = makeState();
  const row = submission(s);
  s.billing = { smsBillingEnabled: false };
  s.mappings.push({ id: "map_temp", tenantId: "tenant1", e164: "+8452605692", routingMode: "pbx", ivrProfileId: null, holdRepeatSec: 30, fallbackBehavior: "default_ivr", pbxInstanceId: "pbx1" });
  const calls: VmsCall[] = [];

  const r = await landing.runPortLanding(row, CREDS, true, deps(s, ROUTED_OK, calls));
  assert.equal(r.done, true);
  assert.ok(!s.smsNumbers.find((r2) => r2.phoneE164 === "+16469846023"));
});

test("carrier refuses the SMS flag: stage stays open and retries next sweep, routing survives", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];

  const r1 = await landing.runPortLanding(row, CREDS, false, deps(s, ROUTED_OK, calls, /*smsOk*/ false));
  assert.equal(r1.done, false);
  assert.equal(r1.stage, "sms_pending");
  assert.ok(row.answers.provisioning.portLanding.routedAt); // step 1 persisted

  // Next sweep: carrier now cooperates — no double routing call.
  const before = calls.filter((c) => c.method === "setDIDRouting").length;
  const r2 = await landing.runPortLanding(row, CREDS, false, deps(s, ROUTED_OK, calls, true));
  assert.equal(r2.stage, "waiting_for_switch");
  assert.equal(calls.filter((c) => c.method === "setDIDRouting").length, before);
  assert.ok(s.smsNumbers.find((r2b) => r2b.phoneE164 === "+16469846023"));
});

test("routing that does not stick is an error, not a recorded success", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];
  const handlers = {
    setDIDRouting: () => ({ status: "success" }), // lies, like the real API can
    getDIDsInfo: (p: any) => ({ status: "success", dids: [{ did: p.did, routing: "account:344022" }] }),
  };

  await assert.rejects(() => landing.runPortLanding(row, CREDS, false, deps(s, handlers, calls)));
  assert.ok(!row.answers.provisioning?.portLanding?.routedAt);
});

// ── sweepOpenPorts: the watchdog around it ────────────────────────────────────

function watchdogDeps(s: S, handlers: Record<string, (p: Record<string, string>) => any>, calls: VmsCall[], smsOk = true) {
  return { ...deps(s, handlers, calls, smsOk), loadCreds: async () => CREDS };
}

test("sweep: not-yet-arrived port waits; arrival triggers the landing; status transitions hit the timeline", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];
  let onAccount = false;
  const handlers = {
    ...ROUTED_OK,
    getLNPStatus: () => ({ status: "success", post_status: "In Progress" }),
    getDIDsInfo: (p: any) =>
      p.did === "6469846023" && !onAccount
        ? { status: "error" } // VoIP.ms errors the lookup until the number exists
        : ROUTED_OK.getDIDsInfo(p),
  };

  const s1 = await watchdog.sweepOpenPorts(watchdogDeps(s, handlers, calls));
  assert.equal(s1.scanned, 1);
  assert.equal(s1.waitingForCarrier, 1);
  assert.ok(s.events.find((e) => /status: In Progress/.test(e.message)));

  onAccount = true;
  const s2 = await watchdog.sweepOpenPorts(watchdogDeps(s, handlers, calls));
  assert.equal(s2.landedOrProgressed, 1);
  assert.ok(row.answers.provisioning.portLanding.routedAt);
});

test("sweep: completed landing drops out of the sweep; unfiled and non-port rows never enter it", async () => {
  const s = makeState();
  const done = submission(s, { id: "done1" });
  done.answers.provisioning.portLanding = { completedAt: new Date().toISOString() };
  submission(s, { id: "unfiled", answers: { phone: { choice: "port", details: { numbers: "6469846023" } }, provisioning: {} } });
  const calls: VmsCall[] = [];

  const sum = await watchdog.sweepOpenPorts(watchdogDeps(s, ROUTED_OK, calls));
  assert.equal(sum.scanned, 0);
  assert.equal(calls.length, 0);
});

test("sweep: a rejected port emails the admin once per status change", async () => {
  const s = makeState();
  submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];
  const handlers = {
    ...ROUTED_OK,
    getLNPStatus: () => ({ status: "success", post_status: "Rejected - account number mismatch" }),
    getDIDsInfo: () => ({ status: "error" }),
  };

  await watchdog.sweepOpenPorts(watchdogDeps(s, handlers, calls));
  await watchdog.sweepOpenPorts(watchdogDeps(s, handlers, calls)); // same status again — no second email
  const alerts = s.emails.filter((e) => /needs attention/.test(e.subject));
  assert.equal(alerts.length, 1);
});

test("sweep: repeated landing failures alert exactly once, at the threshold", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];
  // Arrival yes, but routing never sticks → runPortLanding throws every sweep.
  const handlers = {
    setDIDRouting: () => ({ status: "success" }),
    getDIDsInfo: (p: any) => ({ status: "success", dids: [{ did: p.did, routing: "account:344022" }] }),
    getLNPStatus: () => ({ status: "success", post_status: "In Progress" }),
  };

  for (let i = 0; i < 10; i++) {
    await watchdog.sweepOpenPorts(watchdogDeps(s, handlers, calls));
  }
  assert.equal(row.answers.provisioning.portLanding.failures, 10);
  const stuck = s.emails.filter((e) => /Port landing stuck/.test(e.subject));
  assert.equal(stuck.length, 1);
});
