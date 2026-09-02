/**
 * The PnP responder, driven end to end against a fake socket — the whole
 * SUBSCRIBE → 200 OK → NOTIFY → 200 OK exchange, the target fence, and the fact
 * that a stranger's phone is never answered. None of it needs a handset.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildPnpNotify, buildPnpOk, isNotifyAck, normalizeMac, notifyTarget, parsePnpSubscribe,
  pickLocalAddressFor, startPnpHandoff, PNP_MULTICAST_GROUP, PNP_PORT, type PnpSocket,
} from "./pnp";
import { createPhoneCapability, PHONE_OPERATIONS } from "./capability";
import { isLoopcomProvisioningUrl, type HttpRequest, type HttpResponse } from "./yealink";

const URL_OK = "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/";
const MAC = "80:5E:0C:4D:79:6D";
const PHONE_IP = "192.168.0.121";

/** A SUBSCRIBE shaped like the one a reset T53W multicasts on boot. */
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
  joined: Array<{ group: string; iface?: string }> = [];
  bound = false; closed = false; failBind = false;
  bind(_port: number, _address: string, cb: () => void) {
    if (this.failBind) { setImmediate(() => this.emit("error", new Error("EADDRINUSE"))); return; }
    this.bound = true; setImmediate(cb);
  }
  addMembership(group: string, iface?: string) { this.joined.push({ group, iface }); }
  send(msg: Buffer, port: number, address: string, cb?: (err: Error | null) => void) {
    this.sent.push({ text: msg.toString("utf8"), port, address });
    if (cb) setImmediate(() => cb(null));
  }
  close() { this.closed = true; }
  /** The network delivers a datagram. */
  deliver(text: string, address: string, port = 5060) {
    this.emit("message", Buffer.from(text, "utf8"), { address, port, family: "IPv4", size: text.length });
  }
}

/* ── parsing ─────────────────────────────────────────────────────────────── */

test("a Yealink PnP SUBSCRIBE parses with its hardware address", () => {
  const sub = parsePnpSubscribe(subscribeFrom(PHONE_IP, MAC));
  assert.ok(sub);
  assert.equal(sub!.mac, "805e0c4d796d");
  assert.equal(sub!.callId, `abc123@${PHONE_IP}`);
  assert.equal(sub!.cseq, "1 SUBSCRIBE");
  assert.match(sub!.event, /^ua-profile/);
  assert.equal(sub!.vias.length, 1);
});

test("anything that is not a ua-profile SUBSCRIBE is ignored, not guessed", () => {
  assert.equal(parsePnpSubscribe("OPTIONS sip:x@1.2.3.4 SIP/2.0\r\nVia: a\r\n\r\n"), null);
  assert.equal(parsePnpSubscribe(subscribeFrom(PHONE_IP, MAC).replace("Event: ua-profile", "Event: presence")), null);
  assert.equal(parsePnpSubscribe(subscribeFrom(PHONE_IP, MAC).replace(/Call-ID:.*\r\n/, "")), null);
  assert.equal(parsePnpSubscribe(""), null);
  assert.equal(parsePnpSubscribe("garbage"), null);
});

test("compact header names are understood", () => {
  const compact = subscribeFrom(PHONE_IP, MAC)
    .replace("Via:", "v:").replace("From:", "f:").replace("To:", "t:").replace("Call-ID:", "i:").replace("Event:", "o:");
  const sub = parsePnpSubscribe(compact);
  assert.ok(sub && sub.mac === "805e0c4d796d");
});

/* ── the messages ─────────────────────────────────────────────────────────── */

test("the NOTIFY carries exactly the folder URL as application/url", () => {
  const sub = parsePnpSubscribe(subscribeFrom(PHONE_IP, MAC))!;
  const n = buildPnpNotify(sub, URL_OK, { ip: "192.168.0.50", port: PNP_PORT }, "tag1", "seed1", `sip:${PHONE_IP}:5060`);
  const [head, body] = n.split("\r\n\r\n");
  assert.equal(body, URL_OK);
  assert.match(head, /^NOTIFY sip:192\.168\.0\.121:5060 SIP\/2\.0\r\n/);
  assert.match(head, /\r\nEvent: ua-profile;effective-by=0\r\n/);
  assert.match(head, /\r\nSubscription-State: terminated;reason=timeout\r\n/);
  assert.match(head, /\r\nContent-Type: application\/url\r\n/);
  assert.match(head, new RegExp(`\\r\\nContent-Length: ${URL_OK.length}$`));
  assert.match(head, /\r\nTo: <sip:MAC%3a805e0c4d796d@224\.0\.1\.75>;tag=77aa\r\n/);
  assert.match(head, /\r\nCall-ID: abc123@192\.168\.0\.121\r\n/);
});

