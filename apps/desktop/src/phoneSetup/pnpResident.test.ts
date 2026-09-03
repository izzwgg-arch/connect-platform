/**
 * The standing PnP responder, driven against a fake socket: armed for a folder
 * and a list of hardware addresses, it answers those phones whenever they boot,
 * once per boot, and nobody else — with no wizard involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPnpResident, PNP_RESIDENT_MAX_MACS } from "./pnpResident";
import { PNP_MULTICAST_GROUP, type PnpSocket } from "./pnp";
import { createPhoneCapability, PHONE_OPERATIONS } from "./capability";
import { sendAction, testCredentials, type HttpRequest, type HttpResponse } from "./yealink";

const URL_OK = "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/";
const URL_OTHER = "https://m.connectcomunications.com/phoneprov/0123456789abcdef/";
const MAC = "80:5E:0C:4D:79:6D";
const MAC2 = "80:5E:0C:C8:98:82";
const PHONE_IP = "192.168.0.121";

function subscribeFrom(ip: string, mac: string, callId = "abc123@" + ip): string {
  const m = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
  return [
    `SUBSCRIBE sip:MAC%3a${m}@${PNP_MULTICAST_GROUP} SIP/2.0`,
    `Via: SIP/2.0/UDP ${ip}:5060;branch=z9hG4bK1234;rport`,
    `From: <sip:MAC%3a${m}@${PNP_MULTICAST_GROUP}>;tag=77aa`,
    `To: <sip:MAC%3a${m}@${PNP_MULTICAST_GROUP}>`,
    `Call-ID: ${callId}`,
    "CSeq: 1 SUBSCRIBE",
    `Contact: <sip:${ip}:5060>`,
    "Max-Forwards: 70",
    `User-Agent: Yealink SIP-T53W 96.87.0.16 ${mac.toLowerCase()}`,
    'Event: ua-profile;profile-type="device";vendor="Yealink";model="T53W";version="96.87.0.16"',
    "Expires: 0",
    "Accept: application/url",
    "Content-Length: 0",
    "", "",
  ].join("\r\n");
}

class FakeSocket extends EventEmitter implements PnpSocket {
  sent: Array<{ text: string; port: number; address: string }> = [];
  joined: string[] = [];
  bound = false; closed = false; failBind = false;
  bind(_port: number, _address: string, cb: () => void) {
    if (this.failBind) { setImmediate(() => this.emit("error", new Error("EADDRINUSE"))); return; }
    this.bound = true; setImmediate(cb);
  }
  addMembership(group: string) { this.joined.push(group); }
  send(msg: Buffer, port: number, address: string, cb?: (err: Error | null) => void) {
    this.sent.push({ text: msg.toString("utf8"), port, address });
    if (cb) setImmediate(() => cb(null));
  }
  close() { this.closed = true; }
  deliver(text: string, address: string, port = 5060) {
    this.emit("message", Buffer.from(text, "utf8"), { address, port, family: "IPv4", size: text.length });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function make(opts: { failBind?: boolean; now?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  let t = 1_000_000;
  const resident = createPnpResident({
    createSocket: () => { const s = new FakeSocket(); s.failBind = Boolean(opts.failBind); sockets.push(s); return s; },
    now: opts.now ?? (() => (t += 1000)),
    randomToken: () => "tok",
    localAddress: "192.168.0.10",
  });
  return { resident, sockets, clock: () => t };
}

test("armed for a folder and a list, the resident answers a listed phone whenever it boots", async () => {
  const { resident, sockets } = make();
  assert.equal(await resident.arm({ url: URL_OK, macs: [MAC, MAC2] }), true);
  assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].joined, [PNP_MULTICAST_GROUP]);
  sockets[0].deliver(subscribeFrom(PHONE_IP, MAC), PHONE_IP);
  await tick();
  assert.equal(sockets[0].sent.length, 2, "200 OK then NOTIFY");
  assert.match(sockets[0].sent[0].text, /^SIP\/2\.0 200 OK/);
  assert.match(sockets[0].sent[1].text, /^NOTIFY /);
  assert.ok(sockets[0].sent[1].text.includes(URL_OK));
  const d = resident.deliveryFor(MAC);
  assert.ok(d);
  assert.equal(d.ip, PHONE_IP);
  assert.equal(d.url, URL_OK);
  assert.equal(resident.status().deliveries.length, 1);
});

test("⛔ a phone that is NOT on the list is never answered — not even from a known address", async () => {
  const { resident, sockets } = make();
  await resident.arm({ url: URL_OK, macs: [MAC] });
  sockets[0].deliver(subscribeFrom(PHONE_IP, "00:11:22:33:44:55"), PHONE_IP);
  await tick();
  assert.equal(sockets[0].sent.length, 0);
  assert.equal(resident.status().deliveries.length, 0);
});

test("⛔ a SUBSCRIBE with no hardware address in it is never answered by the resident", async () => {
  const { resident, sockets } = make();
  await resident.arm({ url: URL_OK, macs: [MAC] });
  const anon = subscribeFrom(PHONE_IP, MAC)
    .replace(/MAC%3a[0-9a-f]+/g, "pnp")
    .replace(/User-Agent: .*/, "User-Agent: Yealink SIP-T53W 96.87.0.16");
  sockets[0].deliver(anon, PHONE_IP);
  await tick();
  assert.equal(sockets[0].sent.length, 0);
});

