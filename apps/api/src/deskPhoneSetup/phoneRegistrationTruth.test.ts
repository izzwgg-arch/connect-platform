import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { origIpOf, phoneRegistrationTruth, type PhoneContactReg } from "./phoneRegistrationTruth";

const c = (over: Partial<PhoneContactReg>): PhoneContactReg => ({
  endpoint: "T21_101", origIp: "192.168.6.170", extNumber: "101",
  isWebrtcDevice: false, status: "REGISTERED", lastEventAt: new Date("2026-09-17T12:00:00Z"),
  ...over,
});

describe("origIpOf", () => {
  it("reads the device's own LAN IP out of x-ast-orig-host", () => {
    assert.equal(origIpOf("sip:T21_101@50.48.58.53:5060;x-ast-orig-host=192.168.6.172:5060"), "192.168.6.172");
    assert.equal(origIpOf("sip:T21_101@50.48.58.53:38036;x-ast-orig-host=192.168.6.170:5060"), "192.168.6.170");
  });
  it("refuses hostnames, garbage and absence — never a fake IP", () => {
    assert.equal(origIpOf("sip:h69l6fnp@50.48.58.53:57544;transport=ws;x-ast-orig-host=cl36esmuukr8.invalid:0"), null);
    assert.equal(origIpOf("sip:T21_101@50.48.58.53:5060"), null);
    assert.equal(origIpOf(null), null);
    assert.equal(origIpOf("x-ast-orig-host=999.1.1.1:5060"), null);
  });
});

describe("phoneRegistrationTruth — the 2026-09-17 live run, exactly", () => {
  // The real T21 state: Yealink .170 and Grandstream .172 BOTH registered on ext
  // 101 (max_contacts=5), .171 not registered anywhere.
  const t21: PhoneContactReg[] = [
    c({ origIp: "192.168.6.170", status: "REGISTERED" }),
    c({ origIp: "192.168.6.172", status: "REGISTERED" }),
  ];

  it("the Yealink the wizard didn't know about reads CONNECTED off its own contact", () => {
    const t = phoneRegistrationTruth({ ip: "192.168.6.170", extNumber: null }, t21);
    assert.deepEqual(t, { kind: "device", connected: true, registeredAsExt: "101" });
  });

  it("a phone that self-provisioned (GDMS) reads connected AS the extension the PBX sees", () => {
    const t = phoneRegistrationTruth({ ip: "192.168.6.172", extNumber: "101" }, t21);
    assert.deepEqual(t, { kind: "device", connected: true, registeredAsExt: "101" });
  });

  it("⛔ the lie: .171 mapped to ext 101 must NOT ride the other phones' registration", () => {
    const t = phoneRegistrationTruth({ ip: "192.168.6.171", extNumber: "101" }, t21);
    assert.deepEqual(t, { kind: "extension_held_by_other_device", connected: false });
  });

  it("a phone whose own contact went UNREGISTERED reads down even while its extension is held", () => {
    const rows = [c({ origIp: "192.168.6.170", status: "UNREGISTERED" }), c({ origIp: "192.168.6.172", status: "REGISTERED" })];
    const t = phoneRegistrationTruth({ ip: "192.168.6.170", extNumber: "101" }, rows);
    assert.deepEqual(t, { kind: "device", connected: false, registeredAsExt: null });
  });

  it("extension rows all down → honestly down, not unknown", () => {
    const rows = [c({ origIp: "192.168.6.172", status: "UNREGISTERED" })];
    const t = phoneRegistrationTruth({ ip: "192.168.6.171", extNumber: "101" }, rows);
    assert.deepEqual(t, { kind: "device", connected: false, registeredAsExt: null });
  });

  it("no ip on the phone + extension held by someone → unknown (cannot tell apart), never a claim", () => {
    assert.deepEqual(phoneRegistrationTruth({ ip: null, extNumber: "101" }, t21), { kind: "unknown" });
  });

  it("cold mirror → unknown, the caller falls back to the extension-level answer", () => {
    assert.deepEqual(phoneRegistrationTruth({ ip: "192.168.6.170", extNumber: "101" }, []), { kind: "unknown" });
  });

  it("WebRTC contacts never make a desk phone read connected", () => {
    const rows = [c({ endpoint: "T21_101_1", origIp: "192.168.6.170", isWebrtcDevice: true })];
    assert.deepEqual(phoneRegistrationTruth({ ip: "192.168.6.170", extNumber: "101" }, rows), { kind: "unknown" });
  });

  it("same ip re-registered later wins over its own stale UNREGISTERED row on another endpoint", () => {
    const rows = [
      c({ endpoint: "T21_102", extNumber: "102", origIp: "192.168.6.170", status: "UNREGISTERED", lastEventAt: new Date("2026-09-17T11:00:00Z") }),
      c({ endpoint: "T21_101", extNumber: "101", origIp: "192.168.6.170", status: "REGISTERED", lastEventAt: new Date("2026-09-17T12:00:00Z") }),
    ];
    const t = phoneRegistrationTruth({ ip: "192.168.6.170", extNumber: "102" }, rows);
    assert.deepEqual(t, { kind: "device", connected: true, registeredAsExt: "101" });
  });
});