test("the 200 OK echoes the phone's dialog and adds our To tag", () => {
  const sub = parsePnpSubscribe(subscribeFrom(PHONE_IP, MAC))!;
  const ok = buildPnpOk(sub, { ip: "192.168.0.50", port: PNP_PORT }, "ourtag");
  assert.match(ok, /^SIP\/2\.0 200 OK\r\n/);
  assert.match(ok, /\r\nVia: SIP\/2\.0\/UDP 192\.168\.0\.121:5060;branch=z9hG4bK1234;rport\r\n/);
  assert.match(ok, /\r\nTo: <sip:MAC%3a805e0c4d796d@224\.0\.1\.75>;tag=ourtag\r\n/);
  assert.match(ok, /\r\nCSeq: 1 SUBSCRIBE\r\n/);
  assert.match(ok, /\r\nContent-Length: 0\r\n\r\n$/);
});

test("the NOTIFY builder refuses any URL that is not a Loopcom folder", () => {
  const sub = parsePnpSubscribe(subscribeFrom(PHONE_IP, MAC))!;
  for (const bad of ["http://m.connectcomunications.com/phoneprov/f3df739ac62197cd/", "https://evil.example/phoneprov/f3df739ac62197cd/"]) {
    assert.throws(() => buildPnpNotify(sub, bad, { ip: "192.168.0.50", port: 5060 }, "t", "s", "sip:x"));
  }
});

test("the NOTIFY goes to the phone's Contact when it is a plain sip URI, else to where the SUBSCRIBE came from", () => {
  const sub = parsePnpSubscribe(subscribeFrom(PHONE_IP, MAC))!;
  assert.equal(notifyTarget(sub, { address: PHONE_IP, port: 5060 }), `sip:${PHONE_IP}:5060`);
  const weird = { ...sub, contact: '<sip:evil@1.2.3.4;transport=tcp?Route=%3Csip:x%3E>' };
  assert.equal(notifyTarget(weird, { address: PHONE_IP, port: 5061 }), `sip:${PHONE_IP}:5061`, "a contact with parameters is not trusted");
});

test("an acknowledgement is a 2xx to OUR NOTIFY in this dialog and nothing else", () => {
  const ack = "SIP/2.0 200 OK\r\nCall-ID: abc123@x\r\nCSeq: 1 NOTIFY\r\nContent-Length: 0\r\n\r\n";
  assert.equal(isNotifyAck(ack, "abc123@x"), true);
  assert.equal(isNotifyAck(ack, "other"), false);
  assert.equal(isNotifyAck(ack.replace("1 NOTIFY", "1 SUBSCRIBE"), "abc123@x"), false);
  assert.equal(isNotifyAck(ack.replace("200 OK", "481 Gone"), "abc123@x"), false);
});

/* ── the exchange, end to end ─────────────────────────────────────────────── */

test("the target phone is answered: 200 OK, then the NOTIFY with the folder, then its ack ends the wait", async () => {
  const sock = new FakeSocket();
  const h = startPnpHandoff({ ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 5_000, localAddress: "192.168.0.50", createSocket: () => sock });
  assert.equal(await h.listening, true);
  assert.deepEqual(sock.joined, [{ group: PNP_MULTICAST_GROUP, iface: "192.168.0.50" }]);
  sock.deliver(subscribeFrom(PHONE_IP, MAC), PHONE_IP);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sock.sent.length, 2);
  assert.match(sock.sent[0].text, /^SIP\/2\.0 200 OK/);
  assert.match(sock.sent[1].text, /^NOTIFY /);
  assert.ok(sock.sent[1].text.endsWith(`\r\n\r\n${URL_OK}`));
  assert.equal(sock.sent[1].address, PHONE_IP);
  sock.deliver("SIP/2.0 200 OK\r\nCall-ID: abc123@192.168.0.121\r\nCSeq: 1 NOTIFY\r\nContent-Length: 0\r\n\r\n", PHONE_IP);
  const out = await h.outcome;
  assert.deepEqual({ ok: out.ok, delivered: (out as any).delivered, acknowledged: (out as any).acknowledged }, { ok: true, delivered: true, acknowledged: true });
  assert.equal(sock.closed, true);
});

