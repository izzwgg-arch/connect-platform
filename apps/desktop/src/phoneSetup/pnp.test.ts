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
import { isLoopcomProvisioningUrl } from "./yealink";

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

/* The capability-level tests live in pnpResident.test.ts — the capability rides the
   standing responder now (2026-09-02, same evening). The one-shot responder above is
   kept as the proven building block and its tests are unchanged. */
