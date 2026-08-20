/**
 * Scope guard for POST /telephony/calls/stale-hangup-for-extension.
 *
 * ⛔ This route HANGS UP LIVE CALLS. It used to pick its victims by extension
 * number, and an extension is shared by the desk phone (`T18_106`) and the
 * portal (`T18_106_1`) — so a portal hangup killed the DESK PHONE's live call
 * ten seconds later (Trust Bookkeepings ext 106, 2026-08-20: all 7 recorded
 * force-hangups were desk channels).
 *
 * The first test below replays that exact incident from the telephony log.
 *
 * Run: npx tsx --test src/routes/staleHangupScope.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideStaleHangupTargets,
  isCallLiveInAsterisk,
  isChannelForEndpoint,
  STALE_HANGUP_MIN_AGE_MS,
  type AsteriskLiveSnapshot,
  type StaleHangupCandidate,
} from "./staleHangupScope.js";

const snapshot = (ids: string[], names: string[]): AsteriskLiveSnapshot => ({
  ids: new Set(ids),
  names: new Set(names),
});

const T0 = Date.parse("2026-08-20T17:34:03.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** The two desk-phone calls the sweep really killed, plus the portal's own. */
function trustBookkeepingsLiveCalls(): StaleHangupCandidate[] {
  return [
    {
      // Desk phone, answered + bridged, outbound to 3477681172.
      id: "1787247066.4595",
      tenantId: "cmnlgrykx000fp9pa90gohk96",
      channels: ["PJSIP/T18_106-0000093b", "PJSIP/0001-0000093c"],
      startedAt: iso(-177_000),
    },
    {
      // Desk phone, answered + bridged, outbound to 3472282898.
      id: "1787247098.4598",
      tenantId: "cmnlgrykx000fp9pa90gohk96",
      channels: ["PJSIP/T18_106-0000093e", "PJSIP/0001-0000093f"],
      startedAt: iso(-145_000),
    },
  ];
}

test("REGRESSION: a portal hangup must not touch the desk phone's live calls", () => {
  const d = decideStaleHangupTargets(
    {
      sipUsername: "T18_106_1", // the portal's own endpoint
      hangupAt: iso(0),
      tenantId: "cmnlgrykx000fp9pa90gohk96",
    },
    trustBookkeepingsLiveCalls(),
  );
  assert.equal(d.evict, true);
  if (d.evict) {
    assert.deepEqual(
      d.targets.map((c) => c.id),
      [],
      "the desk phone's two live calls must survive a portal hangup",
    );
  }
});

test("the portal's OWN orphaned call is still cleaned up", () => {
  // The whole point of the route — it must not become a no-op.
  const calls: StaleHangupCandidate[] = [
    ...trustBookkeepingsLiveCalls(),
    {
      id: "1787247042.4593",
      tenantId: "cmnlgrykx000fp9pa90gohk96",
      channels: ["PJSIP/T18_106_1-00000939", "PJSIP/0001-0000093a"],
      startedAt: iso(-200_000),
    },
  ];
  const d = decideStaleHangupTargets(
    { sipUsername: "T18_106_1", hangupAt: iso(0), tenantId: "cmnlgrykx000fp9pa90gohk96" },
    calls,
  );
  assert.equal(d.evict, true);
  if (d.evict) {
    assert.deepEqual(d.targets.map((c) => c.id), ["1787247042.4593"]);
  }
});

test("FAILS CLOSED — no sipUsername evicts nothing at all", () => {
  for (const missing of [undefined, null, "", "   ", 106, {}]) {
    const d = decideStaleHangupTargets(
      { sipUsername: missing, hangupAt: iso(0) },
      trustBookkeepingsLiveCalls(),
    );
    assert.equal(d.evict, false, `${JSON.stringify(missing)} must evict nothing`);
    if (!d.evict) assert.equal(d.reason, "sip_username_required");
  }
});

