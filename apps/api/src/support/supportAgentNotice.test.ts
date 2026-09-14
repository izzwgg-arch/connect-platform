/**
 * The support agent's owner notices: texted before any change, STOP halts it,
 * GO is required for a change that affects every customer.
 *
 * ⛔ What these defend: a change made before the owner was told; a change made
 * after he said STOP; a system-wide change made without his GO; a stranger's
 * text deciding anything; one reply acting twice; a negated "go" read as yes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { parseNoticeReply, supportReportReference } from "@connect/shared";
import {
  applyNoticeReply,
  checkOwnerNoticeGate,
  createOwnerNotice,
  hashNoticeCode,
  registerSupportAgentNoticeRoutes,
  NOTICE_TTL_MS,
} from "./supportAgentNotice";

const NOW = Date.parse("2026-09-14T20:00:00Z");
const OWNER = "+18457231213";
const ESC_ID = "cmu1p94cd0iv7ke130gt1h90m";
const REF = supportReportReference(ESC_ID);

function fakeDb(escOverrides: Record<string, any> = {}) {
  const notices = new Map<string, any>();
  let n = 0;
  const esc = { id: ESC_ID, tenantId: "tenant-trust", tenantName: "Trust Bookkeepings", userName: "vigdor", clientUserId: "user-vigdor", ...escOverrides };
  const pick = (row: any, select?: any) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row);
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
      return row[k] === v;
    });
  return {
    notices,
    agentEscalation: {
      findMany: async () => [{ id: esc.id }],
      findUnique: async ({ where }: any) => (where.id === esc.id ? esc : null),
    },
    supportAgentNotice: {
      create: async ({ data, select }: any) => {
        const row = { id: "n" + ++n, createdAt: new Date(NOW), smsSentAt: null, decidedAt: null, lastError: null, ...data };
        notices.set(row.id, row);
        return pick(row, select);
      },
      update: async ({ where, data }: any) => {
        const row = { ...notices.get(where.id), ...data };
        notices.set(where.id, row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const [id, row] of notices) {
          if (matches(row, where)) {
            notices.set(id, { ...row, ...data });
            count++;
          }
        }
        return { count };
      },
      findUnique: async ({ where, select }: any) => {
        const row = [...notices.values()].find((r) => r.codeHash === where.codeHash);
        return row ? pick(row, select) : null;
      },
      findMany: async ({ where, select }: any) => [...notices.values()].filter((r) => r.escalationId === where.escalationId).map((r) => pick(r, select)),
    },
  };
}

/** Captures the texts, and pulls the code back out of them (the api never returns it). */
function smsSink(delivered = 2) {
  const sent: string[] = [];
  const send = async ({ body }: { tenantId: string; body: string }) => {
    sent.push(body);
    return { delivered };
  };
  const lastCode = () => {
    const words = sent.at(-1)!.split(" ");
    return words.find((w) => /^[0-9]{6}$/.test(w.replace(".", "")))!.replace(".", "");
  };
  return { sent, send, lastCode };
}

const baseInput = { escalationId: ESC_ID, tenantId: "tenant-trust", reference: REF, tenantName: "Trust Bookkeepings", userName: "vigdor" };

describe("reading STOP and GO", () => {
  test("the word and the code together are a decision", () => {
    assert.deepEqual(parseNoticeReply("STOP 123456"), { kind: "stop", code: "123456" });
    assert.deepEqual(parseNoticeReply("go 654321"), { kind: "go", code: "654321" });
    assert.deepEqual(parseNoticeReply("Stop123456"), { kind: "stop", code: "123456" });
    assert.deepEqual(parseNoticeReply("GO: 654321!"), { kind: "go", code: "654321" });
  });

  test("⛔ a bare word, a bare code, both words, or a wrong-length code is not", () => {
    for (const t of ["stop", "go", "ok", "yes", "123456", "stop go 123456", "go 12345", "go 1234567", "stop 123456 654321", "", null]) {
      assert.equal(parseNoticeReply(t as any), null, String(t));
    }
  });

  test("⛔ a negated go is never a yes; stop is never blocked by one", () => {
    for (const t of ["no go 123456", "don't go 123456", "do not go 123456", "wait go 123456", "go hold 123456"]) {
      assert.equal(parseNoticeReply(t), null, t);
    }
    assert.deepEqual(parseNoticeReply("no, stop 123456"), { kind: "stop", code: "123456" });
  });

  test("⛔ FIX replies are not notice replies", () => {
    assert.equal(parseNoticeReply("FIX 123456"), null);
  });
});

