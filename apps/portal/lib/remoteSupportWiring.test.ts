/**
 * Guards for the three things that were BUILT AND WIRED TO NOTHING (2026-08-31).
 *
 * ⛔ WHY THESE READ SOURCE RATHER THAN BEHAVIOUR. Every one of these defects was
 * a CALLER-side omission: the policy was correct, the route was correct, the
 * service function existed — and no screen ever called it. A unit test of any of
 * those pieces passes straight through all three. The only test that can see a
 * missing call site is one that looks for the call site.
 *
 * The three:
 *
 *  1. `callInProgress` was never sent by anybody, so non-negotiable rule 15
 *     (remote support yields to an active phone call) was enforced on the server
 *     against an input that never arrived. The rule was real and unreachable.
 *
 *  2. `packetLoss` / `roundTripMs` were never sent, so `decideMediaBudget`'s
 *     constrained branch could not be chosen — the adaptive path was dead.
 *
 *  3. `answerCapability` existed on the server and in the service layer and was
 *     called by NO screen, so a technician's mid-session request reached a
 *     customer who was never shown it. The rail waited forever.
 *
 * ⛔ CRLF is normalised on every read. Izzy's global `core.autocrlf=true` checks
 * these files out with CRLF, so a multi-line pattern silently matches nothing and
 * the guard passes for the wrong reason.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PORTAL_ROOT = join(__dirname, "..");

function read(...parts: string[]): string {
  return readFileSync(join(PORTAL_ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Executable lines only.
 *
 * ⛔ These files DOCUMENT the bugs they fix, quoting the very identifiers the
 * assertions look for. Without this, every guard below would pass on its own
 * explanatory comment — the trap this repo has now hit six times.
 */
function code(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*"));
    })
    .join("\n");
}

const service = () => code(read("services", "remoteSupport.ts"));
const consent = () => code(read("components", "RemoteSupportConsent.tsx"));
const panel = () => code(read("app", "(platform)", "admin", "remote-support", "page.tsx"));
const css = () => read("app", "globals.css");

/* ── rule 15: the call-yield input actually gets supplied ─────────────── */

test("the peer can be told a call is up, and asks on every heartbeat", () => {
  const src = service();
  assert.match(src, /onCall\s*:\s*\(\(\)\s*=>\s*boolean\)\s*\|\s*null/, "the peer must expose a call-state supplier");
  assert.match(src, /callInProgress:\s*onCall/, "the heartbeat must carry the answer it was given");
});

test("the CUSTOMER side supplies the call state — nobody else can", () => {
  const src = consent();
  // Only the customer's own machine knows a call is up. If this call site goes,
  // rule 15 goes back to being enforced against nothing.
  assert.match(src, /peer\.onCall\s*=/, "the customer's peer must be given the supplier");
  assert.match(src, /useOptionalSipPhone\(\)/, "the call state must come from the phone hook");
  // ⛔ useOptionalSipPhone, never useSipPhone: this component is mounted
  // globally, including outside the SIP provider, and chrome must never crash
  // the whole app over a missing provider.
  assert.doesNotMatch(src, /\buseSipPhone\(\)/, "must not use the throwing hook");
});

test("a call that starts mid-session is seen — the supplier reads a ref", () => {
  const src = consent();
  // The closure is built once, when the session starts. Reading a state value
  // there would freeze the answer at whatever it was in that instant, and the
  // interesting case is precisely a call that begins later.
  assert.match(src, /onCallRef\.current/, "must read through a ref, not a captured value");
});

/* ── the adaptive budget has real numbers to work with ────────────────── */

test("the peer measures the link and sends it", () => {
  const src = service();
  assert.match(src, /getStats\(\)/, "quality must come from the peer connection's own stats");
  assert.match(src, /packetLoss:\s*quality\.packetLoss/, "loss must reach the heartbeat");
  assert.match(src, /roundTripMs:\s*quality\.roundTripMs/, "round trip must reach the heartbeat");
});

