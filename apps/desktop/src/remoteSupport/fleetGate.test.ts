/**
 * Guards on the one property that decides whether remote support is a feature
 * this machine has or a feature every customer suddenly has.
 *
 * ⛔ THESE READ SOURCE, ON PURPOSE. The thing that can go wrong here is not a
 * function returning the wrong value — it is a caller publishing a key it should
 * not, or main.ts forgetting to pass the argument that keeps the key hidden.
 * Neither is visible to a unit test of any single function, which is exactly the
 * shape of defect this repo keeps paying for.
 *
 * The property being defended: the portal's RemoteSupportConsent is mounted for
 * every signed-in user and decides remote support exists by looking for
 * `connectDesktop.remoteSupport`. If the Connect app publishes that key
 * unconditionally, every customer polls /remote-support/pending every five
 * seconds from the day the build ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⛔ CRLF-normalised. This tree is checked out with core.autocrlf=true on
 * Windows, so a multi-line pattern matches nothing and the test passes for the
 * wrong reason — a guard that cannot fail is worse than no guard.
 */
function readSource(relative: string): string {
  return readFileSync(join(__dirname, "..", relative), "utf8").replace(/\r\n/g, "\n");
}

/** Comment-stripped, because these files DOCUMENT the bad shapes they forbid. */
function executableLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

test("the preload publishes remoteSupport only behind the launch flag", () => {
  const code = executableLines(readSource("preload.ts"));

  // The gate exists and reads the argument main.ts passes.
  assert.match(
    code,
    /--connect-remote-support=1/,
    "the preload must decide from the launch argument, which is the only thing the tray toggle can set",
  );

  // The key is conditional. An unconditional `remoteSupport:` inside the
  // exposeInMainWorld object is precisely the customer-wide switch-on.
  assert.match(
    code,
    /\.\.\.\(remoteSupportEnabled\(\)\s*\?\s*\{\s*remoteSupport:\s*remoteSupportApi\s*\}\s*:\s*\{\}\)/,
    "the remoteSupport key must be attached only when the gate says so",
  );
  // Remote Desktop (2026-09-02): the SECOND gate, same shape. The host key
  // registers the machine and polls every five seconds once the portal sees it.
  assert.match(code, /--connect-remote-desktop=1/, "the preload must decide Remote Desktop from its own launch argument");
  assert.match(
    code,
    /\.\.\.\(remoteDesktopEnabled\(\)\s*\?\s*\{\s*remoteDesktop:\s*remoteDesktopHostApi\s*\}\s*:\s*\{\}\)/,
    "the remoteDesktop host key must be attached only when its gate says so",
  );
});

test("remote support off means the key is ABSENT, not an object of no-ops", () => {
  const code = executableLines(readSource("preload.ts"));

  // The portal tests `bridge?.remoteSupport?.listScreens`. An empty object, or a
  // stubbed one, passes that test and starts the polling — so the false branch
  // must hand over the plain api with no remoteSupport key at all.
  // Each gated key spreads `{}` when off, so the object literally lacks the key.
  assert.match(
    code,
    /\.\.\.\(remoteSupportEnabled\(\)\s*\?\s*\{\s*remoteSupport:\s*remoteSupportApi\s*\}\s*:\s*\{\}\)/,
    "when off, spread nothing — anything with a remoteSupport key would pass the portal's check",
  );
  assert.match(
    code,
    /\.\.\.\(remoteDesktopEnabled\(\)\s*\?\s*\{\s*remoteDesktop:\s*remoteDesktopHostApi\s*\}\s*:\s*\{\}\)/,
    "when off, spread nothing — anything with a remoteDesktop key would pass the portal's check",
  );
  // ⛔ No unconditional `remoteSupport:` / `remoteDesktop:` inside the exposed object.
  const exposed = code.slice(code.indexOf("contextBridge.exposeInMainWorld("));
  assert.doesNotMatch(exposed, /^\s*remoteSupport:\s*remoteSupportApi,?\s*$/m, "remoteSupport published unconditionally");
  assert.doesNotMatch(exposed, /^\s*remoteDesktop:\s*remoteDesktopHostApi,?\s*$/m, "remoteDesktop published unconditionally");
  // The SETUP bridge is deliberately unconditional: it polls nothing and shares nothing.
  assert.match(exposed, /remoteDesktopSetup:\s*remoteDesktopSetupApi/);
});

test("main passes the flag only when the setting is on", () => {
  const code = executableLines(readSource("main.ts"));

  assert.match(
    code,
    /settings\.remoteSupportEnabled\s*\?\s*\["--connect-remote-support=1"\]\s*:\s*\[\]/,
    "the launch argument must be conditional on the stored opt-in",
  );
  assert.match(
    code,
    /settings\.remoteDesktopEnabled\s*\?\s*\["--connect-remote-desktop=1"\]\s*:\s*\[\]/,
    "the Remote Desktop launch argument must be conditional on its own stored opt-in",
  );
});

