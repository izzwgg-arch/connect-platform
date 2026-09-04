/**
 * Guards on the portal-deploy reload notice (2026-08-20).
 *
 * ⛔ THE DEFECT: the notice "kept showing up again and again" (Izzy). Only the
 * ✕ was recorded in localStorage — clicking **Reload** recorded nothing. So if a
 * reload did not land the new bundle for any reason, the very next 5-minute poll
 * showed the notice again, forever, with the Reload button visibly not working.
 * The acknowledgement is now written BEFORE the reload, so the notice appears at
 * most once per deploy per profile whatever the reload does.
 *
 * ⛔ THE HAZARD: one click now reloads every Connect window (mini dialer, full
 * window, phone engine) over the cross-window `storage` event. A reload tears
 * down the SIP softphone, so a window that is on a call must NEVER auto-reload
 * itself.
 *
 * Source-reading on purpose: this is component wiring and ordering, which a unit
 * test of a helper passes straight through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// CRLF-normalise: Windows checkouts are CRLF and literal-\n matching breaks.
const read = (...p: string[]) =>
  readFileSync(path.join(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n");

const notice = read("components", "DesktopUpdateNotice.tsx");
const mini = read("components", "DesktopMiniDialer.tsx");

/** Strip comments so doc blocks describing the old bug can't satisfy a guard. */
function executable(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
}

const src = executable(notice);

function bodyOf(marker: string, len = 900): string {
  const at = src.indexOf(marker);
  assert.ok(at > 0, `${marker} must exist`);
  return src.slice(at, at + len);
}

test("clicking Reload records the build BEFORE reloading", () => {
  const body = bodyOf("const reloadEverything =");
  const ack = body.indexOf("acknowledgeBuild(newBuildId)");
  const reload = body.indexOf("window.location.reload()");
  assert.ok(ack > 0, "reloadEverything must acknowledge the build");
  assert.ok(reload > 0, "reloadEverything must reload");
  assert.ok(
    ack < reload,
    "the acknowledgement must be written BEFORE the reload — otherwise a reload " +
      "that does not land the new bundle re-shows the notice forever",
  );
});

test("the notice is suppressed for an already-acknowledged build", () => {
  // Checked during render, not only in an effect, so it cannot flash for a frame.
  assert.ok(
    /if \(!newBuildId \|\| dismissed \|\| isBuildAcknowledged\(newBuildId\)\) return null;/.test(src),
    "render must consult isBuildAcknowledged directly",
  );
});

test("a window on a call NEVER auto-reloads itself", () => {
  const body = bodyOf("const onStorage = (e: StorageEvent)");
  assert.ok(
    /if \(busyRef\.current\) return;/.test(body),
    "the broadcast handler must bail out while the phone is busy",
  );
  // And "busy" must mean any non-idle state, not just "connected".
  assert.ok(
    /callState !== "idle" && phone\.callState !== "ended"/.test(src),
    "busy must cover dialing/ringing/connected, not only connected",
  );
});

test("a stray broadcast cannot start a reload loop", () => {
  const body = bodyOf("const onStorage = (e: StorageEvent)");
  assert.ok(
    /if \(!pendingRef\.current\) return;/.test(body),
    "a window already on the new build must ignore the broadcast",
  );
  assert.ok(
    /BROADCAST_FRESH_MS/.test(body),
    "a stale broadcast key from a past session must be ignored",
  );
});

test("the mini dialer gets the thin strip, and only the thin strip", () => {
  assert.ok(
    /import \{ MiniDialerReloadBar \} from "\.\/DesktopUpdateNotice";/.test(mini),
    "the mini dialer must import the strip",
  );
  assert.ok(/<MiniDialerReloadBar \/>/.test(executable(mini)), "…and render it");
  // The floating card must stand down there, or the pop-out shows both.
  const portal = bodyOf("export function PortalReloadNotice()");
  assert.ok(
    /if \(!update \|\| isMini\) return null;/.test(portal),
    "PortalReloadNotice must render nothing in the mini dialer",
  );
});

test("the strip is an in-layout flex child, never a fixed overlay", () => {
  // A fixed bar would sit on top of the dialpad and the call buttons.
  const bar = bodyOf("export function MiniDialerReloadBar()", 1400);
  assert.ok(/flexShrink: 0/.test(bar), "must be a flex child that reserves space");
  assert.ok(
    !/position: "fixed"/.test(bar),
    "must NOT be position:fixed — it would cover the dialer's own controls",
  );
});

test("the strip is thin", () => {
  const bar = bodyOf("export function MiniDialerReloadBar()", 1400);
  const h = Number(/height: (\d+)/.exec(bar)?.[1] ?? "999");
  assert.ok(h > 0 && h <= 32, `the strip must stay thin, got ${h}px`);
});

// ── 2026-09-04: the ✕ is a snooze, and an idle window reloads itself ────────
test("⛔ the ✕ SNOOZES the notice — only a Reload click acknowledges a build for good", () => {
  // Only the dismiss body — reloadEverything right below it DOES acknowledge, by design.
  const body = bodyOf("const dismiss = () => {", 400).split("const reloadEverything")[0]!;
  assert.ok(/snoozeBuild\(newBuildId\)/.test(body), "dismiss must snooze");
  assert.ok(!/acknowledgeBuild\(newBuildId\)/.test(body), "dismiss must NOT acknowledge the build forever (one ✕ used to silence a deploy for that window for good)");
  assert.ok(/const SNOOZE_MS = 60 \* 60 \* 1000;/.test(src), "the snooze is one hour");
  assert.ok(/setTimeout\(\(\) => setDismissed\(isBuildAcknowledged\(newBuildId\)\), remaining \+ 1000\)/.test(src), "the strip must re-arm by itself when the snooze runs out");
});

test("⛔ an idle window reloads ITSELF — but never on a call, never while in use", () => {
  const body = bodyOf("const lastInputRef = useRef(Date.now());", 1200);
  assert.ok(/if \(busyRef\.current\) return;/.test(body), "the idle reload must bail out while the phone is busy");
  assert.ok(/IDLE_RELOAD_MS/.test(body), "the idle reload must wait for the idle window");
  const ack = body.indexOf("acknowledgeBuild(pendingRef.current)");
  const reload = body.indexOf("window.location.reload()");
  assert.ok(ack > 0 && reload > ack, "the idle reload must acknowledge the build BEFORE reloading");
  assert.ok(/const IDLE_RELOAD_MS = 20 \* 60 \* 1000;/.test(src), "idle means 20 minutes without input");
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) assert.ok(body.includes(`"${ev}"`), `${ev} must count as input`);
});

test("both surfaces share one update source", () => {
  // Two independent pollers would double the /version traffic and could disagree.
  assert.ok(/export function usePortalUpdate\(\)/.test(src), "one shared hook");
  for (const consumer of ["export function MiniDialerReloadBar()", "export function PortalReloadNotice()"]) {
    assert.ok(
      /usePortalUpdate\(\)/.test(bodyOf(consumer, 300)),
      `${consumer} must use the shared hook`,
    );
  }
});
