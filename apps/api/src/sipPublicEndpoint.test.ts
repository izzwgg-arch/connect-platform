import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  LEGACY_SIP_WS_URL,
  sipPublicPath,
  sipPublicProbeUrl,
  sipPublicWsUrl,
} from "./sipPublicEndpoint";

beforeEach(() => {
  delete process.env.SIP_PUBLIC_WS_URL;
});

test("default is the CURRENT production hostname — deploying this must be a no-op", () => {
  assert.equal(sipPublicWsUrl(), "wss://app.connectcomunications.com/sip");
  assert.equal(sipPublicWsUrl(), LEGACY_SIP_WS_URL);
});

test("the flip is a single env var", () => {
  process.env.SIP_PUBLIC_WS_URL = "wss://sip.connectcomunications.com/sip";
  assert.equal(sipPublicWsUrl(), "wss://sip.connectcomunications.com/sip");
});

test("blank or whitespace env falls back rather than yielding an empty URL", () => {
  process.env.SIP_PUBLIC_WS_URL = "   ";
  assert.equal(sipPublicWsUrl(), LEGACY_SIP_WS_URL);
});

test("the probe URL always targets the SAME host clients register against", () => {
  process.env.SIP_PUBLIC_WS_URL = "wss://sip.connectcomunications.com/sip";
  assert.equal(sipPublicProbeUrl(), "https://sip.connectcomunications.com/sip");
  // The point of deriving it: probe host and client host can never disagree.
  assert.equal(
    new URL(sipPublicProbeUrl()).host,
    new URL(sipPublicWsUrl().replace("wss://", "https://")).host,
  );
});

test("path is derived, not assumed", () => {
  assert.equal(sipPublicPath(), "/sip");
  process.env.SIP_PUBLIC_WS_URL = "wss://sip.connectcomunications.com/ws-sip";
  assert.equal(sipPublicPath(), "/ws-sip");
});

test("a malformed env value degrades to /sip instead of throwing", () => {
  process.env.SIP_PUBLIC_WS_URL = "not-a-url";
  assert.equal(sipPublicPath(), "/sip");
});

// ---------------------------------------------------------------------------
// The guard that matters: a CALLER regressing, not this module.
// The bug this prevents is one of the three sites keeping a hardcoded hostname —
// a unit test of the helper alone passes straight through that.
// ---------------------------------------------------------------------------

test("server.ts holds NO hardcoded SIP endpoint — all three call sites use the helper", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.ts"), "utf8");
  assert.ok(
    !src.includes("app.connectcomunications.com/sip"),
    "a hardcoded SIP URL is back in server.ts — it must come from sipPublicEndpoint.ts",
  );
  for (const fn of ["sipPublicWsUrl()", "sipPublicProbeUrl()", "sipPublicPath()"]) {
    assert.ok(src.includes(fn), `server.ts no longer calls ${fn}`);
  }
});

// ---------------------------------------------------------------------------
// 2026-08-17 — the global is now the NEW-TENANT hostname, not the platform one.
// Existing tenants were pinned to `wss://sip.connectcomunications.com/sip` first,
// so that flipping this variable reaches nobody who already exists. The precedence
// that makes that work lives in resolveWebrtcConfig; assert it here too, because
// this module's whole meaning depends on it.
// ---------------------------------------------------------------------------

test("an explicit tenant sipWsUrl beats this global — the pin depends on it", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.ts"), "utf8");
  assert.ok(
    src.includes("explicitSipWsUrl || fallbackSipWsUrl"),
    "resolveWebrtcConfig must prefer tenant.sipWsUrl over sipPublicWsUrl(); without that " +
      "precedence, pinning a tenant does not protect it and flipping this global moves " +
      "existing customers — the exact outcome the owner ruled out",
  );
});

test("the module documents pin-before-flip, because reversing the order is the outage", () => {
  const doc = fs.readFileSync(path.join(__dirname, "sipPublicEndpoint.ts"), "utf8");
  assert.ok(
    /pin first, flip\s+\*?\s*second/i.test(doc.replace(/\n/g, " ")),
    "the ordering rule must stay written down next to the value it protects",
  );
});

test("the readiness probe does not fetch a literal host", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.ts"), "utf8");
  assert.ok(
    src.includes("await fetch(sipPublicProbeUrl()"),
    "the SBC readiness probe must follow the configured endpoint, or it reports health " +
      "about a hostname nobody registers against",
  );
});
