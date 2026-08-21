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

// ── The transfer date the customer actually asks about ───────────────────────
// The chat assistant answers "when does my number move?" from Connect's own
// mirror, so the sweep has to WRITE the FOC date. It only exists on
// getLNPList — getLNPStatus returns status text and nothing else (both shapes
// probed read-only against the live API, 2026-08-21).

test("sweep: the order list supplies the transfer date, and the per-order status call is not made", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];
  const handlers = {
    ...ROUTED_OK,
    getLNPList: () => ({
      status: "success",
      list: [
        { portid: "999999", numbers: "5551234567", foc_date: "2026-01-01", port_status: "completed" },
        { portid: "217760", numbers: "6469846023", foc_date: "2026-09-04", port_status: "foc_received", port_status_description: "FOC Received" },
      ],
    }),
    getLNPStatus: () => {
      throw new Error("must not be called when the list already names this order");
    },
    getDIDsInfo: () => ({ status: "error" }), // not on the account yet
  };

  await watchdog.sweepOpenPorts(watchdogDeps(s, handlers, calls));
  const prov = row.answers.provisioning;
  assert.equal(prov.portFocDate, "2026-09-04");
  assert.equal(prov.portStatus, "foc_received");
  assert.equal(prov.portStatusText, "FOC Received");
  assert.ok(prov.portStatusCheckedAt, "the customer is told 'as of' — so it must be stamped");
  assert.equal(calls.filter((c) => c.method === "getLNPStatus").length, 0);
  assert.equal(calls.filter((c) => c.method === "getLNPList").length, 1, "one list read serves the whole sweep");
  assert.ok(s.events.find((e) => /transfer date 2026-09-04/.test(e.message)));
});

test("sweep: an order missing from the list falls back to the status call, and a known transfer date is NOT erased", async () => {
  const s = makeState();
  const row = submission(s);
  row.answers.provisioning.portFocDate = "2026-09-04";
  row.answers.provisioning.lastPortStatus = "foc_received";
  seedTempState(s);
  const calls: VmsCall[] = [];
  const handlers = {
    ...ROUTED_OK,
    getLNPList: () => ({ status: "error" }), // carrier hiccup on the list read
    getLNPStatus: () => ({ status: "success", post_status: "In Progress" }),
    getDIDsInfo: () => ({ status: "error" }),
  };

  await watchdog.sweepOpenPorts(watchdogDeps(s, handlers, calls));
  assert.equal(calls.filter((c) => c.method === "getLNPStatus").length, 1, "falls back so completion is never missed");
  assert.equal(row.answers.provisioning.portStatus, "In Progress");
  // ⛔ The fallback carries no date. Blanking it here would tell the customer
  // we no longer know when their number moves, having once known.
  assert.equal(row.answers.provisioning.portFocDate, "2026-09-04");
});

test("sweep: an unchanged status still refreshes when we last checked", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const calls: VmsCall[] = [];
  const handlers = {
    ...ROUTED_OK,
    getLNPList: () => ({ status: "success", list: [{ portid: "217760", foc_date: "2026-09-04", port_status: "foc_received" }] }),
    getDIDsInfo: () => ({ status: "error" }),
  };

  await watchdog.sweepOpenPorts(watchdogDeps(s, handlers, calls));
  const first = row.answers.provisioning.portStatusCheckedAt;
  await new Promise((r) => setTimeout(r, 5));
  await watchdog.sweepOpenPorts(watchdogDeps(s, handlers, calls));
  assert.notEqual(row.answers.provisioning.portStatusCheckedAt, first);
  // One status change, one timeline line — a re-check is not news.
  assert.equal(s.events.filter((e) => /Port order 217760 status/.test(e.message)).length, 1);
});

// ── Pointing the ported number + the re-publish ───────────────────────────────

