/**
 * The SIP identity probe — built 2026-08-25 after A plus center's first live run,
 * where every SIP device's web page was locked and the whole office fingerprinted
 * as "unknown". A SIP device signs its own refusals; these tests pin that we read
 * the signature and nothing else.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildSipOptions, parseSipBanner, SIP_PROBE_PORT } from "./sipProbe";
import { identityFromBanner } from "./yealink";
import { createPhoneCapability } from "./capability";

/* ── the packet ──────────────────────────────────────────────────────────── */

test("the OPTIONS packet is well-formed SIP and read-only", () => {
  const pkt = buildSipOptions("192.168.0.5", "abc123xyz0");
  assert.ok(pkt, "a private address must build a packet");
  assert.match(pkt!, /^OPTIONS sip:probe@192\.168\.0\.5:5060 SIP\/2\.0\r\n/);
  assert.match(pkt!, /\r\nContent-Length: 0\r\n\r\n$/);
  // ⛔ OPTIONS only — no REGISTER, no INVITE, no NOTIFY. This module asks who a
  // device is; anything that could CHANGE a device does not belong in it.
  assert.ok(!/REGISTER|INVITE|NOTIFY|SUBSCRIBE|MESSAGE/i.test(pkt!.split("\r\n")[0]));
});

test("a public address builds nothing at all", () => {
  assert.equal(buildSipOptions("8.8.8.8", "abc123"), null);
});

test("a hostile branch seed cannot inject headers into our own packet", () => {
  assert.equal(buildSipOptions("192.168.0.5", "x\r\nEvil: yes"), null);
  assert.equal(buildSipOptions("192.168.0.5", "x y"), null);
});

/* ── the reply ───────────────────────────────────────────────────────────── */

const REPLY = (headers: string[]) =>
  ["SIP/2.0 200 OK", "Via: SIP/2.0/UDP 0.0.0.0:5060", ...headers, "Content-Length: 0", "", ""].join("\r\n");

test("the banner is read from User-Agent or Server, on ANY SIP response", () => {
  assert.equal(parseSipBanner(REPLY(["User-Agent: Fanvil i16SV 2.4.0"])), "Fanvil i16SV 2.4.0");
  assert.equal(parseSipBanner(REPLY(["Server: Grandstream HT812 1.0.29.8"])), "Grandstream HT812 1.0.29.8");
  // A refusal still signs itself.
  const refused = ["SIP/2.0 405 Method Not Allowed", "User-Agent: Yealink SIP-T42S 66.84.0.125", "", ""].join("\r\n");
  assert.equal(parseSipBanner(refused), "Yealink SIP-T42S 66.84.0.125");
});

test("a non-SIP datagram parses to nothing — never to a device", () => {
  assert.equal(parseSipBanner("HTTP/1.1 200 OK\r\nServer: printer\r\n\r\n"), null);
  assert.equal(parseSipBanner(""), null);
  // ⛔ A SIP REQUEST arriving at our socket (someone scanning us back) is not a
  // reply and is not parsed.
  assert.equal(parseSipBanner("OPTIONS sip:us SIP/2.0\r\nUser-Agent: mallory\r\n\r\n"), null);
});

/* ── the identities that matter, verbatim vendor strings ─────────────────── */

