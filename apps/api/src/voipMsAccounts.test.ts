// Second VoIP.ms account support (2026-09-15): account listing/deletion rules,
// per-number credential resolution, and source guards pinning that the worker's
// send + poll paths actually follow a number's `voipmsAccountId` (the defect
// this feature would silently regress into is "second-account numbers sent and
// polled with the primary account's credentials", which VoIP.ms answers with
// missing-DID errors nobody reads).

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const state = {
  configs: new Map<string, any>(),
  numbers: new Map<string, any>(), // key: phoneE164
};

mock.module("@connect/db", {
  namedExports: {
    db: {
      globalVoipMsConfig: {
        findUnique: async ({ where }: any) => state.configs.get(where.id) || null,
        findMany: async () => [...state.configs.values()],
        create: async ({ data }: any) => {
          state.configs.set(data.id, { createdAt: new Date(), ...data });
          return data;
        },
        update: async ({ where, data }: any) => {
          const row = state.configs.get(where.id);
          Object.assign(row, data);
          return row;
        },
        delete: async ({ where }: any) => {
          state.configs.delete(where.id);
          return {};
        },
      },
      tenantSmsNumber: {
        findUnique: async ({ where }: any) => state.numbers.get(where.phoneE164) || null,
        count: async ({ where }: any) =>
          [...state.numbers.values()].filter((n) => n.voipmsAccountId === where.voipmsAccountId).length,
        groupBy: async () => {
          const counts = new Map<string, number>();
          for (const n of state.numbers.values()) {
            const k = String(n.voipmsAccountId || "default");
            counts.set(k, (counts.get(k) || 0) + 1);
          }
          return [...counts.entries()].map(([voipmsAccountId, c]) => ({ voipmsAccountId, _count: { _all: c } }));
        },
      },
    },
  },
});

mock.module("@connect/security", {
  namedExports: {
    encryptJson: (v: unknown) => "enc:" + JSON.stringify(v),
    decryptJson: (s: string) => {
      if (!String(s).startsWith("enc:")) throw new Error("bad ciphertext");
      return JSON.parse(String(s).replace(/^enc:/, ""));
    },
  },
});

let mod: typeof import("./voipMsAccounts");
test.before(async () => {
  mod = await import("./voipMsAccounts");
});

function seedPrimary() {
  state.configs.clear();
  state.numbers.clear();
  state.configs.set("default", {
    id: "default",
    label: null,
    credentialsEncrypted: 'enc:{"username":"izzy@loopcom.net","password":"pw1"}',
    apiBaseUrl: null,
    createdAt: new Date("2026-01-01"),
  });
}

// ── Deletion rules ────────────────────────────────────────────────────────────

test("the primary account can never be deleted", () => {
  const d = mod.canDeleteVoipMsAccount({ accountId: "default", numberCount: 0 });
  assert.equal(d.ok, false);
});

test("an account still owning synced numbers cannot be deleted", () => {
  const d = mod.canDeleteVoipMsAccount({ accountId: "acct2", numberCount: 3 });
  assert.equal(d.ok, false);
  assert.match((d as any).reason, /3 synced numbers/);
});

test("an empty secondary account can be deleted", () => {
  assert.deepEqual(mod.canDeleteVoipMsAccount({ accountId: "acct2", numberCount: 0 }), { ok: true });
});

// ── Credential resolution per number ─────────────────────────────────────────

test("a number stamped to a second account resolves THAT account's credentials", async () => {
  seedPrimary();
  state.configs.set("acct2", {
    id: "acct2",
    label: "Second",
    credentialsEncrypted: 'enc:{"username":"second@x.com","password":"pw2"}',
    apiBaseUrl: null,
    createdAt: new Date("2026-02-01"),
  });
  state.numbers.set("+18455551234", { phoneE164: "+18455551234", voipmsAccountId: "acct2" });

  const r = await mod.loadVoipMsCredsForNumber("+18455551234");
  assert.equal(r.accountId, "acct2");
  assert.equal(r.creds?.username, "second@x.com");
});

