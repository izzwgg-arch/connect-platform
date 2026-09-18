/**
 * Chaos / failure tests (brief §52): dependencies fail, the product degrades
 * instead of breaking. Each test injects the failure through the seam the
 * production code already has (storage, mail transport, Redis absence,
 * duplicate delivery) — no monkey-patching of internals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createUser, tdb, testApp, uniq } from "./harness.js";
import { storage } from "../lib/storage.js";
import { publishTo, subscribe } from "../lib/realtime.js";
import { sendMail } from "../lib/mail.js";

test("object storage failing mid-upload: the request gets a human 400, the asset is REJECTED, the api stays healthy", async () => {
  const app = await testApp();
  const u = await createUser(app);
  const s = storage() as any;
  const original = s.put;
  s.put = async () => {
    throw new Error("disk full");
  };
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const boundary = `----chaos${uniq()}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dot.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await app.inject({ method: "POST", url: "/media", headers: { authorization: `Bearer ${u.accessToken}`, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "file_processing");
    const rejected = await tdb().mediaAsset.findFirst({ where: { ownerId: u.personId }, orderBy: { createdAt: "desc" } });
    assert.equal(rejected?.status, "REJECTED");
    const h = await api(app, { method: "GET", url: "/health" });
    assert.equal(h.status, 200);
  } finally {
    s.put = original;
  }
});

test("mail relay down: signup still succeeds and the email is parked for retry, never dropped", async () => {
  const app = await testApp();
  const savedMode = process.env.COMMUNITY_MAIL_MODE;
  const savedSmtp = process.env.SMTP_URL;
  // env() is cached; drive the transport failure through sendMail directly with a broken relay.
  const { env } = await import("../env.js");
  const e = env() as any;
  const prevMode = e.COMMUNITY_MAIL_MODE;
  const prevSmtp = e.SMTP_URL;
  e.COMMUNITY_MAIL_MODE = "smtp";
  e.SMTP_URL = "smtp://127.0.0.1:1"; // nothing listens
  try {
    const to = `${uniq("chaos")}@example.test`;
    const r = await sendMail(tdb(), { to, subject: "hello", text: "relay is down" });
    assert.equal(r.delivered, "off");
    const parked = await tdb().outboundMail.findFirst({ where: { to } });
    assert.equal(parked?.channel, "email-failed");
    // A signup during the outage still returns 201.
    const email = `${uniq("out")}@example.test`;
    const reg = await api(app, { method: "POST", url: "/auth/register", payload: { firstName: "Out", lastName: "Age", email, password: "Long-enough-pass-1" } });
    assert.equal(reg.status, 201);
  } finally {
    e.COMMUNITY_MAIL_MODE = prevMode;
    e.SMTP_URL = prevSmtp;
    process.env.COMMUNITY_MAIL_MODE = savedMode;
    process.env.SMTP_URL = savedSmtp;
  }
});

test("no Redis configured: realtime still delivers in-process (the default for a single instance)", async () => {
  const got: unknown[] = [];
  const off = subscribe("chaos-person", (e) => got.push(e));
  await publishTo("chaos-person", "notification", { ok: true });
  off();
  assert.equal(got.length, 1);
});

test("duplicate delivery: the same Idempotency-Key replays the first response and creates one row", async () => {
  const app = await testApp();
  const a = await createUser(app);
  const b = await createUser(app);
  const key = uniq("idem");
  const first = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, headers: { "idempotency-key": key }, payload: { personId: b.personId } });
  const second = await api(app, { method: "POST", url: "/connections/request", token: a.accessToken, headers: { "idempotency-key": key }, payload: { personId: b.personId } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.headers["idempotent-replayed"], "true");
  assert.deepEqual(second.body, first.body);
  const rows = await tdb().connection.count({ where: { OR: [{ aId: a.personId, bId: b.personId }, { aId: b.personId, bId: a.personId }] } });
  assert.equal(rows, 1);
  // Same key, different request → refused, never silently applied to the wrong call.
  const misuse = await api(app, { method: "POST", url: "/people/" + b.personId + "/follow", token: a.accessToken, headers: { "idempotency-key": key } });
  assert.equal(misuse.status, 422);
});

test("a slow/failed external verifier (Loopcom SSO) yields a clean 401, not a hang or 500", async () => {
  const app = await testApp();
  const r = await api(app, { method: "POST", url: "/auth/loopcom", payload: { token: "token-nobody-knows-" + uniq() } });
  assert.equal(r.status, 401);
  assert.match(r.body.message, /Loopcom/);
});