test("the real vendors' SIP banners resolve to make and model", () => {
  const fanvil = identityFromBanner("Fanvil i16SV 2.4.0");
  assert.deepEqual([fanvil.vendor, fanvil.model], ["fanvil", "I16SV"]);
  const pa = identityFromBanner("Fanvil PA2 2.12.16");
  assert.deepEqual([pa.vendor, pa.model], ["fanvil", "PA2"]);
  const yl = identityFromBanner("Yealink SIP-T42S 66.84.0.125");
  assert.deepEqual([yl.vendor, yl.model], ["yealink", "T42S"]);
  const ht = identityFromBanner("Grandstream HT812 1.0.29.8");
  assert.deepEqual([ht.vendor, ht.model], ["grandstream", "HT812"]);
  // Panasonic's real User-Agent shape: maker-model with the region suffix, then
  // firmware — from a KX-TGP500B04 DECT base (2026-09-03).
  const pana = identityFromBanner("Panasonic-KX-TGP500B04/22.116.0.10 (0080f0aabbcc)");
  assert.deepEqual([pana.vendor, pana.model], ["panasonic", "KXTGP500B04"]);
  // Its web page titles itself by bare model, no maker's name anywhere — the KX
  // family alone must be enough to name the vendor.
  const panaWeb = identityFromBanner("KX-TGP500 Web Console");
  assert.deepEqual([panaWeb.vendor, panaWeb.model], ["panasonic", "KXTGP500"]);
  const ut = identityFromBanner("Panasonic KX-UT136 01.303");
  assert.deepEqual([ut.vendor, ut.model], ["panasonic", "KXUT136"]);
  // An unknown stays honestly unknown.
  assert.equal(identityFromBanner("Some PBX thing").vendor, "unknown");
});

/* ── the fingerprint op prefers the device's own word ────────────────────── */

function capWith(http: any, sip: any) {
  return createPhoneCapability({
    http,
    resolveCredential: async () => null,
    sipProbe: sip,
    now: (() => { let t = 0; return () => (t += 60_000); })(),
  });
}

test("a locked web page no longer means an unknown device", async () => {
  const cap = capWith(
    async () => ({ status: 401, headers: { "www-authenticate": "Basic realm=\"x\"" }, body: "" }),
    async () => ({ banner: "Fanvil i16SV 2.4.0", fingerprint: identityFromBanner("Fanvil i16SV 2.4.0") }),
  );
  const out: any = await cap.run({ op: "fingerprint", ip: "192.168.0.5" });
  assert.equal(out.ok, true);
  assert.deepEqual([out.fingerprint.vendor, out.fingerprint.model], ["fanvil", "I16SV"]);
});

test("an HTTP identity with a model is final — SIP is never even asked", async () => {
  let sipAsked = 0;
  const cap = capWith(
    async () => ({ status: 200, headers: { server: "Yealink SIP-T53W 96.86.0.15" }, body: "" }),
    async () => { sipAsked += 1; return null; },
  );
  const out: any = await cap.run({ op: "fingerprint", ip: "192.168.0.6" });
  assert.equal(out.fingerprint.model, "T53W");
  assert.equal(sipAsked, 0, "a resolved device must not cost a second probe");
});

test("silence on both fronts is still honestly unreachable", async () => {
  const cap = capWith(
    async () => { throw new Error("no route"); },
    async () => null,
  );
  const out: any = await cap.run({ op: "fingerprint", ip: "192.168.0.7" });
  assert.deepEqual(out, { ok: false, refused: "unreachable" });
});

/* ── the neighbor table, both doors ──────────────────────────────────────── */

import { parseNetshNeighbors } from "./lanScan";

test("netsh neighbors parse: real states in, failure states out", () => {
  const out = parseNetshNeighbors([
    "Interface 17: Ethernet",
    "",
    "Internet Address                              Physical Address   Type",
    "--------------------------------------------  -----------------  -----------",
    "192.168.0.61                                  80-5e-c0-c8-9b-72  Stale",
    "192.168.0.94                                  80-5e-c0-bf-8c-62  Reachable (Router)",
    "192.168.0.240                                 80-5e-c0-c8-9b-82  Probe",
    // ⛔ A FAILED lookup is not a device — treating it as one invents hardware.
    "192.168.0.77                                  00-00-00-00-00-00  Unreachable",
    "192.168.0.78                                  aa-bb-cc-dd-ee-01  Incomplete",
    "192.168.0.255                                 ff-ff-ff-ff-ff-ff  Permanent",
    "224.0.0.22                                    01-00-5e-00-00-16  Permanent",
  ].join("\r\n"));
  assert.deepEqual(out.map((h) => h.ip), ["192.168.0.61", "192.168.0.94", "192.168.0.240"]);
  assert.equal(out[0].mac, "805ec0c89b72");
});