test("PBX world: the ported route copies the temp route's destination, then routing is re-published", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  s.mappings.find((m) => m.e164 === "+8452605692")!.routingMode = "pbx"; // temp NOT on Connect
  const calls: VmsCall[] = [];
  const copyCalls: any[] = [];
  const publishCalls: string[] = [];
  const d = {
    ...deps(s, ROUTED_OK, calls),
    copyPbxDestination: async (_db: any, tenantId: string, tempDid: string, portedDid: string) => {
      copyCalls.push({ tenantId, tempDid, portedDid });
      return { copied: true, detail: "destination 907 copied" };
    },
    publishTenant: async (tenantId: string) => {
      publishCalls.push(tenantId);
    },
  };

  const r = await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(r.done, true);
  assert.deepEqual(copyCalls, [{ tenantId: "tenant1", tempDid: "8452605692", portedDid: "6469846023" }]);
  assert.deepEqual(publishCalls, ["tenant1"]);

  // Idempotent: a second run copies and publishes nothing again.
  await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(copyCalls.length, 1);
  assert.equal(publishCalls.length, 1);
});

test("PBX world: a copy that cannot land yet blocks retirement and retries next sweep", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  s.mappings.find((m) => m.e164 === "+8452605692")!.routingMode = "pbx";
  const calls: VmsCall[] = [];
  let copyOk = false;
  const d = {
    ...deps(s, ROUTED_OK, calls),
    copyPbxDestination: async () => (copyOk ? { copied: true, detail: "ok" } : { copied: false, detail: "helper still applying" }),
    publishTenant: async () => {},
  };

  const r1 = await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(r1.done, false);
  assert.equal(r1.stage, "destination_copy_pending");
  // temp number untouched while the pointing is unfinished
  assert.ok(!calls.find((c) => c.method === "setDIDRouting" && c.params.did === "8452605692"));

  copyOk = true;
  const r2 = await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(r2.done, true);
});

test("Connect world: publish runs only AFTER the switch lands, and a failed publish is retried", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s); // temp on Connect
  const calls: VmsCall[] = [];
  const publishCalls: string[] = [];
  let publishFails = true;
  const d = {
    ...deps(s, ROUTED_OK, calls),
    copyPbxDestination: async () => {
      throw new Error("must not be called in the Connect world");
    },
    publishTenant: async (tenantId: string) => {
      publishCalls.push(tenantId);
      if (publishFails) throw new Error("publish refused (422)");
    },
  };

  // Switch still pending — publish must not have been attempted.
  await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(publishCalls.length, 0);

  // Scheduler lands the switch; the first publish attempt fails → retried.
  s.mappings.find((m) => m.e164 === "+6469846023")!.routingMode = "connect";
  s.schedules[0].status = "activated";
  await assert.rejects(() => landing.runPortLanding(row, CREDS, true, d));
  assert.equal(publishCalls.length, 1);
  assert.ok(!row.answers.provisioning.portLanding.publishedAt);
  assert.ok(!row.answers.provisioning.portLanding.tempRetiredAt); // retirement never ran

  publishFails = false;
  const r = await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(r.done, true);
  assert.equal(publishCalls.length, 2);
  assert.ok(row.answers.provisioning.portLanding.publishedAt);
});

// ── The customer's own "your number is live" email ────────────────────────────
//
// The builder is unit-tested in portCompleteEmail.test.ts. These test the part
// a unit test cannot see: that the LANDING actually queues it, on a channel
// that sends. Before this existed the customer was told nothing at all — the
// only completion email was an ADMIN_ALERT, which the send door drops.

/** Drive a submission all the way to a finished landing. */
async function landCompletely(s: S, row: any, calls: VmsCall[]) {
  const d = deps(s, ROUTED_OK, calls);
  await landing.runPortLanding(row, CREDS, true, d);
  s.mappings.find((m) => m.e164 === "+6469846023")!.routingMode = "connect";
  s.schedules[0].status = "activated";
  return { d, result: await landing.runPortLanding(row, CREDS, true, d) };
}

