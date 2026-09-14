/**
 * Naming a device from what it says about itself, for the four makers the setup wizard
 * provisions — and saying WHICH way it told us, so the server can file each reading as
 * its own identification source.
 *
 * Run with: node --import tsx --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGrandstreamModelRequest, fingerprintFromGrandstreamValues, fingerprintFromResponse, identityFromBanner,
  type DeviceFingerprint, type HttpRequest, type HttpResponse,
} from "./yealink";
import { createPhoneCapability } from "./capability";

const res = (o: Partial<HttpResponse> = {}): HttpResponse => ({ status: 200, headers: {}, body: "", ...o });
const pick = (f: DeviceFingerprint | null) => (f ? [f.vendor, f.model] : null);

/* ── banners ─────────────────────────────────────────────────────────────── */

test("Poly names itself in its SIP User-Agent and on its web page", () => {
  assert.deepEqual(pick(identityFromBanner("PolycomVVX-VVX_450-UA/6.4.3.5017")), ["poly", "VVX450"]);
  assert.deepEqual(pick(identityFromBanner("Poly/CCX_600-UA/7.2.0.1234")), ["poly", "CCX600"]);
  assert.deepEqual(pick(identityFromBanner("PolyEdge-Edge_E450-UA/8.0.2")), ["poly", "EDGEE450"]);
  assert.deepEqual(pick(identityFromBanner("Polycom RealPresence Trio 8800")), ["poly", "TRIO8800"]);
  // A word that merely begins with "poly" is not the maker.
  assert.equal(identityFromBanner("Polygon Router").vendor, "unknown");
});

test("the rest of the Grandstream and Yealink families are named, and the old shapes are unchanged", () => {
  assert.deepEqual(pick(identityFromBanner("Grandstream GXV3350 1.0.3.40")), ["grandstream", "GXV3350"]);
  assert.deepEqual(pick(identityFromBanner("Grandstream GSC3505 1.0.1.15")), ["grandstream", "GSC3505"]);
  assert.deepEqual(pick(identityFromBanner("Grandstream WP820 1.0.7.81")), ["grandstream", "WP820"]);
  assert.deepEqual(pick(identityFromBanner("Grandstream DP752 1.0.3.36")), ["grandstream", "DP752"]);
  assert.deepEqual(pick(identityFromBanner("Yealink VP59 91.283.0.30")), ["yealink", "VP59"]);
  assert.deepEqual(pick(identityFromBanner("Yealink SIP-T54W 96.86.0.15")), ["yealink", "T54W"]);
  assert.deepEqual(pick(identityFromBanner("Fanvil i16SV 2.4.0")), ["fanvil", "I16SV"]);
  assert.deepEqual(pick(identityFromBanner("Panasonic-KX-TGP500B04/22.116.0.10")), ["panasonic", "KXTGP500B04"]);
});

test("a web page reading says it came from the web page", () => {
  const f = fingerprintFromResponse(res({ headers: { Server: "Yealink SIP-T42S 66.84.0.125" } }));
  assert.deepEqual([f.model, f.source], ["T42S", "http_banner"]);
});

/* ── Grandstream's own model read ────────────────────────────────────────── */

test("the model read goes only to a private office address and carries no credential", () => {
  assert.equal(buildGrandstreamModelRequest("192.168.1.20").url, "http://192.168.1.20/cgi-bin/api.values.get?request=phone_model");
  assert.ok(buildGrandstreamModelRequest("10.0.0.9", { https: true }).url.startsWith("https://10.0.0.9/"));
  assert.equal(Object.keys(buildGrandstreamModelRequest("192.168.1.20").headers).length, 0);
  for (const bad of ["8.8.8.8", "010.0.0.1", "192.168.001.001", "example.com", ""]) {
    assert.throws(() => buildGrandstreamModelRequest(bad), bad);
  }
});

