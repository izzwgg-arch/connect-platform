import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/* ── The Gesheft ext 101 blank mini dialer (2026-08-17) ─────────────────────

   The mini dialer warms voicemail audio into a module-scope blob cache so Play
   is instant. The cache holds 30 messages. The warm-up was handed EVERY id the
   list returned — and the list endpoint ignored the pageSize=20 the mini dialer
   asked for and returned 100. So 70 messages were downloaded, evicted on
   arrival, found missing by the next 30-second refresh, and downloaded again.
   Forever.

   On Gesheft ext 101 — 15,559 voicemails in the inbox, ~600 KB each — that was
   963 MB of audio in seven minutes from one office, ~250 requests a minute,
   which tripped nginx's auto-ban. The ban is on the IP, so EVERY request from
   that office was refused, the mini dialer's own scripts included: the window
   came up blank and reopening it could not help.

   Two properties keep it dead, and both are asserted here:

     1. The warm-up never starts more downloads than the cache can finish
        holding. Equal counts are not enough — inserting entry number 30 evicts
        entry number 1, so the bound has to be STRICTLY under the cache size or
        one message thrashes on every cycle.

     2. The bound lives inside preloadVoicemailAudio, not at the call site.
        The defect arrived as a caller passing a longer list than it promised;
        a bound that only exists where today's caller happens to sit is one new
        caller away from being gone again.

   This reads the source because that is where the property lives — the cache
   and the warm-up are module-private to a "use client" component, and a test
   that reimplemented them would be asserting its own copy, not the shipped one. */

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "components", "DesktopMiniDialer.tsx"),
  "utf8",
);

function readConst(name: string): number {
  const m = SRC.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
  assert.ok(m, `${name} is gone from DesktopMiniDialer.tsx — the warm-up bound must not be removed`);
  return Number(m![1]);
}

test("the warm-up is bounded at all", () => {
  const bound = readConst("VM_PRELOAD_MAX");
  assert.ok(bound > 0, "a warm-up bound of zero disables instant play entirely");
});

test("the warm-up bound is STRICTLY under the cache size, so nothing it fetches is evicted", () => {
  const bound = readConst("VM_PRELOAD_MAX");
  const cache = readConst("VM_CACHE_MAX_ENTRIES");
  assert.ok(
    bound < cache,
    `VM_PRELOAD_MAX (${bound}) must be strictly less than VM_CACHE_MAX_ENTRIES (${cache}); ` +
      "at or above it, every cycle evicts a message it just downloaded and re-downloads it on the next refresh",
  );
});

test("the bound is applied inside preloadVoicemailAudio, not left to the caller", () => {
  const fn = SRC.match(/function preloadVoicemailAudio\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, "preloadVoicemailAudio is gone or was renamed — re-point this guard before deleting it");
  assert.match(
    fn![0],
    /for\s*\(const id of ids\.slice\(0,\s*VM_PRELOAD_MAX\)\)/,
    "preloadVoicemailAudio must cap the list it was handed; a caller-side cap does not survive a new caller",
  );
});

test("the list request still asks for a small page, so the whole 100 is never shipped", () => {
  assert.match(
    SRC,
    /\/voice\/voicemail\?folder=inbox&page=1&pageSize=20/,
    "the mini dialer must keep asking for a small page — the API now honours pageSize",
  );
});

/* The server half of the same bug: pageSize was absent from the route's schema,
   and zod strips what it does not declare, so a caller asking for 20 got 100
   with no error anywhere. Asserted against the route's source for the same
   reason as above — reaching this handler in isolation would mean standing up
   the whole api. */

const API_SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "api", "src", "server.ts"),
  "utf8",
);

test("GET /voice/voicemail declares pageSize, so asking for fewer rows is not silently ignored", () => {
  const handler = API_SRC.match(
    /app\.get\("\/voice\/voicemail",[\s\S]*?const q = z\.object\(\{[\s\S]*?\}\)\.parse\(req\.query \|\| \{\}\);/,
  );
  assert.ok(handler, "the /voice/voicemail handler moved — re-point this guard");
  assert.match(
    handler![0],
    /pageSize:\s*z\.coerce\.number\(\)/,
    "pageSize must be declared in the query schema or zod drops it and the caller silently gets the default",
  );
  assert.match(
    handler![0],
    /\.default\(100\)/,
    "the default must stay 100 — mobile, the voicemail page and the notification poll page through this endpoint without sending pageSize",
  );
});

test("the page size is taken from the request, not hardcoded", () => {
  assert.doesNotMatch(
    API_SRC,
    /const take = 100;\n  const skip = \(q\.page - 1\) \* take;/,
    "the voicemail list must derive take from q.pageSize; a hardcoded 100 is what made pageSize a lie",
  );
  assert.match(API_SRC, /const take = q\.pageSize;/);
});