test("one boot is answered once — a retransmitted SUBSCRIBE gets no second URL; a NEW boot does", async () => {
  const { resident, sockets } = make();
  await resident.arm({ url: URL_OK, macs: [MAC] });
  sockets[0].deliver(subscribeFrom(PHONE_IP, MAC, "boot1@x"), PHONE_IP);
  await tick();
  sockets[0].deliver(subscribeFrom(PHONE_IP, MAC, "boot1@x"), PHONE_IP);
  await tick();
  assert.equal(sockets[0].sent.length, 2);
  sockets[0].deliver(subscribeFrom("192.168.0.140", MAC, "boot2@x"), "192.168.0.140");
  await tick();
  assert.equal(sockets[0].sent.length, 4, "the same phone on a new address after a new boot is told again");
  assert.equal(resident.status().deliveries.length, 2);
});

test("the phone's 200 OK to our NOTIFY marks the delivery acknowledged", async () => {
  const { resident, sockets } = make();
  await resident.arm({ url: URL_OK, macs: [MAC] });
  sockets[0].deliver(subscribeFrom(PHONE_IP, MAC, "boot1@x"), PHONE_IP);
  await tick();
  assert.equal(resident.deliveryFor(MAC)!.acknowledged, false);
  sockets[0].deliver(["SIP/2.0 200 OK", "Via: SIP/2.0/UDP 192.168.0.10:5060;branch=z9hG4bKtok", "Call-ID: boot1@x", "CSeq: 1 NOTIFY", "Content-Length: 0", "", ""].join("\r\n"), PHONE_IP);
  await tick();
  assert.equal(resident.deliveryFor(MAC)!.acknowledged, true);
});

test("waitForDelivery resolves when the phone asks, and with null after the wait", async () => {
  const { resident, sockets } = make();
  await resident.arm({ url: URL_OK, macs: [MAC] });
  const p = resident.waitForDelivery(MAC, 500);
  sockets[0].deliver(subscribeFrom(PHONE_IP, MAC), PHONE_IP);
  const d = await p;
  assert.ok(d && d.mac === "805e0c4d796d");
  assert.equal(await resident.waitForDelivery(MAC2, 10), null);
});

test("re-arming the SAME folder keeps the socket and the log; a DIFFERENT folder starts over", async () => {
  const { resident, sockets } = make();
  await resident.arm({ url: URL_OK, macs: [MAC] });
  sockets[0].deliver(subscribeFrom(PHONE_IP, MAC), PHONE_IP);
  await tick();
  assert.equal(await resident.arm({ url: URL_OK, macs: [MAC2] }), true);
  assert.equal(sockets.length, 1, "same folder: no new socket");
  assert.equal(resident.status().macs, 2);
  assert.equal(resident.status().deliveries.length, 1);
  assert.equal(await resident.arm({ url: URL_OTHER, macs: [MAC2] }), true);
  assert.equal(resident.status().macs, 1, "another tenant's folder: the old list is gone");
  assert.equal(resident.status().deliveries.length, 0);
  assert.equal(resident.status().url, URL_OTHER);
});

test("⛔ the resident refuses to arm for anything but a Loopcom folder, and opens no socket", async () => {
  const { resident, sockets } = make();
  for (const bad of ["http://m.connectcomunications.com/phoneprov/f3df739ac62197cd/", "https://evil.example/phoneprov/f3df739ac62197cd/", "", "x"]) {
    assert.equal(await resident.arm({ url: bad, macs: [MAC] }), false, bad);
  }
  assert.equal(sockets.length, 0);
  assert.equal(resident.status().armed, false);
});

test("a socket that cannot bind reports cannot_listen; disarm closes and forgets everything", async () => {
  const { resident, sockets } = make({ failBind: true });
  assert.equal(await resident.arm({ url: URL_OK, macs: [MAC] }), false);
  assert.equal(resident.status().problem, "cannot_listen");
  const ok = make();
  await ok.resident.arm({ url: URL_OK, macs: [MAC] });
  ok.resident.disarm();
  assert.equal(ok.sockets[0].closed, true);
  assert.deepEqual(ok.resident.status(), { armed: false, listening: false, url: null, macs: 0, deliveries: [], problem: null });
  void sockets;
});