test("a phone that came back on a NEW address is still recognised by its hardware address", async () => {
  const sock = new FakeSocket();
  const h = startPnpHandoff({ ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 5_000, localAddress: "192.168.0.50", createSocket: () => sock });
  await h.listening;
  sock.deliver(subscribeFrom("192.168.0.222", MAC), "192.168.0.222");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[1].address, "192.168.0.222", "the NOTIFY goes where the phone is NOW");
});

test("⛔ a different phone is never answered — not by address, not at all", async () => {
  const sock = new FakeSocket();
  const h = startPnpHandoff({ ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 60, localAddress: "192.168.0.50", createSocket: () => sock });
  await h.listening;
  // Another phone on the same network booting at the same moment.
  sock.deliver(subscribeFrom("192.168.0.99", "80:5E:C0:BF:8C:62"), "192.168.0.99");
  // A SUBSCRIBE from the target's OLD address but naming another phone's MAC.
  sock.deliver(subscribeFrom(PHONE_IP, "00:11:22:33:44:55"), PHONE_IP);
  const out = await h.outcome;
  assert.equal(sock.sent.length, 0, "nothing was sent to anybody");
  assert.deepEqual({ ok: out.ok, delivered: (out as any).delivered, reason: (out as any).reason }, { ok: true, delivered: false, reason: "no_subscribe" });
  assert.equal(sock.closed, true);
});

test("the target is answered ONCE — a retransmitted SUBSCRIBE does not get a second URL", async () => {
  const sock = new FakeSocket();
  const h = startPnpHandoff({ ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 5_000, localAddress: "192.168.0.50", createSocket: () => sock });
  await h.listening;
  sock.deliver(subscribeFrom(PHONE_IP, MAC), PHONE_IP);
  sock.deliver(subscribeFrom(PHONE_IP, MAC), PHONE_IP);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sock.sent.length, 2);
  sock.deliver("SIP/2.0 200 OK\r\nCall-ID: abc123@192.168.0.121\r\nCSeq: 1 NOTIFY\r\n\r\n", PHONE_IP);
  await h.outcome;
});

test("delivered without an ack is still delivered — a phone already fetching may not bother", async () => {
  const sock = new FakeSocket();
  const h = startPnpHandoff({ ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 20_000, localAddress: "192.168.0.50", createSocket: () => sock });
  await h.listening;
  sock.deliver(subscribeFrom(PHONE_IP, MAC), PHONE_IP);
  const out = await h.outcome; // resolves after the 3 s ack window
  assert.deepEqual({ ok: out.ok, delivered: (out as any).delivered, acknowledged: (out as any).acknowledged }, { ok: true, delivered: true, acknowledged: false });
});

test("a socket that cannot bind is 'cannot listen', and the caller is told before any reboot", async () => {
  const sock = new FakeSocket(); sock.failBind = true;
  const h = startPnpHandoff({ ip: PHONE_IP, mac: MAC, url: URL_OK, waitMs: 5_000, localAddress: null, createSocket: () => sock });
  assert.equal(await h.listening, false);
  assert.deepEqual(await h.outcome, { ok: false, refused: "cannot_listen" });
});

test("a bad target or a non-Loopcom URL never opens a socket", async () => {
  let opened = 0;
  const mk = () => { opened += 1; return new FakeSocket(); };
  assert.deepEqual(await startPnpHandoff({ ip: "8.8.8.8", mac: MAC, url: URL_OK, createSocket: mk }).outcome, { ok: false, refused: "bad_target" });
  assert.deepEqual(await startPnpHandoff({ ip: PHONE_IP, mac: "nope", url: URL_OK, createSocket: mk }).outcome, { ok: false, refused: "bad_target" });
  assert.deepEqual(await startPnpHandoff({ ip: PHONE_IP, mac: MAC, url: "https://evil.example/phoneprov/f3df739ac62197cd/", createSocket: mk }).outcome, { ok: false, refused: "bad_url" });
  assert.equal(opened, 0);
});