describe("the write gate", () => {
  test("⛔ no notice means no change", async () => {
    const db = fakeDb();
    const g = await checkOwnerNoticeGate(db, ESC_ID, NOW);
    assert.equal(g.ok, false);
    assert.equal((g as any).error, "owner_not_notified");
  });

  test("a tenant notice that reached the owner lets the agent proceed", async () => {
    const db = fakeDb();
    const sms = smsSink();
    await createOwnerNotice(db, sms.send, { ...baseInput, scope: "tenant", summary: "Copy ext 101's greeting to the busy greeting." }, NOW);
    assert.equal(sms.sent.length, 1);
    assert.match(sms.sent[0], /STOP [0-9]{6}/);
    assert.deepEqual(await checkOwnerNoticeGate(db, ESC_ID, NOW), { ok: true });
  });

  test("⛔ a notice whose text did NOT reach the owner does not open the gate", async () => {
    const db = fakeDb();
    await createOwnerNotice(db, smsSink(0).send, { ...baseInput, scope: "tenant", summary: "Copy ext 101's greeting to busy." }, NOW);
    assert.equal((await checkOwnerNoticeGate(db, ESC_ID, NOW)).ok, false);
  });

  test("⛔ an expired notice does not open the gate", async () => {
    const db = fakeDb();
    await createOwnerNotice(db, smsSink().send, { ...baseInput, scope: "tenant", summary: "Copy ext 101's greeting to busy." }, NOW);
    assert.equal((await checkOwnerNoticeGate(db, ESC_ID, NOW + NOTICE_TTL_MS + 1)).ok, false);
  });

  test("⛔ a system notice does not open the gate until GO", async () => {
    const db = fakeDb();
    const sms = smsSink();
    await createOwnerNotice(db, sms.send, { ...baseInput, scope: "system", summary: "Deploy the api busy-greeting fix." }, NOW);
    assert.match(sms.sent[0], /GO [0-9]{6}/);
    assert.equal((await checkOwnerNoticeGate(db, ESC_ID, NOW)).ok, false);
    const out = await applyNoticeReply(db, { kind: "go", code: sms.lastCode(), from: OWNER, approvers: [OWNER] }, NOW);
    assert.equal(out.kind, "approved");
    assert.equal(out.changed, true);
    assert.deepEqual(await checkOwnerNoticeGate(db, ESC_ID, NOW), { ok: true });
  });
});

describe("the owner's replies", () => {
  test("⛔ STOP halts every further change on the ticket, even with another live notice", async () => {
    const db = fakeDb();
    const sms = smsSink();
    await createOwnerNotice(db, sms.send, { ...baseInput, scope: "tenant", summary: "First change on this ticket." }, NOW);
    const firstCode = sms.lastCode();
    await createOwnerNotice(db, sms.send, { ...baseInput, scope: "tenant", summary: "Second change on this ticket." }, NOW);
    const out = await applyNoticeReply(db, { kind: "stop", code: firstCode, from: OWNER, approvers: [OWNER] }, NOW);
    assert.equal(out.kind, "stopped");
    const g = await checkOwnerNoticeGate(db, ESC_ID, NOW);
    assert.equal((g as any).error, "stopped_by_owner");
  });

  test("⛔ one reply acts once: a second STOP or GO changes nothing", async () => {
    const db = fakeDb();
    const sms = smsSink();
    await createOwnerNotice(db, sms.send, { ...baseInput, scope: "system", summary: "Deploy the api fix." }, NOW);
    const code = sms.lastCode();
    assert.equal((await applyNoticeReply(db, { kind: "go", code, from: OWNER, approvers: [OWNER] }, NOW)).changed, true);
    const again = await applyNoticeReply(db, { kind: "go", code, from: OWNER, approvers: [OWNER] }, NOW);
    assert.equal(again.changed, false);
    assert.equal(again.kind, "already_decided");
    assert.equal((await applyNoticeReply(db, { kind: "stop", code, from: OWNER, approvers: [OWNER] }, NOW)).changed, true);
    assert.equal((await applyNoticeReply(db, { kind: "stop", code, from: OWNER, approvers: [OWNER] }, NOW)).kind, "already_stopped");
  });

  test("⛔ a stranger's STOP or GO is ignored entirely — no change, no reply", async () => {
    const db = fakeDb();
    const sms = smsSink();
    await createOwnerNotice(db, sms.send, { ...baseInput, scope: "system", summary: "Deploy the api fix." }, NOW);
    const out = await applyNoticeReply(db, { kind: "go", code: sms.lastCode(), from: "+15550001111", approvers: [OWNER] }, NOW);
    assert.deepEqual([out.handled, out.changed, out.replyTo], [false, false, null]);
    assert.equal((await checkOwnerNoticeGate(db, ESC_ID, NOW)).ok, false);
  });

  test("GO on a tenant notice is not needed; GO after expiry is refused; STOP after expiry still works", async () => {
    const db = fakeDb();
    const sms = smsSink();
    await createOwnerNotice(db, sms.send, { ...baseInput, scope: "tenant", summary: "Tenant change." }, NOW);
    assert.equal((await applyNoticeReply(db, { kind: "go", code: sms.lastCode(), from: OWNER, approvers: [OWNER] }, NOW)).kind, "not_needed");

    const db2 = fakeDb();
    const sms2 = smsSink();
    await createOwnerNotice(db2, sms2.send, { ...baseInput, scope: "system", summary: "System change." }, NOW);
    const late = NOW + NOTICE_TTL_MS + 1;
    assert.equal((await applyNoticeReply(db2, { kind: "go", code: sms2.lastCode(), from: OWNER, approvers: [OWNER] }, late)).kind, "expired");
    assert.equal((await applyNoticeReply(db2, { kind: "stop", code: sms2.lastCode(), from: OWNER, approvers: [OWNER] }, late)).kind, "stopped");
  });

  test("an unknown code is answered, and codes are only ever stored hashed", async () => {
    const db = fakeDb();
    const sms = smsSink();
    await createOwnerNotice(db, sms.send, { ...baseInput, scope: "tenant", summary: "Tenant change." }, NOW);
    const row = [...db.notices.values()][0];
    assert.equal(row.codeHash, hashNoticeCode(sms.lastCode()));
    assert.ok(!JSON.stringify(row).includes(sms.lastCode()));
    assert.equal((await applyNoticeReply(db, { kind: "stop", code: "000000", from: OWNER, approvers: [OWNER] }, NOW)).kind, "unknown_code");
  });
});

