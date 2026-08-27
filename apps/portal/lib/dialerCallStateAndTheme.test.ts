/**
 * Guards for the 2026-08-27 dialer fixes (Izzy's five-issue report):
 *
 *  1. TIMER — a secondary session ending/failing (a declined or abandoned
 *     WAITING call, or a held call's far end hanging up) used to run the full
 *     top-level reset in useSipPhone's ended/failed handlers, stomping the
 *     live call's callState/callStartedAt/sessionRef — the mini's call timer
 *     froze at 0:00 and the call screen dropped. Survivor guards now skip the
 *     reset while another connected/held session remains, and the side-session
 *     handlers tear the top-level state down when the LAST call ends there.
 *  2. DTMF — keypad tones play on the CALL output device from settings, not
 *     whatever sink the shared tone AudioContext last had.
 *  3/4. FloatingDialer settings popover — portaled via ViewportDropdown
 *     (inline it was clipped by .fd-card's overflow:hidden) and themed for
 *     light mode. ViewportDropdown itself ignores presses inside NESTED
 *     portaled panels so the ConnectSelects inside still work.
 *  5. Mini dialer THEME — defaults to LIGHT (the portal's own default), reads
 *     the user's real choice from localStorage cc-theme, and arbitrates the
 *     shell's stale did-finish-load push against it.
 *
 * All source guards (the defects live in callers/handlers, unreachable by unit
 * tests of the helpers). Reads CRLF-normalised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel: string) =>
  readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

test("useSipPhone: a surviving call blocks the ended/failed top-level reset", () => {
  const src = read("hooks/useSipPhone.ts");
  for (const name of ["survivorsOnEnd", "survivorsOnFail"]) {
    const guardAt = src.indexOf(`const ${name} = Array.from(sessionMetaRef.current.values())`);
    assert.ok(guardAt >= 0, `${name} survivor computation must exist`);
    const branch = src.indexOf(`if (${name}.length > 0) {`);
    assert.ok(branch > guardAt, `${name} must gate an early-return takeover branch`);
    // The takeover branch must NOT null callStartedAt — that is the frozen timer.
    const branchEnd = src.indexOf("return;", branch);
    const branchBody = src.slice(branch, branchEnd);
    assert.ok(
      !branchBody.includes("setCallStartedAt(null)"),
      `${name} takeover branch must keep callStartedAt (nulling it is the frozen-timer bug)`,
    );
    assert.ok(
      branchBody.includes('setCallState("connected")'),
      `${name} takeover branch must keep the call screen up`,
    );
  }
  // Survivors are computed BEFORE removeSessionMeta mutates the map.
  const endGuard = src.indexOf("const survivorsOnEnd");
  const endRemove = src.indexOf("removeSessionMeta(mcId);", endGuard);
  assert.ok(endGuard < endRemove, "survivorsOnEnd must be computed before removeSessionMeta");
});

test("useSipPhone: side-session handlers close the loop when the LAST call ends there", () => {
  const src = read("hooks/useSipPhone.ts");
  assert.ok(
    src.includes("function maybeTeardownTopLevelAfterSideEnd()"),
    "the side-session teardown helper must exist",
  );
  const bindAt = src.indexOf("function bindSideSession");
  const bindEnd = src.indexOf("\n  }", src.indexOf('session.on("failed"', bindAt));
  const bindBody = src.slice(bindAt, bindEnd);
  const calls = bindBody.split("maybeTeardownTopLevelAfterSideEnd()").length - 1;
  assert.ok(
    calls >= 2,
    "both side-session end paths (ended AND failed) must call the teardown helper — " +
      "without it the dialer stays stuck on-a-call after a survivor takeover",
  );
});

test("DTMF keypad tones route to the call output device", () => {
  const audio = read("hooks/useTelephonyAudio.ts");
  assert.ok(
    audio.includes("const playDtmfTone = useCallback((digit: string, outputDeviceId?: string)"),
    "useTelephonyAudio.playDtmfTone must take the output device",
  );
  assert.ok(
    audio.includes('.setSinkId(outputDeviceId ?? "")'),
    'the DTMF sink must ALWAYS be applied ("" = OS default) — the shared ctx may still be on the ringer device',
  );
  const phone = read("hooks/useSipPhone.ts");
  assert.ok(
    phone.includes("playDtmfToneRaw(digit, currentSinkIdRef.current)"),
    "useSipPhone must wrap playDtmfTone with the current call sink",
  );
});

test("ViewportDropdown ignores presses inside nested portaled panels", () => {
  const src = read("components/ViewportDropdown.tsx");
  const handler = src.slice(src.indexOf("function handlePointerDown"), src.indexOf("function handleKeyDown"));
  const guardAt = handler.indexOf("if (isInsideViewportDropdown(target)) return;");
  const closeAt = handler.indexOf("onClose();");
  assert.ok(guardAt >= 0, "handlePointerDown must early-return on nested portaled panels");
  assert.ok(guardAt < closeAt, "the nested-panel check must run before onClose()");
});

test("FloatingDialer settings popover is portaled and light-mode themed", () => {
  const src = read("components/FloatingDialer.tsx");
  // Portal: the popover must ride ViewportDropdown, never an inline div —
  // inline it sits inside .fd-card (overflow:hidden + backdrop-filter) and is
  // clipped; position:fixed cannot escape a filtered/transformed ancestor.
  assert.ok(
    /<ViewportDropdown[\s\S]{0,400}className="fd-settings-popover"/.test(src),
    "the settings popover must render through ViewportDropdown",
  );
  assert.ok(
    !src.includes('{open && (\n        <div className="fd-settings-popover">'),
    "the inline (clipped) settings popover must not return",
  );
  assert.ok(
    !/\.fd-settings-popover \{[^}]*position: absolute/.test(src),
    "the popover CSS must not re-add absolute positioning (ViewportDropdown owns position)",
  );
  assert.ok(
    src.includes(':root[data-theme="light"] .fd-settings-popover {'),
    "the popover must have light-mode surface rules (it portals to <body>, so --fd-* vars cannot reach it)",
  );
  assert.ok(
    src.includes(':root[data-theme="light"] .fd-settings-popover .fd-settings-row strong'),
    "row text must have light-mode ink",
  );
});

test("mini dialer theme defaults to LIGHT and honours the user's stored choice", () => {
  const src = read("components/DesktopMiniDialer.tsx");
  assert.ok(
    src.includes('localStorage.getItem("cc-theme")'),
    "the mini must read the user's real theme from shared localStorage",
  );
  assert.ok(
    src.includes('return fromShell === "dark" ? "dark" : "light";'),
    "the fallback default must be LIGHT — dark is opt-in everywhere in the portal",
  );
  // The shell's did-finish-load push re-asserts a stale in-memory theme; the
  // stored value must arbitrate or the mini keeps flipping to dark on launch.
  const handler = src.slice(src.indexOf("onMiniTheme?.(("), src.indexOf("// Drive the document theme"));
  assert.ok(
    handler.includes('stored === "dark" || stored === "light" ? stored : t'),
    "the onMiniTheme handler must prefer the stored theme over the shell's push",
  );
});

test("mini dialer call timer has the session-anchor fallback", () => {
  const src = read("components/DesktopMiniDialer.tsx");
  assert.ok(
    src.includes("phone.callStartedAt ?? liveTimerSession?.startedAt ?? null"),
    "the timer must fall back to the live session's startedAt when callStartedAt is missing",
  );
});

test("desktop shell's mini-theme default is light", () => {
  const src = readFileSync(
    path.join(__dirname, "..", "..", "desktop", "src", "main.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.ok(
    src.includes('let miniTheme: "dark" | "light" = "light";'),
    'the shell must default miniTheme to "light" (rides the next desktop release)',
  );
});
