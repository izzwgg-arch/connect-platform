/**
 * Loopcom parallel-run parity guards for the portal (2026-08-19).
 *
 * The portal is served on `app.connectcomunications.com` AND `app.loopcom.net`
 * and must behave identically on both. These read the SOURCE of the call sites
 * (CRLF-normalised) because every defect here was a caller baking one hostname:
 *  - the live-call WebSocket was built from a build-time env that named the old
 *    host, with no same-origin fallback — a Loopcom user rode the old domain;
 *  - the desktop-installer nav link and the Android download page were absolute
 *    URLs on the old host;
 *  - the sign-up pages hard-coded the support address twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveTelephonyWsUrl } from "../hooks/useTelephonySocket";
import { SUPPORT_EMAIL } from "./platformIdentity";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

test("telephony WS: same-origin on every platform host, whatever the build baked", () => {
  const loopcom = { protocol: "https:", host: "app.loopcom.net", hostname: "app.loopcom.net" };
  const legacy = { protocol: "https:", host: "app.connectcomunications.com", hostname: "app.connectcomunications.com" };
  const baked = "wss://app.connectcomunications.com/ws/telephony";
  assert.equal(resolveTelephonyWsUrl(baked, loopcom), "wss://app.loopcom.net/ws/telephony", "a Loopcom page must never open its feed to the old host");
  assert.equal(resolveTelephonyWsUrl(baked, legacy), baked, "on the baked host the value is the same either way");
  assert.equal(resolveTelephonyWsUrl("", loopcom), "wss://app.loopcom.net/ws/telephony");
  assert.equal(resolveTelephonyWsUrl(undefined, legacy), "wss://app.connectcomunications.com/ws/telephony");
});

test("telephony WS: local dev keeps its explicit :3003 target; SSR returns the env untouched", () => {
  const local = { protocol: "http:", host: "localhost:3000", hostname: "localhost" };
  assert.equal(resolveTelephonyWsUrl("ws://localhost:3003/ws/telephony", local), "ws://localhost:3003/ws/telephony");
  assert.equal(resolveTelephonyWsUrl("", local), "ws://localhost:3000/ws/telephony");
  assert.equal(resolveTelephonyWsUrl("wss://x.example/ws/telephony", null), "wss://x.example/ws/telephony");
});

test("telephony WS: the hook uses the resolver, and the compose file no longer bakes the old host", () => {
  const hook = stripComments(read("hooks/useTelephonySocket.ts"));
  assert.match(hook, /return resolveTelephonyWsUrl\(base, window\.location\);/);
  const compose = read("../../docker-compose.app.yml");
  assert.doesNotMatch(compose, /NEXT_PUBLIC_TELEPHONY_WS_URL:-wss:\/\/app\.connectcomunications\.com/);
});

test("download links are same-origin (relative), so both hosts serve them", () => {
  const nav = stripComments(read("navigation/navConfig.ts"));
  assert.match(nav, /href: "\/desktop\/Connect-Setup-latest\.exe"/);
  assert.doesNotMatch(nav, /https:\/\/app\.connectcomunications\.com\/desktop/);
  const card = stripComments(read("components/AppDownloadCard.tsx"));
  assert.doesNotMatch(card, /https:\/\/app\.connectcomunications\.com/);
  assert.match(card, /return "\/api\/mobile\/android\/download";/);
});

test("the sign-up pages take the support address from platformIdentity, not a literal", () => {
  assert.equal(SUPPORT_EMAIL, "support@connectcomunications.com", "default until the Loopcom mailbox flip (NEXT_PUBLIC_SUPPORT_EMAIL)");
  for (const f of ["app/onboarding/[token]/page.tsx", "app/onboarding/[token]/success/page.tsx"]) {
    const src = stripComments(read(f));
    assert.doesNotMatch(src, /mailto:support@connectcomunications\.com/, f);
    assert.match(src, /SUPPORT_EMAIL/, f);
  }
});