test("endpoint match is WHOLE, never a prefix", () => {
  // `T18_106` is a prefix of `T18_106_1`. A prefix match is the bug itself.
  assert.equal(isChannelForEndpoint("PJSIP/T18_106_1-00000939", "T18_106"), false);
  assert.equal(isChannelForEndpoint("PJSIP/T18_106-0000093b", "T18_106_1"), false);
  assert.equal(isChannelForEndpoint("PJSIP/T18_106-0000093b", "T18_106"), true);
  assert.equal(isChannelForEndpoint("PJSIP/T18_106_1-00000939", "T18_106_1"), true);
  // A different extension entirely, and a different tenant.
  assert.equal(isChannelForEndpoint("PJSIP/T18_1061-00000939", "T18_106"), false);
  assert.equal(isChannelForEndpoint("PJSIP/T7_106-00000939", "T18_106"), false);
});

test("a losing ring leg does not make the call ours", () => {
  // An inbound call rings desk + app; the DESK answers, so the app's leg is
  // hung up and pruned from `channels`. The app must not then claim the call.
  const answeredOnDesk: StaleHangupCandidate = {
    id: "1787247233.4615",
    tenantId: "t",
    channels: ["PJSIP/T18_106-00000948", "PJSIP/0001-00000949"],
    startedAt: iso(-60_000),
  };
  const d = decideStaleHangupTargets(
    { sipUsername: "T18_106_1", hangupAt: iso(0), tenantId: "t" },
    [answeredOnDesk],
  );
  assert.equal(d.evict, true);
  if (d.evict) assert.deepEqual(d.targets, []);
});

test("a call dialled during the 10s wait is never swept", () => {
  const justStarted: StaleHangupCandidate = {
    id: "new",
    tenantId: "t",
    channels: ["PJSIP/T18_106_1-000009ff"],
    // Started AFTER the hangup — this is the user's next call.
    startedAt: iso(+4_000),
  };
  const d = decideStaleHangupTargets(
    { sipUsername: "T18_106_1", hangupAt: iso(0), tenantId: "t" },
    [justStarted],
  );
  assert.equal(d.evict, true);
  if (d.evict) assert.deepEqual(d.targets, [], "the user's NEXT call must survive");
});

test("the 2s age floor is applied at its boundary", () => {
  const at = (offset: number): StaleHangupCandidate => ({
    id: `c${offset}`,
    tenantId: "t",
    channels: ["PJSIP/T18_106_1-000009ff"],
    startedAt: iso(offset),
  });
  const run = (offset: number) => {
    const d = decideStaleHangupTargets(
      { sipUsername: "T18_106_1", hangupAt: iso(0), tenantId: "t" },
      [at(offset)],
    );
    return d.evict ? d.targets.length : -1;
  };
  assert.equal(STALE_HANGUP_MIN_AGE_MS, 2_000);
  assert.equal(run(-2_001), 1, "older than the floor → swept");
  assert.equal(run(-1_999), 0, "inside the floor → left alone");
});

test("another tenant's call is never touched", () => {
  const foreign: StaleHangupCandidate = {
    id: "foreign",
    tenantId: "other-tenant",
    channels: ["PJSIP/T18_106_1-00000939"],
    startedAt: iso(-60_000),
  };
  const d = decideStaleHangupTargets(
    { sipUsername: "T18_106_1", hangupAt: iso(0), tenantId: "t" },
    [foreign],
  );
  assert.equal(d.evict, true);
  if (d.evict) assert.deepEqual(d.targets, []);
});

// ── Layer 2: Asterisk liveness ──────────────────────────────────────────────

test("a call Asterisk still has is LIVE — by uniqueid", () => {
  const call = { channels: ["PJSIP/T18_106_1-00000939"] };
  assert.equal(
    isCallLiveInAsterisk(call, ["1787247042.4593"], snapshot(["1787247042.4593"], [])),
    true,
  );
});

test("a call Asterisk still has is LIVE — by channel name, even with no uniqueids", () => {
  // The store's channelIndex can be empty for a call it still tracks; the name
  // must independently save it. Failing to match here ends a real call.
  const call = { channels: ["PJSIP/T18_106-0000093b"] };
  assert.equal(
    isCallLiveInAsterisk(call, [], snapshot([], ["PJSIP/T18_106-0000093b"])),
    true,
  );
});

