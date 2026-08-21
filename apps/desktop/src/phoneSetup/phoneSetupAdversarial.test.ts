/**
 * Attacking the security boundary on purpose.
 *
 * Izzy, 2026-08-21: "stress test the fuck out of it, 100 rock hard solid for years
 * to come."
 *
 * ⛔⛔ THIS FILE ALREADY FOUND ONE REAL HOLE. Fuzzing `isPrivateIpv4` showed that
 * `010.0.0.1` was ALLOWED: a naive check reads the octet as decimal ten, so it looks
 * like the private 10.0.0.0/8 range — while `inet_addr` and the resolvers built on it
 * read a leading zero as OCTAL and send the request to 8.0.0.1, a public address.
 * That is an SSRF bypass in the one fence that keeps this capability from being a
 * general request-sending machine. Fixed the same day; these guards fail against the
 * version that shipped it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isPrivateIpv4, canonicalPrivateIpv4, buildActionRequest, buildStatusRequest,
  fingerprintFromResponse, classifyProvisioningUrl, supportsSipReset,
  sendAction, testCredentials, type HttpRequest, type HttpResponse,
} from "./yealink";
import { createPhoneCapability, PHONE_OPERATIONS } from "./capability";

const res = (o: Partial<HttpResponse> = {}): HttpResponse => ({ status: 200, headers: {}, body: "", ...o });

/* ── the address fence, attacked ─────────────────────────────────────────── */

test("ADVERSARIAL: an octal-looking octet can never reach the network", () => {
  // 010 -> 8 under inet_addr. 0177 -> 127. Both must be refused outright.
  for (const evil of [
    "010.0.0.1", "0177.0.0.1", "192.168.001.001", "192.168.1.010", "010.010.010.010",
    "00.0.0.1", "0000000010.0.0.1",
  ]) {
    assert.equal(isPrivateIpv4(evil), false, `${evil} was allowed`);
    assert.equal(canonicalPrivateIpv4(evil), null);
    assert.throws(() => buildActionRequest(evil, "reboot", null), /private office address/);
  }
});

test("ADVERSARIAL: every other way of writing an address is refused too", () => {
  const evil = [
    "2130706433", "0x7f000001", "0x7f.0.0.1", "127.1", "127.0.1",
    "192.168.1.1:8080", "192.168.1.1/../", "192.168.1.1 ", " 192.168.1.1",
    "192.168.1.1%00", "192.168.1.1@evil.example", "evil.example", "localhost",
    "::1", "::ffff:192.168.1.1", "[::1]", "192.168.1.1.", ".192.168.1.1",
    "192.168.1.-1", "192.168.1.256", "999.999.999.999", "", "   ",
    "1\u09ea2.168.1.1", "\uff11\uff19\uff12.168.1.1",
    "192.168.1.1\nHost: evil", "192.168.1.1\r\nX: y",
  ];
  for (const e of evil) {
    assert.equal(isPrivateIpv4(e), false, `${JSON.stringify(e)} was allowed`);
  }
});

test("ADVERSARIAL: the request is built from the CANONICAL address, never the input", () => {
  // validating one spelling and sending another is the whole class of bug
  assert.equal(new URL(buildActionRequest("10.0.0.7", "reboot", null).url).hostname, "10.0.0.7");
  assert.equal(new URL(buildStatusRequest("172.16.3.9", null).url).hostname, "172.16.3.9");
});

test("ADVERSARIAL: public and reserved ranges stay refused", () => {
  for (const pub of [
    "8.8.8.8", "1.1.1.1", "0.0.0.0", "127.0.0.1", "169.254.169.254",
    "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0",
    "224.0.0.1", "255.255.255.255", "100.64.0.1",
  ]) {
    assert.equal(isPrivateIpv4(pub), false, `${pub} was allowed`);
  }
  // 169.254.169.254 is the cloud metadata address - the classic SSRF target
  assert.equal(canonicalPrivateIpv4("169.254.169.254"), null);
});

test("ADVERSARIAL: every address in the private ranges still works", () => {
  for (const ok of [
    "10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254",
    "192.168.0.1", "192.168.255.254", "192.168.1.41",
  ]) {
    assert.equal(isPrivateIpv4(ok), true, `${ok} was refused`);
    assert.equal(canonicalPrivateIpv4(ok), ok);
  }
});