describe("the routes", () => {
  async function build(escOverrides: Record<string, any> = {}, delivered = 2) {
    const db = fakeDb(escOverrides);
    const sms = smsSink(delivered);
    const app = Fastify();
    registerSupportAgentNoticeRoutes(app, { db, requireSuper: () => ({ sub: "izzy" }), sendOwnerSms: sms.send, now: () => NOW });
    return { app, db, sms };
  }

  test("⛔ the code is never returned to the caller", async () => {
    const { app, sms } = await build();
    const res = await app.inject({ method: "POST", url: `/admin/support/escalations/${REF}/owner-notice`, payload: { scope: "tenant", summary: "Copy ext 101's greeting to busy." } });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes(sms.lastCode()));
  });

  test("⛔ owner not reached → 502 and the gate stays shut", async () => {
    const { app, db } = await build({}, 0);
    const res = await app.inject({ method: "POST", url: `/admin/support/escalations/${REF}/owner-notice`, payload: { scope: "tenant", summary: "Copy ext 101's greeting to busy." } });
    assert.equal(res.statusCode, 502);
    assert.equal((await checkOwnerNoticeGate(db, ESC_ID, NOW)).ok, false);
  });

  test("⛔ after STOP, a new notice cannot be posted to get around it", async () => {
    const { app, db, sms } = await build();
    await app.inject({ method: "POST", url: `/admin/support/escalations/${REF}/owner-notice`, payload: { scope: "tenant", summary: "First change on this ticket." } });
    await applyNoticeReply(db, { kind: "stop", code: sms.lastCode(), from: OWNER, approvers: [OWNER] }, NOW);
    const res = await app.inject({ method: "POST", url: `/admin/support/escalations/${REF}/owner-notice`, payload: { scope: "tenant", summary: "Trying again anyway." } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "stopped_by_owner");
  });

  test("⛔ a platform alarm cannot get a tenant notice", async () => {
    const { app } = await build({ clientUserId: null });
    const res = await app.inject({ method: "POST", url: `/admin/support/escalations/${REF}/owner-notice`, payload: { scope: "tenant", summary: "Some tenant change here." } });
    assert.equal(res.statusCode, 409);
  });
});

describe("source guards", () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");

  test("⛔ the act-as-filer route checks the owner-notice gate before replaying a write", () => {
    const src = read("actAsFilerRoutes.ts");
    const gateAt = src.indexOf("deps.ownerNoticeGate(esc.id)");
    const injectAt = src.indexOf("deps.inject(");
    assert.ok(gateAt > 0, "the write path must call ownerNoticeGate");
    assert.ok(gateAt < injectAt, "the gate must run before the replay");
  });

  test("⛔ STOP/GO ride the ONE existing reply sweep, and server.ts wires the gate", () => {
    assert.match(read("../agentFixByText.ts"), /applyNoticeReply\(/);
    const server = read("../server.ts");
    assert.match(server, /ownerNoticeGate: \(escalationId\) => checkOwnerNoticeGate\(db, escalationId\)/);
    assert.match(server, /registerSupportAgentNoticeRoutes\(app,/);
  });
});