test("the list is capped", async () => {
  const { resident } = make();
  const many = Array.from({ length: PNP_RESIDENT_MAX_MACS + 5 }, (_, i) => `00:11:22:33:${String(Math.floor(i / 256)).padStart(2, "0")}:${(i % 256).toString(16).padStart(2, "0")}`);
  await resident.arm({ url: URL_OK, macs: many });
  assert.equal(resident.status().macs, PNP_RESIDENT_MAX_MACS);
});

/* ── through the capability ───────────────────────────────────────────────── */

function res(over: Partial<HttpResponse> = {}): HttpResponse { return { status: 200, headers: {}, body: "", ...over }; }

function cap(opts: { http?: (req: HttpRequest) => Promise<HttpResponse>; failBind?: boolean } = {}) {
  const seen: HttpRequest[] = [];
  // ⛔ ONE clock for the capability and the resident, as in production (Date.now):
  // the capability records "since" on its clock and the resident stamps deliveries
  // on its own; two fake clocks that disagree make a real delivery look old.
  let t = 1_000_000;
  const clock = () => (t += 10_000);
  const { resident, sockets } = make({ failBind: opts.failBind, now: clock });
  const api = createPhoneCapability({
    http: async (req) => { seen.push(req); return opts.http ? opts.http(req) : res({ status: 200 }); },
    resolveCredential: async (ref) => (ref === "phone:1" ? { username: "admin", password: "given" } : null),
    now: clock,
    pnpResident: resident,
  });
  return { api, seen, resident, sockets };
}

test("the allowlist has eight operations: the six plus arm_pnp and disarm_pnp", () => {
  assert.deepEqual([...PHONE_OPERATIONS].sort(),
    ["arm_pnp", "disarm_pnp", "discover", "fingerprint", "reboot", "set_provisioning", "test_credentials", "trigger_autop"]);
});

test("arm_pnp arms the resident for the customer's folder and phones; the fence applies; the list is capped", async () => {
  const { api, resident, sockets } = cap();
  const out = await api.run({ op: "arm_pnp", url: URL_OK, macs: [MAC, MAC2, "junk"] });
  assert.deepEqual(out, { ok: true, op: "arm_pnp", listening: true, macs: 2, deliveries: 0 });
  assert.equal(sockets.length, 1);
  assert.deepEqual(await api.run({ op: "arm_pnp", url: "https://evil.example/phoneprov/f3df739ac62197cd/", macs: [MAC] }), { ok: false, refused: "not_a_loopcom_provisioning_url" });
  assert.deepEqual(await api.run({ op: "arm_pnp", url: URL_OK, macs: new Array(PNP_RESIDENT_MAX_MACS + 1).fill(MAC) }), { ok: false, refused: "too_many_hardware_addresses" });
  assert.equal(resident.status().url, URL_OK);
  // A listed phone booting later — no wizard open — is told its folder.
  sockets[0].deliver(subscribeFrom(PHONE_IP, MAC2), PHONE_IP);
  await tick();
  assert.equal(resident.deliveryFor(MAC2)?.url, URL_OK);
  assert.deepEqual(await api.run({ op: "disarm_pnp" }), { ok: true, op: "disarm_pnp" });
  assert.equal(resident.status().armed, false);
});

test("set_provisioning arms the resident for the phone FIRST, then asks it to restart, then reports", async () => {
  const { api, seen, sockets } = cap();
  const p = api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 400 });
  await tick();
  assert.equal(sockets.length, 1, "the listener is up before the restart is sent");
  assert.match(seen[0].url, /^http:\/\/192\.168\.0\.121\/servlet\?key=Reboot$/);
  const decoded = Buffer.from(seen[0].headers.Authorization.slice(6), "base64").toString("utf8");
  assert.equal(decoded, "admin:admin", "a reset phone is on the documented default");
  sockets[0].deliver(subscribeFrom(PHONE_IP, MAC), PHONE_IP);
  const out = await p;
  assert.equal(out.ok, true);
  assert.equal((out as any).rebooted, true);
  assert.equal((out as any).delivered, true);
  assert.equal((out as any).listening, true);
});

test("a delivery that happened EARLIER while armed counts — the phone was plugged in before the wizard asked", async () => {
  const { api, sockets } = cap();
  await api.run({ op: "arm_pnp", url: URL_OK, macs: [MAC] });
  sockets[0].deliver(subscribeFrom(PHONE_IP, MAC), PHONE_IP);
  await tick();
  const out = await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK, reboot: false, waitMs: 1 });
  assert.equal((out as any).delivered, true);
});

