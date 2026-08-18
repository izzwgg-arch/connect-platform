import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards for the two faults that killed voicemail email platform-wide on
 * 2026-08-18 (see AGENT_HANDOFF_VOICEMAIL_EMAIL_DEAD_2026-08-18.md):
 *
 *  1. The sweep filtered excluded tenants AFTER choosing its batch of 50, so
 *     Gesheft's deliberately-unstamped voicemails — permanently the oldest —
 *     filled every batch and nothing behind them was ever processed.
 *  2. The watchdog selected `tenant: { select: { name } }` on `Voicemail`, which
 *     has no such relation, so it threw on every run and never audited anything.
 *
 * Both are proven against a faked db AND by reading the runtime's SOURCE — the
 * defects were in the shape of a Prisma call, which a unit test of a pure
 * helper passes straight through.
 */

const calls: { voicemailFindMany: any[]; tenantFindMany: any[]; emailJobFindMany: any[] } = {
  voicemailFindMany: [], tenantFindMany: [], emailJobFindMany: [],
};
const state: { voicemails: any[]; tenants: any[]; jobs: any[]; escalations: any[]; audit: any[] } = {
  voicemails: [], tenants: [], jobs: [], escalations: [], audit: [],
};

mock.module("@connect/db", {
  namedExports: {
    db: {
      voicemail: {
        findMany: async (args: any) => {
          calls.voicemailFindMany.push(args);
          // Behave like Prisma: an unknown key in `select` is a validation error.
          for (const k of Object.keys(args?.select || {})) {
            if (k === "tenant") throw new Error("Unknown field `tenant` for select statement on model `Voicemail`");
          }
          const notIn: string[] = args?.where?.tenantId?.notIn || [];
          const notNull = args?.where?.tenantId?.not === null;
          let rows = state.voicemails.filter((v) => (!notNull || v.tenantId !== null) && !notIn.includes(v.tenantId));
          if (args?.where?.id?.in) rows = rows.filter((v) => args.where.id.in.includes(v.id));
          if (args?.where?.emailedAt === null) rows = rows.filter((v) => v.emailedAt == null);
          rows = rows.slice().sort((a, b) =>
            args?.orderBy?.receivedAt === "desc" ? +b.receivedAt - +a.receivedAt : +a.receivedAt - +b.receivedAt);
          return rows.slice(0, args?.take ?? rows.length);
        },
        update: async ({ where, data }: any) => {
          const v = state.voicemails.find((x) => x.id === where.id);
          Object.assign(v, data);
          return v;
        },
        findUnique: async () => null,
      },
      tenant: {
        findMany: async (args: any) => {
          calls.tenantFindMany.push(args);
          const ids: string[] = args?.where?.id?.in || [];
          return state.tenants.filter((t) => ids.includes(t.id));
        },
        findFirst: async () => state.tenants[0] ?? null,
      },
      emailJob: {
        findMany: async (args: any) => { calls.emailJobFindMany.push(args); return args?.where?.type === "VOICEMAIL_NOTIFICATION" && args?.where?.status === "FAILED" ? [] : state.jobs; },
        findFirst: async () => null,
        update: async () => ({}),
        create: async ({ data }: any) => { state.jobs.push({ ...data, status: "QUEUED" }); return data; },
      },
      agentAuditLog: {
        create: async ({ data }: any) => { state.audit.push(data); return data; },
        findFirst: async () => null,
        findMany: async () => [],
      },
      extension: {
        findFirst: async ({ where }: any) => ({
          id: `ext-${where.tenantId}-${where.extNumber}`, displayName: "Someone",
          pbxUserEmail: null, vmEmailEnabled: true,
          voicemailEmailRecipients: [{ email: `${where.tenantId}-${where.extNumber}@example.com` }],
        }),
      },
      agentEscalation: {
        findFirst: async () => null,
        create: async ({ data }: any) => { state.escalations.push(data); return data; },
      },
    },
  },
});

const GESHEFT = "gesheft-tenant";
const log = { info: () => {}, warn: () => {} };

function reset() {
  calls.voicemailFindMany.length = 0; calls.tenantFindMany.length = 0; calls.emailJobFindMany.length = 0;
  state.voicemails.length = 0; state.tenants.length = 0; state.jobs.length = 0; state.escalations.length = 0; state.audit.length = 0;
  process.env.VOICEMAIL_EMAIL_ENABLED = "1";
  process.env.VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS = GESHEFT;
}

function vm(over: Partial<any>): any {
  return {
    id: over.id, tenantId: over.tenantId ?? "t-other", extension: over.extension ?? "101",
    callerName: null, callerNumber: "8455551212", durationSec: 30,
    receivedAt: over.receivedAt ?? new Date(), transcript: null, transcriptLanguage: null,
    localAudioPath: "x.wav", audioGoneAt: null, emailedAt: null, emailSkipReason: null,
    deletedAt: null, ...over,
  };
}

test("buildVoicemailSweepWhere puts the exclusion IN THE QUERY and never matches unresolved tenants", async () => {
  const { buildVoicemailSweepWhere } = await import("./voicemailEmailRuntime");
  const since = new Date("2026-08-11T00:00:00Z");
  const w = buildVoicemailSweepWhere({ since, excludedTenantIds: [GESHEFT, " ", GESHEFT] });
  assert.deepEqual(w, {
    emailedAt: null, receivedAt: { gte: since }, deletedAt: null,
    tenantId: { not: null, notIn: [GESHEFT] },
  });
  // No exclusions: no `notIn` at all (an empty NOT IN is not something to hand Prisma), still `not: null`.
  const w2 = buildVoicemailSweepWhere({ since, excludedTenantIds: [] });
  assert.deepEqual(w2.tenantId, { not: null });
});