test("a Local channel's ;1/;2 halves still count as live", () => {
  const call = { channels: ["Local/106@T18_ivr-only-extensions-000003ef"] };
  assert.equal(
    isCallLiveInAsterisk(call, [], snapshot([], ["Local/106@T18_ivr-only-extensions-000003ef;2"])),
    true,
  );
});

test("only a call Asterisk has NO trace of is considered gone", () => {
  const call = { channels: ["PJSIP/T18_106_1-00000939"] };
  assert.equal(
    isCallLiveInAsterisk(call, ["1787247042.4593"], snapshot(["9999.1"], ["PJSIP/T18_101-0000aaaa"])),
    false,
  );
});

test("REGRESSION: the 13 severed calls are all protected by the liveness check", () => {
  // Every one of them was up and bridged in Asterisk at the moment of the sweep.
  for (const c of trustBookkeepingsLiveCalls()) {
    const live = snapshot([], c.channels); // Asterisk still had them
    assert.equal(
      isCallLiveInAsterisk(c, [], live),
      true,
      `${c.channels[0]} must be recognised as a real call`,
    );
  }
});

// ── Source guards ───────────────────────────────────────────────────────────
// The defect was in the CALLER: the route selected by extension number. A unit
// test of the decision function passes straight through that, so assert on the
// route's own source. Comments are stripped first — the doc block deliberately
// quotes the old broken shape, and a naive match would fire on the explanation.

function routeSourceWithoutComments(): string {
  const src = readFileSync(join(__dirname, "telephony.ts"), "utf8").replace(/\r\n/g, "\n");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function staleHangupHandlerSource(): string {
  const src = routeSourceWithoutComments();
  const start = src.indexOf("stale-hangup-for-extension");
  assert.ok(start > 0, "the route must still exist");
  return src.slice(start, start + 3000);
}

test("GUARD: the route delegates scoping to decideStaleHangupTargets", () => {
  const handler = staleHangupHandlerSource();
  assert.ok(
    handler.includes("decideStaleHangupTargets"),
    "the route must scope through the shared decision function",
  );
});

test("GUARD: the route never re-adds an extension-number match", () => {
  const handler = staleHangupHandlerSource();
  // The exact shape of the original bug.
  assert.ok(
    !/c\.from\s*===\s*extension/.test(handler),
    "matching a call by `from === extension` is the desk-phone-killing bug",
  );
  assert.ok(
    !/c\.to\s*===\s*extension/.test(handler),
    "matching a call by `to === extension` is the desk-phone-killing bug",
  );
  assert.ok(
    !/endsWith\(`\/\$\{extension\}`\)/.test(handler),
    "matching a call by extension suffix is the desk-phone-killing bug",
  );
});

test("GUARD: the route CANNOT hang up a call — no AMI hangup on this path", () => {
  // This is the structural guarantee. 13 live conversations were ended by the
  // hangupChannel call that used to live here; the route is store cleanup only.
  const handler = staleHangupHandlerSource();
  assert.ok(
    !/hangupChannel/.test(handler),
    "the stale-hangup path must never call hangupChannel — a call Asterisk no " +
      "longer has cannot be hung up, so the only thing a Hangup can reach is a REAL call",
  );
});

test("GUARD: the route verifies liveness against ARI before evicting", () => {
  const handler = staleHangupHandlerSource();
  assert.ok(/getChannels\(\)/.test(handler), "must fetch ARI's live channel snapshot");
  assert.ok(/isCallLiveInAsterisk/.test(handler), "must consult the liveness check");
});

test("GUARD: an unreachable ARI refuses instead of guessing", () => {
  const handler = staleHangupHandlerSource();
  assert.ok(
    /ari_unavailable/.test(handler),
    "if liveness cannot be verified the route must refuse, never fall through to evicting",
  );
});

test("GUARD: the portal sends sipUsername with the sweep", () => {
  const portal = readFileSync(
    join(__dirname, "..", "..", "..", "portal", "hooks", "useSipPhone.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const at = portal.indexOf("stale-hangup-for-extension");
  assert.ok(at > 0, "the portal must still call the route");
  const call = portal.slice(at, at + 400);
  assert.ok(
    /sipUsername:/.test(call),
    "without sipUsername the server now refuses, so the safeguard would be dead",
  );
});