test("⛔ HTTPS-only phones: a restart refused on plain HTTP is retried over HTTPS, and a 401 on HTTP is NOT", async () => {
  const seen: HttpRequest[] = [];
  const httpsOnly = async (req: HttpRequest) => { seen.push(req); if (req.url.startsWith("http://")) throw new Error("ECONNREFUSED"); return res({ status: 200 }); };
  assert.deepEqual(await sendAction(httpsOnly, PHONE_IP, "reboot", { username: "admin", password: "admin" }), { ok: true });
  assert.deepEqual(seen.map((r) => r.url), ["http://192.168.0.121/servlet?key=Reboot", "https://192.168.0.121/servlet?key=Reboot"]);
  const locked: HttpRequest[] = [];
  const answersLocked = async (req: HttpRequest) => { locked.push(req); return res({ status: 401 }); };
  assert.deepEqual(await sendAction(answersLocked, PHONE_IP, "reboot", null), { ok: false, reason: "locked", status: 401 });
  assert.equal(locked.length, 1, "an answer on HTTP is an answer; no HTTPS retry");
  const dead: HttpRequest[] = [];
  const nothing = async (req: HttpRequest) => { dead.push(req); throw new Error("timeout"); };
  assert.deepEqual(await sendAction(nothing, PHONE_IP, "reboot", null), { ok: false, reason: "unreachable" });
  assert.equal(dead.length, 1, "⛔ a TIMEOUT is never retried — the phone may already be restarting");
  const closed: HttpRequest[] = [];
  const bothClosed = async (req: HttpRequest) => { closed.push(req); const e: any = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; };
  assert.deepEqual(await sendAction(bothClosed, PHONE_IP, "reboot", null), { ok: false, reason: "unreachable" });
  assert.equal(closed.length, 2, "both ports closed: http then https, then unreachable");
  assert.deepEqual(await testCredentials(httpsOnly, PHONE_IP, { username: "admin", password: "admin" }), { ok: true });
});

test("reboot:false only listens and checks — no HTTP request leaves the machine", async () => {
  const { api, seen } = cap();
  const out = await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK, reboot: false, waitMs: 1 });
  assert.equal(seen.length, 0);
  assert.equal((out as any).delivered, false);
  assert.equal((out as any).rebooted, false);
});

test("a refused restart still reports listening — the person can plug the phone in instead", async () => {
  const { api } = cap({ http: async () => res({ status: 401 }) });
  const out = await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 1 });
  assert.equal((out as any).listening, true);
  assert.equal((out as any).rebooted, false);
  assert.equal((out as any).rebootRefused, "locked");
  assert.equal((out as any).delivered, false);
});

test("⛔ set_provisioning refuses every URL that is not a Loopcom folder before touching the network", async () => {
  const { api, seen, sockets } = cap();
  for (const bad of [
    "http://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",
    "https://evil.example/phoneprov/f3df739ac62197cd/",
    "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/../../",
    "https://m.connectcomunications.com/", "", undefined, 7,
  ]) {
    const out = await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: bad as any } as any);
    assert.deepEqual(out, { ok: false, refused: "not_a_loopcom_provisioning_url" }, String(bad));
  }
  assert.equal(seen.length, 0);
  assert.equal(sockets.length, 0);
});

test("a public address and a bad hardware address are refused before the resident is touched", async () => {
  const { api, sockets } = cap();
  assert.deepEqual(await api.run({ op: "set_provisioning", ip: "8.8.8.8", mac: MAC, url: URL_OK }), { ok: false, refused: "not_a_private_address" });
  assert.deepEqual(await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: "bad", url: URL_OK }), { ok: false, refused: "bad_hardware_address" });
  assert.equal(sockets.length, 0);
});

test("when the machine cannot listen, nothing is restarted and the caller is told", async () => {
  const { api, seen } = cap({ failBind: true });
  const out = await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK });
  assert.deepEqual(out, { ok: false, refused: "cannot_listen" });
  assert.equal(seen.length, 0);
});

test("a restart is spaced like the other things that change a phone; a listen-and-check is not", async () => {
  const { resident } = make();
  let t = 100_000;
  const api = createPhoneCapability({ http: async () => res({ status: 200 }), resolveCredential: async () => null, now: () => t, pnpResident: resident });
  assert.equal((await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 1 })).ok, true);
  t = 101_000;
  assert.deepEqual(await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 1 }), { ok: false, refused: "too_soon_for_this_phone" });
  assert.equal((await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK, reboot: false, waitMs: 1 })).ok, true, "checking is a read");
});