/* ── the capability, attacked ────────────────────────────────────────────── */

function cap(over: any = {}) {
  let t = 1_000_000;
  const seen: HttpRequest[] = [];
  return {
    seen,
    advance: (ms: number) => { t += ms; },
    api: createPhoneCapability({
      http: async (req: HttpRequest) => { seen.push(req); return res({ status: 200 }); },
      resolveCredential: async () => ({ username: "admin", password: "s3cret" }),
      scan: async () => ({ subnet: "192.168.1.0/24", hostsSeen: 0, hosts: [], outcome: "ok" as const }),
      now: () => t,
      ...over,
    }),
  };
}

test("ADVERSARIAL: no payload shape can make the capability throw", async () => {
  const { api } = cap();
  const payloads: unknown[] = [
    null, undefined, 0, "", "discover", [], true, NaN,
    {}, { op: "" }, { op: null }, { op: 123 }, { op: {} }, { op: ["discover"] },
    { op: "reboot" }, { op: "reboot", ip: null }, { op: "reboot", ip: {} },
    { op: "reboot", ip: "192.168.1.1", credentialRef: {} },
    { op: "__proto__" }, { op: "constructor" }, { op: "toString" }, { op: "hasOwnProperty" },
    JSON.parse('{"op":"reboot","ip":"192.168.1.1","__proto__":{"polluted":true}}'),
    { op: "fingerprint", ip: "192.168.1.1".repeat(500) },
  ];
  for (const p of payloads) {
    const out = await api.run(p as any);
    assert.ok(out && typeof out === "object" && "ok" in out, "no result returned");
  }
  assert.equal(({} as any).polluted, undefined, "the prototype was polluted");
});

test("ADVERSARIAL: an operation name outside the list is refused before its arguments are read", async () => {
  const { api, seen } = cap();
  for (const op of [
    "factory_reset", "reset", "run_command", "exec", "fetch", "setConfig",
    "arbitraryHttp", "DISCOVER", "Discover", " discover", "discover ", "discover;reboot",
  ]) {
    const out = await api.run({ op, ip: "192.168.1.41" } as any);
    assert.deepEqual(out, { ok: false, refused: "unknown_operation" }, op);
  }
  assert.equal(seen.length, 0, "not one request should have left the machine");
});

test("ADVERSARIAL: the allowlist is exactly five operations and reset is not one", () => {
  assert.equal(PHONE_OPERATIONS.length, 5);
  for (const forbidden of ["factory_reset", "reset", "run_command", "http", "request"]) {
    assert.ok(!(PHONE_OPERATIONS as readonly string[]).includes(forbidden));
  }
});

test("ADVERSARIAL: a credential never appears in any result, refusal or error", async () => {
  const secret = "correct-horse-battery-staple";
  const { api } = cap({
    resolveCredential: async () => ({ username: "admin", password: secret }),
    http: async () => { throw new Error(`failed talking to admin:${secret}`); },
  });
  const outs = [
    await api.run({ op: "fingerprint", ip: "192.168.1.41", credentialRef: "r" }),
    await api.run({ op: "test_credentials", ip: "192.168.1.41", credentialRef: "r" }),
    await api.run({ op: "reboot", ip: "192.168.1.42", credentialRef: "r" }),
    await api.run({ op: "reboot", ip: "8.8.8.8", credentialRef: "r" }),
  ];
  for (const o of outs) {
    assert.ok(!JSON.stringify(o).includes(secret), "secret leaked in a result");
  }
});

test("ADVERSARIAL: a flood of requests is refused locally, not passed upstream", async () => {
  const { api, seen } = cap();
  let refused = 0;
  for (let i = 0; i < 200; i += 1) {
    const out = await api.run({ op: "fingerprint", ip: `192.168.1.${(i % 200) + 10}` });
    if (!out.ok) refused += 1;
  }
  assert.ok(refused > 150, `expected most of a 200-request flood refused, refused ${refused}`);
  assert.ok(seen.length <= 31, `${seen.length} requests escaped a 30/min cap`);
});