test("the local address is the one on the phone's network", () => {
  const ifaces: any = {
    "Ethernet": [{ address: "192.168.0.50", netmask: "255.255.255.0", family: "IPv4", internal: false }],
    "WiFi": [{ address: "10.7.7.7", netmask: "255.255.255.0", family: "IPv4", internal: false }],
    "Loopback": [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
  };
  assert.equal(pickLocalAddressFor("192.168.0.121", ifaces), "192.168.0.50");
  assert.equal(pickLocalAddressFor("10.7.7.100", ifaces), "10.7.7.7");
  assert.equal(pickLocalAddressFor("172.16.5.5", ifaces), "192.168.0.50", "off-network falls back to the first private address");
  assert.equal(pickLocalAddressFor("192.168.0.121", {}), null);
});

/* ── the URL fence ────────────────────────────────────────────────────────── */

test("⛔ only a Loopcom PBX provisioning folder is ever an acceptable URL", () => {
  assert.equal(isLoopcomProvisioningUrl(URL_OK), true);
  assert.equal(isLoopcomProvisioningUrl("https://pbx.loopcom.net/phoneprov/0123456789abcdef/"), true);
  for (const bad of [
    "http://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",          // not https
    "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd",           // no trailing slash
    "https://m.connectcomunications.com/phoneprov/f3df739ac62197c/",           // 15 hex
    "https://m.connectcomunications.com/phoneprov/../etc/",                    // not a folder
    "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/?x=1",      // query
    "https://m.connectcomunications.com:8443/phoneprov/f3df739ac62197cd/",     // port
    "https://u:p@m.connectcomunications.com/phoneprov/f3df739ac62197cd/",      // userinfo
    "https://connectcomunications.com.evil.example/phoneprov/f3df739ac62197cd/", // lookalike
    "https://evilconnectcomunications.com/phoneprov/f3df739ac62197cd/",        // lookalike
    "https://m.connectcomunications.com/other/f3df739ac62197cd/",              // wrong path
    "ftp://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",
    "", null, undefined, 42, {}, "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/".repeat(3),
  ]) {
    assert.equal(isLoopcomProvisioningUrl(bad as any), false, String(bad));
  }
});

test("normalizeMac is strict", () => {
  assert.equal(normalizeMac("80:5E:0C:4D:79:6D"), "805e0c4d796d");
  assert.equal(normalizeMac("805e0c4d796d"), "805e0c4d796d");
  assert.equal(normalizeMac("00:00:00:00:00:00"), null);
  assert.equal(normalizeMac("zz"), null);
  assert.equal(normalizeMac(null), null);
});

/* ── through the capability ───────────────────────────────────────────────── */

function res(over: Partial<HttpResponse> = {}): HttpResponse { return { status: 200, headers: {}, body: "", ...over }; }

function capWithPnp(pnpOutcome: any = { ok: true, delivered: true, acknowledged: true, agent: "Yealink", waitedMs: 1 }, listening = true) {
  const seen: HttpRequest[] = [];
  const pnpCalls: any[] = [];
  const order: string[] = [];
  let t = 1_000_000;
  const api = createPhoneCapability({
    http: async (req) => { seen.push(req); order.push("http"); return res({ status: 200 }); },
    resolveCredential: async (ref) => (ref === "phone:1" ? { username: "admin", password: "given" } : null),
    now: () => (t += 10_000),
    pnp: (opts) => {
      pnpCalls.push(opts); order.push("listen");
      return { listening: Promise.resolve(listening), outcome: Promise.resolve(pnpOutcome) };
    },
  });
  return { api, seen, pnpCalls, order };
}

test("the allowlist now has six operations and set_provisioning is one of them", () => {
  assert.deepEqual([...PHONE_OPERATIONS].sort(),
    ["discover", "fingerprint", "reboot", "set_provisioning", "test_credentials", "trigger_autop"]);
});

test("set_provisioning listens FIRST, then restarts the phone with the documented default, then reports", async () => {
  const { api, seen, pnpCalls, order } = capWithPnp();
  const out = await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK });
  assert.deepEqual(out, { ok: true, op: "set_provisioning", rebooted: true, delivered: true, acknowledged: true, waitedMs: 1 });
  assert.deepEqual(order, ["listen", "http"], "a responder that starts after the reboot can miss a fast phone");
  assert.equal(pnpCalls[0].url, URL_OK);
  assert.equal(pnpCalls[0].mac, "805e0c4d796d");
  assert.match(seen[0].url, /servlet\?key=Reboot$/);
  const decoded = Buffer.from(seen[0].headers.Authorization.slice(6), "base64").toString("utf8");
  assert.equal(decoded, "admin:admin", "a reset phone is on the documented default");
});

