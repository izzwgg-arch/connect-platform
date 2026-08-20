/**
 * Loopcom Meetings — helper tests plus the wiring guards that keep the feature
 * reachable: the public path registered with sessionExpiry (or the /meet page
 * would bounce guests to /login), and the sidebar entry present in navConfig.
 * Source guards read the CALL SITES because that is where this repo's defects
 * live; reads are CRLF-normalised (Windows checkout rule).
 */
import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MEET_WS_PATH,
  decodeMeetData,
  encodeMeetData,
  joinErrorText,
  meetingLink,
  meetingWsUrl,
  orderRaisedHands,
} from "./meetings";
import { PUBLIC_PATH_PREFIXES, isPublicPortalPath } from "./sessionExpiry";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

test("meetingWsUrl follows the origin the person is on — never a hardcoded host", () => {
  assert.equal(meetingWsUrl({ protocol: "https:", host: "app.loopcom.net" }), `wss://app.loopcom.net${MEET_WS_PATH}`);
  assert.equal(
    meetingWsUrl({ protocol: "https:", host: "app.connectcomunications.com" }),
    `wss://app.connectcomunications.com${MEET_WS_PATH}`,
  );
  assert.equal(meetingWsUrl({ protocol: "http:", host: "localhost:3000" }), `ws://localhost:3000${MEET_WS_PATH}`);
});

test("meetingLink derives from origin", () => {
  assert.equal(
    meetingLink("abc-defg-hij", { protocol: "https:", host: "app.loopcom.net", origin: "https://app.loopcom.net" }),
    "https://app.loopcom.net/meet/abc-defg-hij",
  );
  assert.equal(
    meetingLink("abc-defg-hij", { protocol: "https:", host: "x.example" }),
    "https://x.example/meet/abc-defg-hij",
  );
});

test("data protocol round-trips; malformed payloads are dropped, never thrown", () => {
  const chat = decodeMeetData(encodeMeetData({ t: "chat", text: "hello", name: "Rivky", ts: 5 }));
  assert.deepEqual(chat, { t: "chat", text: "hello", name: "Rivky", ts: 5 });
  const hand = decodeMeetData(encodeMeetData({ t: "hand", up: true, name: "Yossi", ts: 9 }));
  assert.deepEqual(hand, { t: "hand", up: true, name: "Yossi", ts: 9 });

  assert.equal(decodeMeetData(new TextEncoder().encode("not json")), null);
  assert.equal(decodeMeetData(new TextEncoder().encode('{"t":"chat"}')), null);
  assert.equal(decodeMeetData(new TextEncoder().encode('{"t":"evil","x":1}')), null);
  assert.equal(decodeMeetData(new TextEncoder().encode('{"t":"chat","text":"   ","name":"x"}')), null, "blank chat dropped");
  // A 100k-char message is bounded, not relayed whole.
  const huge = decodeMeetData(new TextEncoder().encode(JSON.stringify({ t: "chat", text: "x".repeat(100000), name: "n" })));
  assert.equal((huge as any).text.length, 2000);
});

test("raised hands order by time — first up answers first", () => {
  const hands = new Map<string, { name: string; ts: number }>([
    ["b", { name: "Second", ts: 20 }],
    ["a", { name: "First", ts: 10 }],
    ["c", { name: "Third", ts: 30 }],
  ]);
  assert.deepEqual(orderRaisedHands(hands).map((h) => h.name), ["First", "Second", "Third"]);
});

test("joinErrorText: every server refusal has plain-English text", () => {
  for (const code of ["meeting_ended", "meeting_locked", "meeting_not_found", "meetings_not_configured", "name_required", "anything_else", null]) {
    const text = joinErrorText(code as any);
    assert.ok(text.length > 10 && !/_/.test(text), `no raw slug shown for ${code}`);
  }
});

// ── Wiring guards ───────────────────────────────────────────────────────────

test("/meet/* is a PUBLIC portal path — guests must never bounce to /login", () => {
  assert.ok(PUBLIC_PATH_PREFIXES.some((p) => p === "/meet/" || p === "/meet"), "sessionExpiry must list /meet/");
  assert.equal(isPublicPortalPath("/meet/abc-defg-hij"), true);
  assert.equal(isPublicPortalPath("/meetings"), false, "the Meetings screen stays authenticated");
});

test("navConfig carries the Meetings sidebar entry", () => {
  const src = read(path.join(__dirname, "..", "navigation", "navConfig.ts"));
  assert.ok(src.includes('id: "workspace.meetings"'), "sidebar item missing");
  assert.ok(src.includes('href: "/meetings"'), "sidebar item must point at /meetings");
});

test("the /meet page joins over the same origin (no hardcoded API host)", () => {
  const src = read(path.join(__dirname, "..", "app", "meet", "[code]", "page.tsx"));
  assert.ok(src.includes("resolveSameOriginApiBase"), "public page must use the same-origin API base");
  assert.ok(!/app\.connectcomunications\.com|app\.loopcom\.net/.test(src), "no hostname literals");
});