test("completion emails the CUSTOMER as well as the owner, on a channel that sends", async () => {
  const s = makeState();
  const row = submission(s, { mainEmail: "office@matamimweekly.com" });
  seedTempState(s);
  const calls: VmsCall[] = [];
  const { result } = await landCompletely(s, row, calls);
  assert.equal(result.done, true);

  assert.equal(s.emails.length, 2, "expected the owner alert AND the customer email");

  const owner = s.emails.find((e) => e.type === "ADMIN_ALERT");
  assert.ok(owner, "the internal alert must still be queued");

  const customer = s.emails.find((e) => e.type !== "ADMIN_ALERT");
  assert.ok(customer, "no customer email was queued");
  // ⛔ The whole point: ADMIN_ALERT is muted at the send door, so a customer
  // email on that type would be built, logged clean, and never delivered.
  assert.notEqual(customer.type, "ADMIN_ALERT");
  assert.equal(customer.toEmail, "office@matamimweekly.com");
  assert.equal(customer.tenantId, "tenant1", "must be the customer's tenant, not the alert tenant");
  assert.notEqual(customer.tenantId, owner.tenantId);
  assert.match(customer.subject, /Your number is live/);
  assert.match(customer.htmlBody, /\(646\) 984-6023/);
  assert.match(customer.htmlBody, /\(845\) 260-5692/); // the retired temp number
  assert.ok(customer.textBody.length > 0);
});

test("the customer is emailed exactly once, however many sweeps run", async () => {
  const s = makeState();
  const row = submission(s, { mainEmail: "office@matamimweekly.com" });
  seedTempState(s);
  const calls: VmsCall[] = [];
  const { d } = await landCompletely(s, row, calls);
  assert.equal(s.emails.filter((e) => e.type !== "ADMIN_ALERT").length, 1);

  await landing.runPortLanding(row, CREDS, true, d);
  await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(s.emails.filter((e) => e.type !== "ADMIN_ALERT").length, 1);
});

test("falls back to the billing email when there is no main contact", async () => {
  const s = makeState();
  const row = submission(s, { mainEmail: null, billingEmail: "pay@matamimweekly.com" });
  seedTempState(s);
  await landCompletely(s, row, []);
  const customer = s.emails.find((e) => e.type !== "ADMIN_ALERT");
  assert.ok(customer);
  assert.equal(customer.toEmail, "pay@matamimweekly.com");
});

test("no contact email: the landing still completes, and the timeline SAYS nobody was told", async () => {
  const s = makeState();
  const row = submission(s); // no mainEmail, no billingEmail
  seedTempState(s);
  const { result } = await landCompletely(s, row, []);
  assert.equal(result.done, true, "a missing email must never block the landing");
  assert.equal(s.emails.filter((e) => e.type !== "ADMIN_ALERT").length, 0);
  // Silence here would be indistinguishable from a delivered email.
  assert.ok(
    s.events.some((e) => /NOT told their number is live/.test(e.message)),
    "the timeline must record that the customer was not told",
  );
});

test("a failed customer email is recorded, and never blocks completion", async () => {
  const s = makeState();
  const row = submission(s, { mainEmail: "office@matamimweekly.com" });
  seedTempState(s);
  const d = deps(s, ROUTED_OK, []);
  // The owner alert lands; the customer job blows up.
  let n = 0;
  d.db.emailJob.create = async ({ data }: any) => {
    if (++n === 1) { s.emails.push(data); return data; }
    throw new Error("db down");
  };
  await landing.runPortLanding(row, CREDS, true, d);
  s.mappings.find((m) => m.e164 === "+6469846023")!.routingMode = "connect";
  s.schedules[0].status = "activated";
  const r = await landing.runPortLanding(row, CREDS, true, d);

  assert.equal(r.done, true, "a failed email must not strand the port");
  assert.ok(s.events.some((e) => /tell them by hand/.test(e.message)));
});

