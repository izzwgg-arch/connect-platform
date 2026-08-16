import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatMac,
  looksLikeDeskPhone,
  normalizeIpv4,
  normalizeMac,
  sameMac,
  vendorForMac,
} from "./lanPhoneVendors";

/**
 * The real MAC from the Gesheft T53W in AGENT_HANDOFF_DESK_PHONE_REPROVISION.
 * Using the actual handset from the incident keeps these tests anchored to the
 * problem they exist to solve rather than to invented data.
 */
const GESHEFT_T53W = "80:5e:0c:4d:7e:6b";
const GESHEFT_NORMALIZED = "805e0c4d7e6b";

test("every spelling of the same MAC normalises to one value", () => {
  // These are the four formats this platform actually produces: the panel's
  // bare hex, Windows ARP, the phone's own web page, and the nginx user agent.
  const spellings = [
    "805e0c4d7e6b",
    "80-5e-0c-4d-7e-6b",
    "80:5E:0C:4D:7E:6B",
    "80:5e:0c:4d:7e:6b",
    "805E0C4D7E6B",
    "  80:5e:0c:4d:7e:6b  ",
  ];
  for (const s of spellings) {
    assert.equal(normalizeMac(s), GESHEFT_NORMALIZED, `${s} did not normalise`);
  }
});

test("⛔ two spellings of one handset compare equal — the check provisioning never had", () => {
  assert.equal(sameMac("805e0c4d7e6b", "80:5E:0C:4D:7E:6B"), true);
  assert.equal(sameMac("80-5e-0c-4d-7e-6b", "80:5e:0c:4d:7e:6b"), true);
});

test("⛔ a one-character difference is NOT the same phone", () => {
  // This is the Create A Box failure: a MAC that is nearly right rewrites a
  // file nothing downloads. It must never compare equal.
  assert.equal(sameMac(GESHEFT_T53W, "80:5e:0c:4d:7e:6c"), false);
  assert.equal(sameMac(GESHEFT_T53W, "80:5e:0c:4d:7e:b6"), false);
});

test("a missing MAC never equals anything, including another missing MAC", () => {
  // Two unknowns are not a match. Returning true here would silently pair up
  // every phone whose MAC we failed to read.
  assert.equal(sameMac(null, null), false);
  assert.equal(sameMac(undefined, "805e0c4d7e6b"), false);
  assert.equal(sameMac("", ""), false);
  assert.equal(sameMac("garbage", "garbage"), false);
});

test("junk is refused rather than stored", () => {
  for (const bad of ["", "   ", "not-a-mac", "805e0c4d7e", "805e0c4d7e6b7f", "zz5e0c4d7e6b", null, undefined]) {
    assert.equal(normalizeMac(bad as any), null, `${String(bad)} should be refused`);
  }
});

test("all-zero and broadcast MACs are refused — they are never a handset", () => {
  assert.equal(normalizeMac("00:00:00:00:00:00"), null);
  assert.equal(normalizeMac("ff:ff:ff:ff:ff:ff"), null);
});

test("the Gesheft handset is identified as a Yealink", () => {
  assert.equal(vendorForMac(GESHEFT_T53W), "Yealink");
  assert.equal(looksLikeDeskPhone(GESHEFT_T53W), true);
});

test("the vendors that actually appear on this platform are recognised", () => {
  assert.equal(vendorForMac("00:04:f2:11:22:33"), "Polycom");
  assert.equal(vendorForMac("00:0b:82:11:22:33"), "Grandstream");
  assert.equal(vendorForMac("00:04:13:11:22:33"), "Snom");
  assert.equal(vendorForMac("00:08:5d:11:22:33"), "Mitel");
  assert.equal(vendorForMac("00:1a:a1:11:22:33"), "Cisco");
});

test("⛔ an unknown vendor is NORMAL, not an error", () => {
  // Every office has laptops, printers and TVs on the same network. Returning
  // null here must never be treated as a failed scan.
  assert.equal(vendorForMac("aa:bb:cc:dd:ee:ff"), null);
  assert.equal(looksLikeDeskPhone("aa:bb:cc:dd:ee:ff"), false);
});

test("vendor lookup is case- and separator-insensitive", () => {
  assert.equal(vendorForMac("805E0C4D7E6B"), "Yealink");
  assert.equal(vendorForMac("80-5e-0c-4d-7e-6b"), "Yealink");
});

test("MACs are formatted back to the colon form humans read", () => {
  assert.equal(formatMac(GESHEFT_NORMALIZED), GESHEFT_T53W);
  assert.equal(formatMac("80-5E-0C-4D-7E-6B"), GESHEFT_T53W);
  assert.equal(formatMac("nonsense"), null);
});

test("IPv4 addresses are validated, not trusted", () => {
  assert.equal(normalizeIpv4("192.168.44.10"), "192.168.44.10");
  assert.equal(normalizeIpv4("  10.0.0.7 "), "10.0.0.7");

  for (const bad of ["", "999.1.1.1", "192.168.1", "192.168.1.1.1", "not-an-ip", "0.0.0.0", "255.255.255.255", null]) {
    assert.equal(normalizeIpv4(bad as any), null, `${String(bad)} should be refused`);
  }
});
