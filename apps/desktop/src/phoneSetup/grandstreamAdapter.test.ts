/**
 * The Grandstream adapter — login, then reset/restart over the session API, driven through a
 * fake transport so every ordering and every refusal is proven without a phone on a desk.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGrandstreamLoginRequest,
  buildGrandstreamOperationRequest,
  parseGrandstreamLogin,
  sendGrandstreamOperation,
  testGrandstreamCredentials,
} from "./grandstream";
import type { HttpRequest, HttpResponse } from "./yealink";

const OK_LOGIN: HttpResponse = {
  status: 200,
  headers: { "set-cookie": "session_id=abc123; path=/; HttpOnly" },
  body: JSON.stringify({ response: "success", body: { sid: "SID9000" } }),
};

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

test("the login request carries the password in the BODY, never the URL", () => {
  const req = buildGrandstreamLoginRequest("192.168.1.50", "s3cr3t&pw");
  assert.equal(req.url, "http://192.168.1.50/cgi-bin/dologin");
  assert.equal(req.method, "POST");
  assert.match(req.body ?? "", /password=s3cr3t%26pw/);
  assert.doesNotMatch(req.url, /s3cr3t/);
});

test("the login request refuses a non-private address before any socket", () => {
  assert.throws(() => buildGrandstreamLoginRequest("8.8.8.8", "x"), /private office address/);
});

test("a session is read only from a non-empty sid; the cookie rides with it", () => {
  const s = parseGrandstreamLogin(OK_LOGIN);
  assert.equal(s?.sid, "SID9000");
  assert.equal(s?.cookie, "session_id=abc123");
});

test("an empty sid, a non-200 or junk is NOT a session", () => {
  assert.equal(parseGrandstreamLogin({ status: 200, headers: {}, body: JSON.stringify({ body: { sid: "" } }) }), null);
  assert.equal(parseGrandstreamLogin({ status: 401, headers: {}, body: "" }), null);
  assert.equal(parseGrandstreamLogin({ status: 200, headers: {}, body: "not json" }), null);
  assert.equal(parseGrandstreamLogin(null), null);
});

test("the operation request carries request + sid in the body and the session cookie", () => {
  const req = buildGrandstreamOperationRequest("192.168.1.50", { sid: "SID9000", cookie: "session_id=abc123" }, "reset");
  assert.equal(req.url, "http://192.168.1.50/cgi-bin/api-sys_operation");
  assert.equal(req.headers.Cookie, "session_id=abc123");
  assert.match(req.body ?? "", /request=RESET&sid=SID9000/);
});

test("reset: logs in, then sends RESET, and reports ok", async () => {
  const okOp: HttpResponse = { status: 200, headers: {}, body: JSON.stringify({ response: "success" }) };
  const { http, sent } = fakeHttp([OK_LOGIN, okOp]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", { username: "admin", password: "1234" });
  assert.deepEqual(r, { ok: true });
  assert.equal(sent.length, 2);
  assert.match(sent[0].url, /dologin/);
  assert.match(sent[1].url, /api-sys_operation/);
  assert.match(sent[1].body ?? "", /request=RESET/);
});

test("reboot: logs in, then sends REBOOT", async () => {
  const { http, sent } = fakeHttp([OK_LOGIN, { status: 200, headers: {}, body: "{}" }]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reboot", { username: "admin", password: "1234" });
  assert.equal(r.ok, true);
  assert.match(sent[1].body ?? "", /request=REBOOT/);
});

test("a 401 on the login is 'locked' and NO operation is attempted", async () => {
  const { http, sent } = fakeHttp([{ status: 401, headers: {}, body: "" }]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", { username: "admin", password: "wrong" });
  assert.deepEqual(r, { ok: false, reason: "locked", status: 401 });
  assert.equal(sent.length, 1, "a refused login never sends the reset");
});

test("a 200 login with no sid is a refused password, not a broken phone — and sends nothing", async () => {
  const { http, sent } = fakeHttp([{ status: 200, headers: {}, body: JSON.stringify({ response: "error" }) }]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", { username: "admin", password: "wrong" });
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, "locked");
  assert.equal(sent.length, 1);
});

test("no password means nothing is sent — a Grandstream is never reset unauthenticated", async () => {
  const { http, sent } = fakeHttp([OK_LOGIN]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", null);
  assert.deepEqual(r, { ok: false, reason: "locked" });
  assert.equal(sent.length, 0);
});

test("an unreachable phone (connection refused on both schemes) is 'unreachable', never 'sent'", async () => {
  const refused = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
  const { http } = fakeHttp([refused]);
  const r = await sendGrandstreamOperation(http, "192.168.1.50", "reset", { username: "admin", password: "1234" });
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, "unreachable");
});

test("testGrandstreamCredentials: a session means accepted; a 401 means locked", async () => {
  const good = fakeHttp([OK_LOGIN]);
  assert.deepEqual(await testGrandstreamCredentials(good.http, "192.168.1.50", { username: "admin", password: "1234" }), { ok: true });
  const bad = fakeHttp([{ status: 401, headers: {}, body: "" }]);
  const r = await testGrandstreamCredentials(bad.http, "192.168.1.50", { username: "admin", password: "x" });
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, "locked");
});