// ── Taking the temp number off the customer's phone system ────────────────────
//
// Routing the DID back to the master account is only half of retirement. The
// tenant's inbound route survived, `pbxTenantInboundDidSync` kept seeing it, and
// E911 bills per phone number — so the customer went on paying $3/month for a
// number they no longer own. The guard itself is unit-tested in
// retireTempPbxRoute.test.ts; these test that the landing calls it correctly and
// survives every answer it can give.

test("retirement asks the phone system to drop the temporary number, with the right identifiers", async () => {
  const s = makeState();
  const row = submission(s, { pbxTenantPath: "4de9a88870cd2add" });
  seedTempState(s);
  const seen: any[] = [];
  const d = deps(s, ROUTED_OK, []);
  (d as any).retireTempRoute = async (input: any) => {
    seen.push(input);
    return { deleted: true, reason: "route 237 owns its row alone", routeId: "237" };
  };

  await landing.runPortLanding(row, CREDS, true, d);
  s.mappings.find((m) => m.e164 === "+6469846023")!.routingMode = "connect";
  s.schedules[0].status = "activated";
  const r = await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(r.done, true);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].connectTenantId, "tenant1");
  assert.equal(seen[0].tenantPath, "4de9a88870cd2add");
  assert.equal(seen[0].tempDid, "8452605692");
  assert.equal(seen[0].portedDid, "6469846023");
  assert.ok(s.events.some((e) => /removed from their phone system/.test(e.message)));
});

test("a refusal is written down in plain words and does NOT block the port", async () => {
  // The inii mini shape: the guard says no because deleting would break their
  // live number. That must surface, not vanish.
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const d = deps(s, ROUTED_OK, []);
  (d as any).retireTempRoute = async () => ({
    deleted: false,
    reason: "route 239 shares destination row 907 with 240:6469846023 — deleting it would break the other number",
  });

  await landing.runPortLanding(row, CREDS, true, d);
  s.mappings.find((m) => m.e164 === "+6469846023")!.routingMode = "connect";
  s.schedules[0].status = "activated";
  const r = await landing.runPortLanding(row, CREDS, true, d);

  assert.equal(r.done, true, "a refused cleanup must never hold the port open");
  assert.ok(s.events.some((e) => /still on their phone system/.test(e.message)));
  assert.ok(s.events.some((e) => /shares destination row 907/.test(e.message)));
});

test("it is attempted once, not on every later sweep", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  let calls = 0;
  const d = deps(s, ROUTED_OK, []);
  (d as any).retireTempRoute = async () => { calls++; return { deleted: true, reason: "ok", routeId: "237" }; };

  await landing.runPortLanding(row, CREDS, true, d);
  s.mappings.find((m) => m.e164 === "+6469846023")!.routingMode = "connect";
  s.schedules[0].status = "activated";
  await landing.runPortLanding(row, CREDS, true, d);
  await landing.runPortLanding(row, CREDS, true, d);
  await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(calls, 1);
});

test("a refusal is not retried forever either — it needs a person, not a loop", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  let calls = 0;
  const d = deps(s, ROUTED_OK, []);
  (d as any).retireTempRoute = async () => { calls++; return { deleted: false, reason: "shares a destination row" }; };

  await landing.runPortLanding(row, CREDS, true, d);
  s.mappings.find((m) => m.e164 === "+6469846023")!.routingMode = "connect";
  s.schedules[0].status = "activated";
  await landing.runPortLanding(row, CREDS, true, d);
  await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(calls, 1);
});

test("no PBX wiring at all (unit-test world): the port still completes", async () => {
  const s = makeState();
  const row = submission(s);
  seedTempState(s);
  const d = deps(s, ROUTED_OK, []); // no retireTempRoute
  await landing.runPortLanding(row, CREDS, true, d);
  s.mappings.find((m) => m.e164 === "+6469846023")!.routingMode = "connect";
  s.schedules[0].status = "activated";
  const r = await landing.runPortLanding(row, CREDS, true, d);
  assert.equal(r.done, true);
});