test("the answer is believed only when it names a Grandstream model", () => {
  const ok = fingerprintFromGrandstreamValues(res({ body: JSON.stringify({ response: "success", body: { phone_model: "GXP2170" } }) }));
  assert.deepEqual(ok && [ok.vendor, ok.model, ok.source, ok.confidence], ["grandstream", "GXP2170", "http_device_api", "banner"]);
  assert.equal(fingerprintFromGrandstreamValues(res({ body: '{"phone_model":"HT812"}' }))?.model, "HT812");
  assert.equal(fingerprintFromGrandstreamValues(res({ body: "phone_model=GRP2614" }))?.model, "GRP2614");
  for (const bad of [
    res({ status: 401, body: '{"phone_model":"GXP2170"}' }),
    res({ body: '{"phone_model":"T54W"}' }),
    res({ body: '{"phone_model":"<script>"}' }),
    res({ body: '{"phone_model":42}' }),
    res({ body: "x".repeat(100_000) }),
    res({ body: "" }),
  ]) {
    assert.equal(fingerprintFromGrandstreamValues(bad), null);
  }
});

/* ── the fingerprint op ──────────────────────────────────────────────────── */

function capWith(http: (req: HttpRequest) => Promise<HttpResponse>, sip: any) {
  return createPhoneCapability({
    http,
    resolveCredential: async () => null,
    sipProbe: sip,
    now: (() => { let t = 0; return () => (t += 60_000); })(),
  } as any);
}

test("an unnamed Grandstream web page is asked its model, and the answer says where it came from", async () => {
  const urls: string[] = [];
  let sipAsked = 0;
  const cap = capWith(
    async (req) => {
      urls.push(req.url);
      if (req.url.includes("api.values.get")) return res({ body: JSON.stringify({ response: "success", body: { phone_model: "GXP2170" } }) });
      return res({ headers: { server: "lighttpd" }, body: "<title>Grandstream Device Configuration</title>" });
    },
    async () => { sipAsked += 1; return null; },
  );
  const out: any = await cap.run({ op: "fingerprint", ip: "192.168.0.8" });
  assert.equal(out.ok, true);
  assert.deepEqual([out.fingerprint.vendor, out.fingerprint.model, out.fingerprint.source], ["grandstream", "GXP2170", "http_device_api"]);
  assert.equal(sipAsked, 0);
  assert.ok(urls.some((u) => u.endsWith("/cgi-bin/api.values.get?request=phone_model")));
});

test("a maker already known from its page is not asked Grandstream's question", async () => {
  const urls: string[] = [];
  const cap = capWith(
    async (req) => { urls.push(req.url); return res({ status: 401, headers: { "www-authenticate": 'Basic realm="Yealink"' } }); },
    async () => ({ banner: "Yealink SIP-T54W 96.86.0.15", fingerprint: { ...identityFromBanner("Yealink SIP-T54W 96.86.0.15"), source: "sip_user_agent" } }),
  );
  const out: any = await cap.run({ op: "fingerprint", ip: "192.168.0.9" });
  assert.deepEqual([out.fingerprint.vendor, out.fingerprint.model, out.fingerprint.source], ["yealink", "T54W", "sip_user_agent"]);
  assert.ok(!urls.some((u) => u.includes("api.values.get")));
});

test("a web page that names its model is final — no second read of any kind", async () => {
  const urls: string[] = [];
  let sipAsked = 0;
  const cap = capWith(
    async (req) => { urls.push(req.url); return res({ headers: { server: "Yealink SIP-T53W 96.86.0.15" } }); },
    async () => { sipAsked += 1; return null; },
  );
  const out: any = await cap.run({ op: "fingerprint", ip: "192.168.0.10" });
  assert.deepEqual([out.fingerprint.model, out.fingerprint.source], ["T53W", "http_banner"]);
  assert.equal(sipAsked, 0);
  assert.equal(urls.filter((u) => u.includes("api.values.get")).length, 0);
});

test("an unknown web server is never asked Grandstream's question — the flood cap bounds reads", async () => {
  const urls: string[] = [];
  const cap = capWith(
    async (req) => { urls.push(req.url); return res({ headers: { server: "nginx" }, body: "<title>Router</title>" }); },
    async () => null,
  );
  await cap.run({ op: "fingerprint", ip: "192.168.0.11" });
  assert.equal(urls.filter((u) => u.includes("api.values.get")).length, 0);
});