test("loss is a delta between beats, never a lifetime ratio", () => {
  const src = service();
  // A lifetime figure is dominated by the connection's first seconds and would
  // keep reporting a bad link long after it recovered, clamping the encoder for
  // the rest of the session.
  assert.match(src, /lastPacketsLost/, "must remember the previous sample");
  assert.match(src, /lastPacketsReceived/, "must remember the previous sample");
});

test("a tiny sample is not a verdict", () => {
  const src = service();
  // One lost packet out of three is not 33% loss; it is noise, and acting on it
  // would clamp a healthy connection.
  assert.match(src, /total\s*>=\s*30/, "must require a meaningful sample before reporting loss");
});

test("only the customer applies the budget — the support side has no encoder", () => {
  const src = service();
  assert.match(
    src,
    /if\s*\(this\.role\s*!==\s*"customer"[^)]*\)\s*return;/,
    "applyBudget must no-op on the support side rather than pretend",
  );
});

test("a failed stats read never breaks the heartbeat", () => {
  const src = service();
  // The heartbeat is the liveness signal. A fault in the optional telemetry
  // beside it must not make a live session look disconnected.
  const beat = src.slice(src.indexOf("private async beat("));
  assert.ok(beat.length > 0, "the beat method must exist");
  assert.match(beat.slice(0, 900), /catch\s*\{/, "the quality read must be caught");
});

/* ── the mid-session ask reaches a human who can answer it ────────────── */

test("the customer side actually answers capability requests", () => {
  const src = consent();
  // Without this the server records the ask, the customer is never shown it,
  // and the technician's rail waits forever on a question nobody received.
  assert.match(src, /answerCapability\(/, "the customer must be able to answer");
  assert.match(src, /setCapAsk\(/, "the outstanding ask must reach the screen");
});

test("the ask is DERIVED from requested-minus-granted, not pushed", () => {
  const src = consent();
  // Derived means a refresh, a reconnect or a second window all reach the same
  // answer, and a dropped message cannot lose the question.
  assert.match(src, /capabilitiesRequested/, "must read what was asked for");
  assert.match(src, /capabilitiesGranted/, "must subtract what is already allowed");
});

test("view and control are not re-asked mid-session", () => {
  const src = consent();
  // Both were settled by the consent dialog. Re-asking here would be a second,
  // weaker prompt for a decision that was already made properly.
  assert.match(src, /c\s*!==\s*"view"\s*&&\s*c\s*!==\s*"control"/, "must exclude the two consent-dialog decisions");
});

test("the technician's rail draws tools from GRANTED, never from requested", () => {
  const src = panel();
  // ⛔ The whole point of keeping the two lists apart. A rail that lit up on
  // request would show a tool as available because somebody asked for it.
  assert.match(src, /granted\.includes\(cap\)/, "availability must be decided by what was granted");
  assert.doesNotMatch(
    src,
    /capabilitiesRequested\s*\?\?\s*\[\]\)\s*as\s*RemoteCapability\[\]/,
    "the rail must not read the requested list as permission",
  );
});

test("asking reflects the server's answer, not an optimistic one", () => {
  const src = panel();
  assert.match(src, /setGranted\(res\.granted/, "must take the server's list after asking");
});

/* ── the elevated-windows limit is stated, not hidden ─────────────────── */

test("what administrator access still cannot do is stated on the rail, not hidden", () => {
  const src = panel();
  // Administrator access is real now (2026-09-02, an elevated helper behind the
  // customer's own UAC "Yes"), but the UAC prompt itself and the lock screen
  // run on Windows' secure desktop, which only SYSTEM may drive. A technician
  // who was not told would watch their clicks do nothing on that prompt and
  // conclude the product is broken. Saying so is the honest option.
  assert.ok(/Windows prompts \(UAC\) still need them/.test(src), "the remaining limit must be stated in words on the rail");
});

test("the connection readout has a third state and never guesses good", () => {
  const src = panel();
  // Stats need two samples before loss means anything, so the first seconds of
  // every session legitimately know nothing. A green light that means "we have
  // not looked yet" is the reading a technician would trust while a customer
  // struggles.
  assert.match(src, /"unknown"/, "must distinguish not-yet-measured");
  assert.match(src, /Measuring…/, "and must say so rather than claiming a verdict");
});

/* ── the people list asks a route that EXISTS (2026-09-02) ───────────── */

test("the technician's people list is fed by the remote-support people route, not a route that does not exist", () => {
  const src = panel();
  // "/team/members" never existed in the API. The page asked for it, swallowed
  // the 404 into an empty list, and "Choose a person…" showed nobody, always.
  assert.doesNotMatch(src, /["'`]\/team\/members["'`]/, "the page must not ask /team/members — that route does not exist");
  assert.match(src, /apiGet<[^>]*>\("\/remote-support\/people"\)/, "the page must load people from /remote-support/people");
  assert.match(src, /setPeople\(r\.people/, "the list must be read from the route's `people` key");
});

/* ── what the first live session taught (2026-09-02) ─────────────────── */

test("the viewer's pointer is a normal arrow, never a crosshair", () => {
  const rule = css().split("\n").find((l) => l.startsWith(".rs-video.is-controllable"));
  assert.ok(rule, "the controllable-video rule must exist");
  assert.doesNotMatch(rule!, /crosshair/, "a crosshair beside the customer's own late cursor reads as a broken mouse");
});

test("the viewer can go full screen, on the stage rather than the <video>", () => {
  const src = panel();
  assert.match(src, /requestFullscreen\(\)/, "there must be a full-screen action");
  assert.match(src, /ref=\{stageRef\}/, "full screen must target the stage so the footer and keyboard stay");
  assert.match(src, /Exit full screen/, "there must be a way back that says so");
});

test("a paused picture is SAID, not shown as a frozen frame beside a green light", () => {
  const src = panel();
  assert.match(src, /addEventListener\("mute"/, "the remote track's mute event is the only signal that frames stopped");
  assert.match(src, /addEventListener\("unmute"/, "and it must clear itself when frames resume");
  assert.match(src, /picture has paused/i, "the technician is told in words");
});

test("the customer's picker puts whole screens first and warns about sharing one window", () => {
  const src = consent();
  assert.match(src, /Number\(b\.isScreen\) - Number\(a\.isScreen\)/, "whole screens must sort first");
  assert.match(src, /minimised/, "the window caveat must be stated where the choice is made");
});

/* ── administrator access (2026-09-02) ───────────────────────────────── */

test("administrator access is askable, and the grant is recorded only AFTER the Windows prompt was accepted", () => {
  const src = consent();
  assert.match(src, /id:\s*"admin"/, "the consent dialog must carry the admin row");
  assert.doesNotMatch(src, /Loopcom never runs as administrator/, "the old unavailable row must be gone");
  // The elevation call must precede answerCapability in the mid-session handler:
  // a declined UAC prompt must never reach the server as a grant.
  const handler = src.slice(src.indexOf("const answerCap = useCallback"), src.indexOf("await answerCapability(live.id, capability, allow)"));
  assert.match(handler, /enableElevatedControl/, "the elevated helper is started before the grant is sent");
  assert.match(handler, /allow = false/, "a declined prompt turns the answer into a refusal");
});

test("the technician's rail offers administrator access and says what it still cannot do", () => {
  const src = panel();
  assert.match(src, /"clipboard", "files", "admin"/, "admin must be an askable tool");
  assert.doesNotMatch(src, /Not available in this version/, "the unavailable row must be gone");
  assert.match(src, /UAC/, "the limit (the UAC prompt itself) must be stated to the technician");
});

