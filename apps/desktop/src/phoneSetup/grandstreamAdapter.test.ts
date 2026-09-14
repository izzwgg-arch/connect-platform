/**
 * The Grandstream adapter — the TWO-STEP login the phone's own web application performs, driven
 * through a fake transport so every ordering and refusal is proven without a phone on a desk.
 *
 * ⛔ The shapes here were read off Izzy's real GXP2170's GWT bundle on 2026-09-14 (`LDb()` builds
 * `access=hex(sha256(username))`; `ODb()` builds `password=hex(sha256(password + token))` via
 * `Oxb = sjcl.codec.hex.fromBits(sjcl.hash.sha256.hash(...))`), and the token handshake was
 * confirmed live against the handset. rc.15 sent a PLAIN password with no token and no Referer,
 * which is why a correct password was refused four times.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildGrandstreamAccessRequest,
  buildGrandstreamLoginRequest,
  buildGrandstreamOperationRequest,
  grandstreamHash,
  parseGrandstreamLogin,
  parseGrandstreamToken,
  sendGrandstreamOperation,
  testGrandstreamCredentials,
} from "./grandstream";
import type { HttpRequest, HttpResponse } from "./yealink";

const CREDS = { username: "admin", password: "1234" };
const TOKEN = "5wbGZpVbSi1dKTJVaXPvM8U09AaHtQN";
const SID = "SID9000";

const ACCESS_OK: HttpResponse = {
  status: 200,
  headers: { "content-type": "application/json;charset=UTF-8" },
  body: JSON.stringify({ response: "success", body: TOKEN }),
};
const LOGIN_OK: HttpResponse = {
  status: 200,
  headers: { "set-cookie": "session_id=abc123; path=/; HttpOnly" },
  body: JSON.stringify({ response: "success", body: { sid: SID } }),
};
const OP_OK: HttpResponse = { status: 200, headers: {}, body: JSON.stringify({ response: "success" }) };

/** A transport that records every request and answers from a scripted queue. */
function fakeHttp(answers: Array<HttpResponse | Error>) {
  const sent: HttpRequest[] = [];
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    sent.push(req);
    const a = answers.length > 1 ? answers.shift()! : answers[0];
    if (a instanceof Error) throw a;
    return a;
  };
  return { http, sent };
}

test("the hash is the phone's own: hex(sha256(value))", () => {
  assert.equal(grandstreamHash("admin"), createHash("sha256").update("admin").digest("hex"));
  assert.equal(grandstreamHash("admin"), "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918");
});

test("step 1 asks for a token with only a HASH OF THE USERNAME — no password anywhere", () => {
  const req = buildGrandstreamAccessRequest("192.168.1.50", "admin");
  assert.equal(req.url, "http://192.168.1.50/cgi-bin/access");
  assert.equal(req.method, "POST");
  assert.equal(req.body, `access=${grandstreamHash("admin")}`);
  assert.doesNotMatch(req.body ?? "", /1234/);
});

test("⛔ every CGI request carries the Referer the phone demands (without it: 403 Forbidden)", () => {
  const access = buildGrandstreamAccessRequest("192.168.1.50", "admin");
  const login = buildGrandstreamLoginRequest("192.168.1.50", CREDS, TOKEN);
  const op = buildGrandstreamOperationRequest("192.168.1.50", { sid: SID, cookie: "" }, "reset");
  for (const req of [access, login, op]) {
    assert.equal(req.headers.Referer, "http://192.168.1.50/", req.url);
    assert.equal(req.headers["Content-Type"], "application/x-www-form-urlencoded");
  }
});

test("the token is the body STRING of a successful access response", () => {
  assert.equal(parseGrandstreamToken(ACCESS_OK), TOKEN);
  assert.equal(parseGrandstreamToken({ status: 200, headers: {}, body: JSON.stringify({ response: "error" }) }), null);
  assert.equal(parseGrandstreamToken({ status: 403, headers: {}, body: "" }), null);
  assert.equal(parseGrandstreamToken(null), null);
});

test("⛔ step 2 sends hex(sha256(password + token)) — the PLAIN password never reaches the wire", () => {
  const req = buildGrandstreamLoginRequest("192.168.1.50", CREDS, TOKEN);
  assert.equal(req.url, "http://192.168.1.50/cgi-bin/dologin");
  assert.equal(req.body, `username=admin&password=${grandstreamHash("1234" + TOKEN)}`);
  const everything = `${req.url} ${req.body} ${JSON.stringify(req.headers)}`;
  assert.doesNotMatch(everything, /1234(?![0-9a-f])/, "the plain password appeared in the request");
});

