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
    /remoteSupportEnabled\(\)\s*\?[\s\S]{0,120}remoteSupport:/,
    "the remoteSupport key must be attached only when the gate says so",
  );
});

test("remote support off means the key is ABSENT, not an object of no-ops", () => {
  const code = executableLines(readSource("preload.ts"));

  // The portal tests `bridge?.remoteSupport?.listScreens`. An empty object, or a
  // stubbed one, passes that test and starts the polling — so the false branch
  // must hand over the plain api with no remoteSupport key at all.
  assert.match(
    code,
    /remoteSupportEnabled\(\)\s*\?\s*\{\s*\.\.\.desktopApi,\s*remoteSupport:\s*remoteSupportApi\s*\}\s*:\s*desktopApi/,
    "when off, expose desktopApi itself — anything with a remoteSupport key would pass the portal's check",
  );
});

test("main passes the flag only when the setting is on", () => {
  const code = executableLines(readSource("main.ts"));

  assert.match(
    code,
    /settings\.remoteSupportEnabled\s*\?\s*\["--connect-remote-support=1"\]\s*:\s*\[\]/,
    "the launch argument must be conditional on the stored opt-in",
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
});

test("the display media handler is installed, and never captures audio", () => {
  const code = executableLines(readSource("main.ts"));

  // Without this, getDisplayMedia hangs or rejects with nothing in the console
  // and the bug looks like it is in the portal.
  assert.match(code, /setDisplayMediaRequestHandler/);

  // Support looks at a screen; it does not listen to the room. Every callback
  // path must pass audio: undefined.
  const callbacks = code.match(/callback\(\{[^}]*\}\)/g) ?? [];
  assert.ok(callbacks.length >= 2, "expected the handler's success and refusal callbacks");
  for (const call of callbacks) {
    assert.match(call, /audio:\s*undefined/, `a display-media callback must never grant audio: ${call}`);
  }
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