test("set_provisioning uses the customer's stored password by reference when there is one", async () => {
  const { api, seen } = capWithPnp();
  await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK, credentialRef: "phone:1" });
  const decoded = Buffer.from(seen[0].headers.Authorization.slice(6), "base64").toString("utf8");
  assert.equal(decoded, "admin:given");
});

test("reboot:false only listens — the person is power-cycling the phone", async () => {
  const { api, seen } = capWithPnp({ ok: true, delivered: false, reason: "no_subscribe", waitedMs: 5 });
  const out = await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK, reboot: false });
  assert.equal(seen.length, 0, "no HTTP request left the machine");
  assert.deepEqual(out, { ok: true, op: "set_provisioning", rebooted: false, delivered: false, acknowledged: false, waitedMs: 5 });
});

test("⛔ set_provisioning refuses every URL that is not a Loopcom folder before touching the network", async () => {
  const { api, seen, pnpCalls } = capWithPnp();
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
  assert.equal(pnpCalls.length, 0);
});

test("a public address is refused for set_provisioning like every other operation", async () => {
  const { api, pnpCalls } = capWithPnp();
  assert.deepEqual(await api.run({ op: "set_provisioning", ip: "8.8.8.8", mac: MAC, url: URL_OK }), { ok: false, refused: "not_a_private_address" });
  assert.deepEqual(await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: "bad", url: URL_OK }), { ok: false, refused: "bad_hardware_address" });
  assert.equal(pnpCalls.length, 0);
});

test("when the machine cannot listen, nothing is rebooted and the caller is told", async () => {
  const { api, seen } = capWithPnp({ ok: false, refused: "cannot_listen" }, false);
  const out = await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK });
  assert.deepEqual(out, { ok: false, refused: "cannot_listen" });
  assert.equal(seen.length, 0, "a phone must not be restarted for a hand-off that cannot happen");
});

test("a refused reboot still reports the listen result — the person can power-cycle instead", async () => {
  const pnp = { ok: true, delivered: true, acknowledged: false, agent: "Yealink", waitedMs: 9 };
  const seen: HttpRequest[] = [];
  const api = createPhoneCapability({
    http: async (req) => { seen.push(req); return res({ status: 401 }); },
    resolveCredential: async () => null,
    pnp: () => ({ listening: Promise.resolve(true), outcome: Promise.resolve(pnp as any) }),
  });
  const out = await api.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK });
  assert.deepEqual(out, { ok: true, op: "set_provisioning", rebooted: false, rebootRefused: "locked", delivered: true, acknowledged: false, waitedMs: 9 });
});

test("set_provisioning is spaced like the other things that change a phone", async () => {
  const { api } = capWithPnp();
  let t = 100_000;
  const api2 = createPhoneCapability({
    http: async () => res({ status: 200 }), resolveCredential: async () => null, now: () => t,
    pnp: () => ({ listening: Promise.resolve(true), outcome: Promise.resolve({ ok: true, delivered: true, acknowledged: true, agent: null, waitedMs: 1 } as any) }),
  });
  void api;
  assert.equal((await api2.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK })).ok, true);
  t = 101_000;
  assert.deepEqual(await api2.run({ op: "set_provisioning", ip: PHONE_IP, mac: MAC, url: URL_OK }), { ok: false, refused: "too_soon_for_this_phone" });
});