test("ADVERSARIAL: the per-phone spacing cannot be walked around with other addresses", async () => {
  const { api, advance } = cap();
  assert.equal((await api.run({ op: "reboot", ip: "192.168.1.41" })).ok, true);
  assert.equal((await api.run({ op: "reboot", ip: "192.168.1.42" })).ok, true);
  assert.deepEqual(await api.run({ op: "reboot", ip: "192.168.1.41" }), { ok: false, refused: "too_soon_for_this_phone" });
  advance(6000);
  assert.equal((await api.run({ op: "reboot", ip: "192.168.1.41" })).ok, true);
});

test("ADVERSARIAL: a scan cannot be used as a timer to hammer the network", async () => {
  const { api, advance } = cap();
  let allowed = 0;
  for (let i = 0; i < 20; i += 1) {
    if ((await api.run({ op: "discover" })).ok) allowed += 1;
    advance(1000);
  }
  assert.ok(allowed <= 2, `${allowed} scans in 20 seconds`);
});

/* ── parsing hostile device output ───────────────────────────────────────── */

test("ADVERSARIAL: a device cannot make fingerprinting throw or lie", () => {
  const hostile: HttpResponse[] = [
    res(), res({ body: "x".repeat(200_000) }),
    res({ headers: { Server: "x".repeat(50_000) } }),
    res({ headers: { Server: "Yealink " + "T".repeat(10_000) } }),
    res({ body: "<title>" + "\u202e".repeat(100) + "</title>" }),
    res({ headers: { Server: null as any } }),
    res({ headers: { "www-authenticate": undefined as any } }),
    res({ body: "<title>Yealink SIP-T54W</title>".repeat(5000) }),
    res({ status: 500, body: "<script>alert(1)</script>" }),
  ];
  for (const r of hostile) {
    const f = fingerprintFromResponse(r);
    assert.ok(["yealink", "unknown"].includes(f.vendor));
    assert.ok(f.model === null || /^[A-Z0-9]{2,24}$/.test(f.model), `bad model ${f.model}`);
    assert.ok(["reported", "banner", "none"].includes(f.confidence));
  }
});

test("ADVERSARIAL: no lookalike host is ever accepted as ours", () => {
  const ours = ["loopcom.net", "m.connectcomunications.com"];
  const evil = [
    "https://loopcom.net.evil.example/x", "https://evil.example/?loopcom.net",
    "https://evilloopcom.net/x", "https://loopcom.net@evil.example/x",
    "https://LOOPCOM.NET.evil.example/", "https://m.connectcomunications.com.evil/x",
    "loopcom.net.evil.example",
  ];
  for (const e of evil) {
    assert.notEqual(classifyProvisioningUrl(e, ours), "ours", `${e} was accepted as ours`);
  }
  // and the real thing still is, case-insensitively
  assert.equal(classifyProvisioningUrl("https://m.connectcomunications.com/phoneprov/a/", ours), "ours");
  assert.equal(classifyProvisioningUrl("https://LOOPCOM.NET/x", ours), "ours");
});

test("ADVERSARIAL: a firmware claim can never make us think a phone is more capable", () => {
  for (const junk of [
    null, undefined, "", "abc", "-1", "999999999999999999999", "8.1",
    "80.99.99.99", "Infinity", "NaN", "  ", "81a.0.0.1",
  ]) {
    const out = supportsSipReset(junk as any);
    assert.equal(typeof out, "boolean");
    if (junk === "80.99.99.99") assert.equal(out, false);
    if (junk === "abc" || junk === "" || junk == null) {
      assert.equal(out, false, "unknown firmware must never be treated as capable");
    }
  }
  assert.equal(supportsSipReset("81.0.0.1"), true);
});

test("ADVERSARIAL: an action or credential test is never retried inside the adapter", async () => {
  const failures: Array<() => Promise<HttpResponse>> = [
    async () => { throw new Error("timeout"); },
    async () => res({ status: 500 }),
    async () => res({ status: 401 }),
  ];
  for (const failure of failures) {
    let calls = 0;
    const http = async () => { calls += 1; return failure(); };
    await sendAction(http, "192.168.1.41", "reboot", null);
    assert.equal(calls, 1, "a reboot that timed out was very likely received");
    calls = 0;
    await testCredentials(http, "192.168.1.41", null);
    assert.equal(calls, 1);
  }
});