test("an excluded tenant with more unstamped voicemails than the batch cannot starve everyone else", async () => {
  reset();
  const { runVoicemailEmailSweep, SWEEP_BATCH } = await import("./voicemailEmailRuntime");
  // Gesheft: SWEEP_BATCH + 10 old, permanently-unstamped rows — the exact live shape (53 of 50).
  for (let i = 0; i < SWEEP_BATCH + 10; i++) {
    state.voicemails.push(vm({ id: `g${i}`, tenantId: GESHEFT, receivedAt: new Date(Date.now() - (5 * 864e5) + i * 1000) }));
  }
  // One unresolved row (tenantId null) and one real customer voicemail, both NEWER than every Gesheft row.
  state.voicemails.push(vm({ id: "unresolved", tenantId: null, receivedAt: new Date(Date.now() - 3600_000) }));
  state.voicemails.push(vm({ id: "customer", tenantId: "trust", extension: "105", receivedAt: new Date(Date.now() - 60_000) }));

  await runVoicemailEmailSweep(log as any);

  const where = calls.voicemailFindMany.at(-1)?.where;
  assert.equal(where?.tenantId?.not, null);
  assert.deepEqual(where?.tenantId?.notIn, [GESHEFT]);
  // The customer's voicemail was reached and queued; Gesheft's were never stamped.
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].toEmail, "trust-105@example.com");
  assert.ok(state.voicemails.find((v) => v.id === "customer").emailedAt, "customer voicemail stamped");
  assert.equal(state.voicemails.filter((v) => v.tenantId === GESHEFT && v.emailedAt).length, 0, "excluded tenant never stamped");
  assert.equal(state.voicemails.find((v) => v.id === "unresolved").emailedAt, null);
});

test("the watchdog runs to completion — no `tenant` relation in its select, names looked up separately", async () => {
  reset();
  const { runVoicemailEmailWatchdog } = await import("./voicemailEmailRuntime");
  state.tenants.push({ id: "trust", name: "Trust Bookkeepings" });
  // Two days old, never processed → a real gap the watchdog must report by tenant NAME.
  state.voicemails.push(vm({ id: "lost", tenantId: "trust", extension: "105", receivedAt: new Date(Date.now() - 2 * 864e5) }));
  state.voicemails.push(vm({ id: "g1", tenantId: GESHEFT, receivedAt: new Date(Date.now() - 864e5) }));

  const gaps = await runVoicemailEmailWatchdog(log as any);
  const wdSelect = calls.voicemailFindMany.find((c) => c?.orderBy?.receivedAt === "desc")?.select || {};
  assert.equal("tenant" in wdSelect, false, "watchdog must not select a relation Voicemail does not have");
  assert.equal(calls.tenantFindMany.length, 1, "tenant names are looked up in a separate query");
  assert.deepEqual([...calls.tenantFindMany[0].where.id.in].sort(), [GESHEFT, "trust"]);
  // SELF-HEAL: the stranded voicemail is not merely reported — the watchdog processed it itself.
  assert.equal(state.jobs.length, 1, "the watchdog rescued the stranded voicemail by queueing its email");
  assert.equal(state.jobs[0].toEmail, "trust-105@example.com");
  assert.ok(state.voicemails.find((v) => v.id === "lost").emailedAt, "rescued voicemail is stamped");
  assert.equal(gaps.length, 0, "a rescued voicemail is no longer a gap");
  assert.ok(state.audit.some((a) => a.event === "voicemail_email.watchdog_heartbeat"), "watchdog heartbeat recorded");
});

test("the sweep records a heartbeat even when there is nothing to do", async () => {
  reset();
  const { runVoicemailEmailSweep } = await import("./voicemailEmailRuntime");
  await runVoicemailEmailSweep(log as any);
  assert.ok(state.audit.some((a) => a.event === "voicemail_email.sweep_heartbeat"));
});

// ── Source guards. Normalise CRLF: Windows checkouts break literal-`\n` slices.
const runtimeSrc = readFileSync(path.join(__dirname, "voicemailEmailRuntime.ts"), "utf8").replace(/\r\n/g, "\n");

test("SOURCE: the sweep's findMany takes its where from buildVoicemailSweepWhere", () => {
  const sweep = runtimeSrc.slice(runtimeSrc.indexOf("export async function runVoicemailEmailSweep"), runtimeSrc.indexOf("export async function runVoicemailEmailWatchdog"));
  assert.match(sweep, /where:\s*buildVoicemailSweepWhere\(\{\s*since,\s*excludedTenantIds:\s*voicemailEmailExcludedTenantIds\(\)/);
  assert.doesNotMatch(sweep, /where:\s*\{\s*emailedAt:\s*null,\s*receivedAt/, "the old post-batch filter shape must not return");
});

test("SOURCE: the watchdog's voicemail select carries no `tenant` relation", () => {
  const wd = runtimeSrc.slice(runtimeSrc.indexOf("export async function runVoicemailEmailWatchdog"), runtimeSrc.indexOf("function countBy"));
  const select = wd.slice(wd.indexOf("select: {"), wd.indexOf("},", wd.indexOf("select: {")));
  assert.doesNotMatch(select, /\btenant\s*:/);
  assert.match(wd, /tenant\.findMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*tenantIds/);
});