test("the setting is opt-in: nothing defaults it to true", () => {
  const main = executableLines(readSource("main.ts"));
  const types = executableLines(readSource("types.ts"));

  // Optional in the type, so an existing settings file (which has no such key)
  // reads as off rather than as missing-and-therefore-invalid.
  assert.match(types, /remoteSupportEnabled\?:\s*boolean/);

  // ⛔ No default-true anywhere. `?? true` or `|| true` on this flag would make
  // every update opt the customer in.
  assert.doesNotMatch(
    main,
    /remoteSupportEnabled\s*(\?\?|\|\|)\s*true/,
    "a default of true switches remote support on for everybody who updates",
  );
  assert.doesNotMatch(main, /remoteSupportEnabled:\s*true/);
  assert.match(types, /remoteDesktopEnabled\?:\s*boolean/);
  assert.doesNotMatch(main, /remoteDesktopEnabled\s*(\?\?|\|\|)\s*true/, "a default of true switches Remote Desktop on for everybody who updates");
  assert.doesNotMatch(main, /remoteDesktopEnabled:\s*true/);
});

test("the display media handler is installed, and captures audio ONLY as system loopback for a granted Remote Desktop session", () => {
  const code = executableLines(readSource("main.ts"));

  // Without this, getDisplayMedia hangs or rejects with nothing in the console
  // and the bug looks like it is in the portal.
  assert.match(code, /setDisplayMediaRequestHandler/);

  // Remote SUPPORT never listens to the room. Remote DESKTOP may carry what the
  // computer PLAYS — the loopback device — and only when the renderer recorded a
  // session the server granted `sound`. ⛔ Never a microphone on any path.
  const callbacks = code.match(/callback\(\{[^}]*\}\)/g) ?? [];
  assert.ok(callbacks.length >= 2, "expected the handler's success and refusal callbacks");
  for (const call of callbacks) {
    assert.ok(/audio:\s*undefined/.test(call) || /audio(\s*:\s*audio)?\s*[,}]/.test(call), `a display-media callback must grant audio only through the loopback decision: ${call}`);
    assert.doesNotMatch(call, /audio:\s*true/, "audio: true would capture a MICROPHONE — never");
  }
  assert.match(code, /remoteDesktopAudioAllowed\(\)\s*\?\s*\("loopback" as const\)\s*:\s*undefined/, "system audio only as loopback, only when a granted session allowed it");
  assert.doesNotMatch(code, /loopbackWithMute/, "the person at the machine must keep hearing their own computer");
});

test("the customer's own screen choice wins over Electron's guess", () => {
  const code = executableLines(readSource("main.ts"));

  // getPreferredSourceId is what the consent dialog set. If it is not consulted
  // first, a two-monitor machine can share the screen with their personal email
  // on it.
  const chosen = code.slice(code.indexOf("const chosen ="), code.indexOf("if (!chosen)"));
  assert.ok(chosen.length > 0, "expected the source-selection block");

  const mine = chosen.indexOf("getPreferredSourceId()");
  // The request's own hint, held in `wanted` — read above this block, so match
  // the identifier the fallback chain actually uses.
  const hint = chosen.indexOf("=== wanted");
  assert.ok(mine >= 0, "the customer's chosen source must be consulted at all");
  assert.ok(hint >= 0, "expected the request-hint fallback, so the ordering means something");
  assert.ok(mine < hint, "the customer's pick must be preferred over the request's hint");

  // And a whole screen beats an arbitrary window when neither is known — a
  // mis-pick should be boring rather than revealing.
  assert.ok(
    chosen.indexOf('startsWith("screen:")') < chosen.indexOf("sources[0]"),
    "prefer a whole screen over the first window in the list",
  );
});

test("quitting tears the helper down", () => {
  const code = executableLines(readSource("main.ts"));

  const beforeQuit = code.slice(code.indexOf('app.on("before-quit"'));
  assert.match(
    beforeQuit,
    /stopRemoteSupport\(\)/,
    "a PowerShell helper that can move the mouse must not outlive the app that started it",
  );
  assert.match(beforeQuit, /stopRemoteDesktop\(\)/, "the system-audio allowance must not outlive the app either");
});

test("turning remote support off stops what is running now", () => {
  const code = executableLines(readSource("main.ts"));

  const toggle = code.slice(code.indexOf("function toggleRemoteSupport"));
  const body = toggle.slice(0, toggle.indexOf("\nfunction "));
  assert.match(
    body,
    /if\s*\(!enabled\)\s*stopRemoteSupport\(\)/,
    "withdrawing permission must take effect immediately, not at the next restart",
  );
});

test("the lifted module did not bring a second LAN scanner with it", () => {
  const code = readSource("remoteSupport/mainWiring.ts");

  // This app already has one under phoneSetup/. Two scanners in one process is
  // two answers to the same question, and the desk-phone wizard owns that one.
  assert.doesNotMatch(code, /lan-scan:/);
  assert.doesNotMatch(code, /from "\.\/lanScan"/);
});
