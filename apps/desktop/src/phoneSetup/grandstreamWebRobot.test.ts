import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { grandstreamHash } from "./grandstream";
import { gsProbe, gsProvision, gsReset, p237Of, pluck, GRANDSTREAM_DEFAULT_CREDENTIALS, type GsRobotDeps } from "./grandstreamWebRobot";
import type { HttpRequest, HttpResponse } from "./yealink";

const IP = "192.168.6.172";
const FOLDER = "https://m.connectcomunications.com/phoneprov/a70274ea0f143ca0/";

/**
 * A fake GXP2170: the cgi surface as the handoffs recorded it. `claimed` models the
 * GDMS-owned phone whose config_update returns {} and keeps the factory P237.
 */
function fakePhone(opts: { password?: string; claimed?: boolean; mac?: string } = {}) {
  const password = opts.password ?? "admin";
  const state = { p237: "fm.grandstream.com/gs", p212: "1", sid: "s1", token: "tok9", ops: [] as string[], logins: 0, writes: 0 };
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    const u = new URL(req.url);
    if (u.protocol === "https:") throw new Error("no tls on this fake");
    const path = u.pathname + u.search;
    const ok = (body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers, body: JSON.stringify(body) });
    if (path === "/cgi-bin/access") return ok({ response: "success", body: state.token }, { "set-cookie": "session-role=guest; Path=/" });
    if (path === "/cgi-bin/dologin") {
      state.logins++;
      const want = grandstreamHash(`${password}${state.token}`);
      return String(req.body).includes(`password=${encodeURIComponent(want)}`)
        ? ok({ response: "success", body: { sid: state.sid } }, { "set-cookie": `session-identity=${state.sid}; Path=/` })
        : { status: 401, headers: {}, body: "{}" };
    }
    if (path.startsWith("/cgi-bin/api.values.get")) return ok({ response: "success", body: { phone_model: "GXP2170", sw_version: "1.0.11.103", mac_addr: opts.mac ?? "c074ad8c605f" } });
    if (path.startsWith("/cgi-bin/config_get")) return ok({ response: "success", body: { "237": state.p237, "212": state.p212 } });
    if (path.startsWith("/cgi-bin/config_update")) {
      state.writes++;
      if (!path.includes(`sid=${state.sid}`)) return { status: 401, headers: {}, body: "{}" };
      if (!opts.claimed) { const j = JSON.parse(String(req.body)); state.p237 = j.pvalue["237"]; state.p212 = j.pvalue["212"]; }
      return ok({});
    }
    if (path === "/cgi-bin/api-sys_operation") { state.ops.push(String(req.body)); return ok({ response: "success" }); }
    return { status: 404, headers: {}, body: "" };
  };
  return { http, state };
}

function deps(http: GsRobotDeps["http"], blocked = false) {
  const notes: Array<{ ip: string; ok: boolean }> = [];
  const log: string[] = [];
  const d: GsRobotDeps = { http, loginBlocked: () => blocked, noteLogin: (ip, o) => notes.push({ ip, ok: o.ok }), log: (l) => log.push(l) };
  return { d, notes, log };
}

describe("p237Of / pluck", () => {
  it("our folder becomes host/path with no scheme and no trailing slash; anything else is fenced", () => {
    assert.equal(p237Of(FOLDER), "m.connectcomunications.com/phoneprov/a70274ea0f143ca0");
    assert.equal(p237Of("https://evil.example.com/phoneprov/x/"), null);
    assert.equal(p237Of("http://192.168.1.9/cfg/"), null);
  });
  it("pluck finds a key at any depth and never loops on cycles", () => {
    const o: any = { response: "success", body: { "237": "a/b", nested: {} } }; o.body.nested.back = o;
    assert.equal(pluck(o, "237"), "a/b");
    assert.equal(pluck(o, "999"), null);
  });
});