test("the requests refuse a non-private address before any socket", () => {
  assert.throws(() => buildGrandstreamAccessRequest("8.8.8.8", "admin"), /private office address/);
  assert.throws(() => buildGrandstreamLoginRequest("8.8.8.8", CREDS, TOKEN), /private office address/);
  assert.throws(() => buildGrandstreamOperationRequest("8.8.8.8", { sid: SID, cookie: "" }, "reset"), /private office address/);
});

test("a session is read only from a non-empty sid", () => {
  assert.equal(parseGrandstreamLogin(LOGIN_OK)?.sid, SID);
  assert.equal(parseGrandstreamLogin(LOGIN_OK)?.cookie, "session_id=abc123");
  assert.equal(parseGrandstreamLogin({ status: 200, headers: {}, body: JSON.stringify({ body: { sid: "" } }) }), null);
  assert.equal(parseGrandstreamLogin({ status: 401, headers: {}, body: "" }), null);
});

test("reset: access → dologin → RESET, in that order, and the session rides along", async () => {
  const { http, sent } = fakeHttp([ACCESS_OK, LOGIN_OK, OP_OK]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", CREDS);
  assert.deepEqual(r, { ok: true });
  assert.equal(sent.length, 3);
  assert.match(sent[0].url, /cgi-bin\/access$/);
  assert.match(sent[1].url, /cgi-bin\/dologin$/);
  assert.match(sent[2].url, /cgi-bin\/api-sys_operation$/);
  assert.match(sent[1].body ?? "", new RegExp(grandstreamHash("1234" + TOKEN)));
  assert.equal(sent[2].body, `request=RESET&sid=${SID}`);
  assert.equal(sent[2].headers.Cookie, "session_id=abc123");
});

test("reboot sends REBOOT on the same three-step path", async () => {
  const { http, sent } = fakeHttp([ACCESS_OK, LOGIN_OK, OP_OK]);
  assert.equal((await sendGrandstreamOperation(http, "192.168.1.50", "reboot", CREDS)).ok, true);
  assert.equal(sent[2].body, `request=REBOOT&sid=${SID}`);
});

test("a 403 on the token step is 'locked' and NOTHING further is sent", async () => {
  const { http, sent } = fakeHttp([{ status: 403, headers: {}, body: "Forbidden" }]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", CREDS);
  assert.deepEqual(r, { ok: false, reason: "locked", status: 403 });
  assert.equal(sent.length, 1);
});

test("⛔ a token we cannot read is 'refused', NEVER 'locked' — it is not a wrong password", async () => {
  const { http, sent } = fakeHttp([{ status: 200, headers: {}, body: "something we have never seen" }]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", CREDS);
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, "refused");
  assert.equal(sent.length, 1, "no login is attempted, so nothing counts toward the phone's lockout");
});

test("a refused password (session-less login) is 'locked', and the operation is never sent", async () => {
  const { http, sent } = fakeHttp([ACCESS_OK, { status: 200, headers: {}, body: JSON.stringify({ response: "error" }) }]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", CREDS);
  assert.equal((r as any).reason, "locked");
  assert.equal(sent.length, 2);
});

test("no password means nothing is sent at all", async () => {
  const { http, sent } = fakeHttp([ACCESS_OK]);
  assert.deepEqual(await sendGrandstreamOperation(http, "192.168.1.50", "reset", null), { ok: false, reason: "locked" });
  assert.equal(sent.length, 0);
});

test("an unreachable phone is 'unreachable', never 'sent'", async () => {
  const refused = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
  const { http } = fakeHttp([refused]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", CREDS);
  assert.equal((r as any).reason, "unreachable");
});

test("testGrandstreamCredentials: a session means accepted; a refusal means locked", async () => {
  const good = fakeHttp([ACCESS_OK, LOGIN_OK]);
  assert.deepEqual(await testGrandstreamCredentials(good.http, "192.168.1.50", CREDS), { ok: true });
  const bad = fakeHttp([ACCESS_OK, { status: 401, headers: {}, body: "" }]);
  assert.equal((await testGrandstreamCredentials(bad.http, "192.168.1.50", CREDS) as any).reason, "locked");
});