test("a number never synced falls back to the primary account (pre-feature behaviour)", async () => {
  seedPrimary();
  const r = await mod.loadVoipMsCredsForNumber("+15555550100");
  assert.equal(r.accountId, "default");
  assert.equal(r.creds?.username, "izzy@loopcom.net");
});

test("a number stamped to an account with unreadable credentials answers null creds, not the primary's", async () => {
  seedPrimary();
  state.configs.set("acct2", { id: "acct2", label: "Second", credentialsEncrypted: "garbage", createdAt: new Date() });
  state.numbers.set("+18455551234", { phoneE164: "+18455551234", voipmsAccountId: "acct2" });
  const r = await mod.loadVoipMsCredsForNumber("+18455551234");
  assert.equal(r.accountId, "acct2");
  assert.equal(r.creds, null);
});

// ── Listing ───────────────────────────────────────────────────────────────────

test("listVoipMsAccounts puts the primary first and counts stamped numbers", async () => {
  seedPrimary();
  state.configs.set("acct2", {
    id: "acct2",
    label: "Second",
    credentialsEncrypted: 'enc:{"username":"second@x.com","password":"pw2"}',
    createdAt: new Date("2026-02-01"),
  });
  state.numbers.set("+18455551234", { phoneE164: "+18455551234", voipmsAccountId: "acct2" });
  state.numbers.set("+18455551235", { phoneE164: "+18455551235", voipmsAccountId: "default" });

  const list = await mod.listVoipMsAccounts();
  assert.equal(list.length, 2);
  assert.equal(list[0]!.id, "default");
  assert.equal(list[0]!.isPrimary, true);
  assert.equal(list[0]!.numberCount, 1);
  assert.equal(list[1]!.id, "acct2");
  assert.equal(list[1]!.label, "Second");
  assert.equal(list[1]!.numberCount, 1);
  assert.equal(list[1]!.usernameHint, "sec…");
});

test("createVoipMsAccount never reuses the primary id", async () => {
  seedPrimary();
  const { id } = await mod.createVoipMsAccount({ label: "Second", credentialsEncrypted: "enc:{}" });
  assert.notEqual(id, "default");
  assert.ok(state.configs.has(id));
});

// ── Source guards ────────────────────────────────────────────────────────────
// These read the SOURCE of the two worker paths and the sync route, because
// the defect is WHICH row each one reads — a unit test of the helpers passes
// straight through a regression where a consumer quietly hardcodes "default".
// CRLF-normalised (Windows checkouts), and each asserted string is absent at
// pre-feature HEAD, so the guards genuinely fail when replayed against it.

function readSource(rel: string): string {
  const p = path.resolve(process.env.VOIPMS_GUARD_ROOT || path.join(__dirname, "..", "..", ".."), rel);
  return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

test("the worker outbound SMS job resolves credentials from the number's voipmsAccountId", () => {
  const src = readSource("apps/worker/src/connectChatSmsJob.ts");
  assert.match(src, /voipmsAccountId\s*=\s*String\(\(smsRow as any\)\?\.voipmsAccountId \|\| "default"\)/);
  assert.match(src, /findUnique\(\{ where: \{ id: voipmsAccountId \} \}\)/);
  assert.match(src, /loadVoipMsCredsWorker\(voipmsAccountId\)/);
});

test("the worker inbound poller groups numbers by account and loads per-account credentials", () => {
  const src = readSource("apps/worker/src/voipMsInboundSyncJob.ts");
  assert.match(src, /voipmsAccountId: true/);
  assert.match(src, /byAccount/);
  assert.match(src, /loadVoipMsCreds\(accountId\)/);
});

test("the DID sync stamps voipmsAccountId on both create and update", () => {
  const src = readSource("apps/api/src/connectChatRoutes.ts");
  const stampCount = (src.match(/voipmsAccountId: accountId/g) || []).length;
  assert.ok(stampCount >= 2, `expected the sync upsert to stamp voipmsAccountId in create AND update, found ${stampCount}`);
  assert.match(src, /syncDidsForAccount/);
});