describe("gsProbe — the fresh-out-of-the-box read", () => {
  it("admin/admin opens a factory GXP2170: loginWorked + usedDefault + identity + its provisioning target", async () => {
    const ph = fakePhone(); const { d, notes } = deps(ph.http);
    const r = await gsProbe(d, { ip: IP, creds: GRANDSTREAM_DEFAULT_CREDENTIALS, usedDefault: true });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.family, "grandstream_cgi");
    assert.equal(r.loginWorked, true);
    assert.equal(r.usedDefault, true);
    assert.equal(r.model, "GXP2170");
    assert.equal(r.firmware, "1.0.11.103");
    assert.equal(r.provisioningUrl, "http://fm.grandstream.com/gs");
    assert.deepEqual(notes, [{ ip: IP, ok: true }]);
  });
  it("a phone with the old provider's password: loginWorked=false, identity still read, ONE budget spend", async () => {
    const ph = fakePhone({ password: "s3cret" }); const { d, notes } = deps(ph.http);
    const r = await gsProbe(d, { ip: IP, creds: GRANDSTREAM_DEFAULT_CREDENTIALS, usedDefault: true });
    assert.equal(r.ok && r.loginWorked, false);
    assert.equal(r.ok && r.model, "GXP2170");
    assert.deepEqual(notes, [{ ip: IP, ok: false }]);
    assert.equal(ph.state.logins, 1, "never retried");
  });
  it("the shared lockout gate stops the login before a single request", async () => {
    const ph = fakePhone(); const { d } = deps(ph.http, true);
    const r = await gsProbe(d, { ip: IP, creds: GRANDSTREAM_DEFAULT_CREDENTIALS, usedDefault: true });
    assert.equal(r.ok && r.loginWorked, false);
    assert.equal(ph.state.logins, 0);
  });
  it("refuses a public address outright", async () => {
    const ph = fakePhone(); const { d } = deps(ph.http);
    assert.deepEqual(await gsProbe(d, { ip: "8.8.8.8", creds: GRANDSTREAM_DEFAULT_CREDENTIALS, usedDefault: true }), { ok: false, refused: "not_a_private_address" });
  });
});

describe("gsProvision — the one write, verified by read-back", () => {
  it("writes P237/P212 to our folder, reads them back, then restarts the phone", async () => {
    const ph = fakePhone(); const { d } = deps(ph.http);
    const r = await gsProvision(d, { ip: IP, mac: "c0:74:ad:8c:60:5f", url: FOLDER, creds: GRANDSTREAM_DEFAULT_CREDENTIALS });
    assert.deepEqual(r, { ok: true, op: "web_provision", provisioned: true, urlVerified: true });
    assert.equal(ph.state.p237, "m.connectcomunications.com/phoneprov/a70274ea0f143ca0");
    assert.equal(ph.state.p212, "2");
    assert.deepEqual(ph.state.ops, ["request=REBOOT&sid=s1"]);
  });
  it("⛔ a GDMS-claimed phone that keeps its factory P237 is refused save_not_verified — never reported provisioned, never restarted", async () => {
    const ph = fakePhone({ claimed: true }); const { d, log } = deps(ph.http);
    const r = await gsProvision(d, { ip: IP, mac: "c074ad8c605f", url: FOLDER, creds: GRANDSTREAM_DEFAULT_CREDENTIALS });
    assert.deepEqual(r, { ok: false, refused: "save_not_verified" });
    assert.equal(ph.state.writes, 1);
    assert.deepEqual(ph.state.ops, []);
    assert.match(log.join("\n"), /did not land/);
  });
  it("⛔ the URL fence runs before any request; a wrong device is refused before any write", async () => {
    const ph = fakePhone({ mac: "c074ad8c654e" }); const { d } = deps(ph.http);
    assert.deepEqual(await gsProvision(d, { ip: IP, mac: "c074ad8c605f", url: "https://elsewhere.example.com/x/", creds: GRANDSTREAM_DEFAULT_CREDENTIALS }), { ok: false, refused: "fenced_url_refused" });
    assert.deepEqual(await gsProvision(d, { ip: IP, mac: "c074ad8c605f", url: FOLDER, creds: GRANDSTREAM_DEFAULT_CREDENTIALS }), { ok: false, refused: "wrong_device" });
    assert.equal(ph.state.writes, 0);
    assert.equal(ph.state.logins, 0);
  });
  it("a refused password never writes", async () => {
    const ph = fakePhone({ password: "other" }); const { d } = deps(ph.http);
    assert.deepEqual(await gsProvision(d, { ip: IP, mac: "c074ad8c605f", url: FOLDER, creds: GRANDSTREAM_DEFAULT_CREDENTIALS }), { ok: false, refused: "login_failed" });
    assert.equal(ph.state.writes, 0);
  });
});

describe("gsReset", () => {
  it("logs in and sends RESET once", async () => {
    const ph = fakePhone(); const { d } = deps(ph.http);
    assert.deepEqual(await gsReset(d, { ip: IP, creds: GRANDSTREAM_DEFAULT_CREDENTIALS }), { ok: true, op: "web_reset", sent: true });
    assert.deepEqual(ph.state.ops, ["request=RESET&sid=s1"]);
  });
});
