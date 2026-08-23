/**
 * Guards on the Windows app's identity, icon and notifications.
 *
 * ⛔ THESE READ SOURCE AND CONFIG ON PURPOSE. Every defect this pass fixed was
 * in a CALLER or in build config, not in a function:
 *
 *   - the exe shipped Electron's atom icon because ONE build flag was false;
 *   - the toast rendered a full-width image because ONE option was passed to
 *     `new Notification`;
 *   - the taskbar icon was a downscaled 512px PNG because ONE path pointed at
 *     the .png instead of the .ico.
 *
 * A unit test of any function involved passes straight through all three.
 *
 * ⛔ CRLF: Izzy's global `core.autocrlf=true` checks .ts out with CRLF on this
 * machine, so a multi-line pattern matched against the raw read finds nothing
 * and reads as "the code isn't there". Normalise on read.
 * See [[source-reading-tests-must-normalise-crlf]].
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildWindowsToastXml } from "./notificationToast";
import { brandedUserAgent } from "./userAgent";

// DESKTOP_GUARD_ROOT points these guards at a materialised copy of another tree.
// It exists so every assertion here can be REPLAYED against the pre-change files
// and shown to fail there — a guard that passes on both trees guards nothing, and
// this repo has caught three decorative ones that way.
const DESKTOP = process.env.DESKTOP_GUARD_ROOT
  ? path.resolve(process.env.DESKTOP_GUARD_ROOT)
  : path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(DESKTOP, rel), "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  build?: unknown;
};

/**
 * The packaging config is `electron-builder.yml`, not package.json's `build`
 * key, because electron-builder validates against a strict schema and rejects a
 * `"//note"` comment key — and every setting in there needs its warning attached
 * to it. Read as TEXT rather than parsed: no YAML dependency, and every other
 * config/source guard in this repo reads text too.
 */
const builderYml = read("electron-builder.yml");
const ymlValue = (key: string): string | undefined =>
  builderYml.match(new RegExp(`^\\s*${key}:\\s*(\\S.*?)\\s*$`, "m"))?.[1];

const main = read("src/main.ts");

/**
 * ⛔ STRIP COMMENTS BEFORE ANY NEGATIVE ASSERTION. This bit on the very first
 * run: the "no hint-crop" guard below matched the sentence in main.ts's own doc
 * block explaining WHY there is no hint-crop, and failed against correct code.
 * Every `doesNotMatch` / `!includes` in this file reads `mainExecutable`, never
 * the raw source. Repo history records this trap three times over.
 */
const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
const mainExecutable = stripComments(main);

// ── the executable's embedded icon ─────────────────────────────────────────

test("signAndEditExecutable is never false — that is what shipped the Electron atom icon", () => {
  assert.equal(
    ymlValue("signAndEditExecutable"),
    "true",
    "false skips rcedit, so assets/icon.ico is never embedded into the .exe and Windows " +
      "falls back to Electron's default icon whenever it resolves the app from the " +
      "executable rather than a live window. Set it explicitly; do not rely on the default.",
  );
});

test("the packaging config has exactly one home", () => {
  assert.equal(
    pkg.build,
    undefined,
    "electron-builder refuses to start when both electron-builder.yml and a `build` key " +
      "in package.json exist",
  );
  assert.match(
    builderYml,
    /signAndEditExecutable/,
    "electron-builder.yml is the config; a `build` key that quietly reappears in " +
      "package.json would take every warning comment with it",
  );
});

test("every Windows icon slot points at the multi-size .ico", () => {
  for (const key of ["icon", "installerIcon", "uninstallerIcon", "installerHeaderIcon"]) {
    assert.equal(ymlValue(key), "assets/icon.ico", `${key} must point at the multi-size .ico`);
  }
});

test("the built exe is verified after every dist build", () => {
  assert.match(
    pkg.scripts.dist,
    /verify:icon/,
    "`pnpm dist` must run scripts/verify-built-icon.ts — a config assertion alone cannot " +
      "prove rcedit actually ran",
  );
});

test("icon.ico carries every size Windows asks for, and the small frames are NOT PNG", () => {
  const buf = fs.readFileSync(path.join(DESKTOP, "assets", "icon.ico"));
  assert.equal(buf.readUInt16LE(0), 0, "ico reserved field");
  assert.equal(buf.readUInt16LE(2), 1, "ico type field");
  const count = buf.readUInt16LE(4);

  const sizes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const size = buf.readUInt8(entry) || 256;
    sizes.push(size);
    const offset = buf.readUInt32LE(entry + 12);
    const isPng = buf.subarray(offset, offset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (size < 256) {
      // PNG-compressed .ico entries are only guaranteed at 256 on Vista+. rcedit
      // and several Windows shell surfaces render a small PNG entry BLANK — an
      // all-PNG .ico opens fine in an image viewer and ships an empty taskbar icon.
      assert.equal(isPng, false, `the ${size}px frame is PNG-compressed; it must be a BMP/DIB`);
    }
  }
  for (const want of [16, 24, 32, 48, 64, 128, 256]) {
    assert.ok(sizes.includes(want), `icon.ico is missing the ${want}px frame`);
  }
});

test("the window/tray icon is the .ico on Windows, never the single-resolution .png", () => {
  // The resolver moved into themeIcon.ts when the icon became theme-aware
  // (2026-08-23); the property it protects is unchanged — Windows must get the
  // multi-frame .ico so the 16px tray frame is a designer frame, not a downscale.
  const theme = fs.readFileSync(path.join(__dirname, "themeIcon.ts"), "utf8").replace(new RegExp(String.fromCharCode(13) + String.fromCharCode(10), "g"), String.fromCharCode(10));
  assert.match(
    theme,
    /platform === "win32" \? `icon\$\{suffix\}\.ico` : `icon\$\{suffix\}\.png`/,
    "a lone 512px PNG makes Windows downscale one image for the 16px taskbar; the mark is " +
      "thin glowing strokes and turns to a smudge",
  );
});

test("windows re-assert their icon on show/restore", () => {
  assert.match(main, /function pinWindowIcon\(win: BrowserWindow\): void \{/);
  for (const evt of ["show", "restore", "focus"]) {
    assert.ok(main.includes(`win.on("${evt}", apply)`), `pinWindowIcon must re-apply on "${evt}"`);
  }
  // Every window the user can see must be pinned.
  assert.match(main, /pinWindowIcon\(fullWindow\)/);
  assert.match(main, /pinWindowIcon\(miniWindow\)/);
  assert.match(main, /pinWindowIcon\(phoneEngineWindow\)/);
});

// ── app identity ───────────────────────────────────────────────────────────

test("the AppUserModelID still matches the appId, and neither was rebranded", () => {
  const appId = ymlValue("appId");
  assert.equal(
    appId,
    "com.connectcommunications.desktop",
    "changing appId makes the next update install SIDE BY SIDE instead of upgrading — " +
      "two tray icons, two SIP phones, a double ring",
  );
  assert.ok(
    main.includes(`app.setAppUserModelId("${appId}")`),
    "main.ts must call setAppUserModelId with exactly the appId electron-builder stamps " +
      "onto the Start Menu shortcut, or Windows cannot resolve the app's identity and the " +
      "taskbar ungroups, pinning breaks, and toasts lose their name and icon",
  );
});

test("the display name is Loopcom everywhere a person can see it", () => {
  assert.equal(ymlValue("productName"), "Loopcom");
  // Windows attributes a toast to the Start Menu shortcut carrying the AUMID, so
  // THIS is what the notification header reads.
  assert.equal(ymlValue("shortcutName"), "Loopcom");
  assert.equal(ymlValue("uninstallDisplayName"), "Loopcom");

  for (const title of ["Loopcom", "Loopcom Mini Dialer", "Loopcom Phone Engine"]) {
    assert.ok(main.includes(`title: "${title}"`), `missing window title ${title}`);
  }
  assert.match(main, /tray\.setToolTip\("Loopcom"\)/);
  assert.match(main, /label: "Open Loopcom"/);
  assert.match(main, /label: "Quit Loopcom"/);
});

test("no shell-visible string still says Connect", () => {
  const executable = mainExecutable;
  for (const stale of [
    'title: "Connect"',
    'title: "Connect Mini Dialer"',
    'title: "Connect Phone Engine"',
    'setToolTip("Connect")',
    'label: "Open Connect"',
    'label: "Quit Connect"',
  ]) {
    assert.ok(!executable.includes(stale), `main.ts still ships ${stale}`);
  }
  const updater = stripComments(read("src/updater.ts"));
  assert.ok(!/\bConnect\b/.test(updater), "updater.ts still shows Connect in an update dialog");
});

// ── notifications ──────────────────────────────────────────────────────────

test("⛔ a toast carries NO image of any kind — the logo belongs in the header", () => {
  // Izzy, 2026-08-21, pointing at Claude's own Windows toast as the reference:
  // small logo + app name in the HEADER, text underneath, nothing else. An
  // <image> in the body is a SECOND copy of the same logo — "that big-ass icon".
  // appLogoOverride (~64px, left of the text) was tried first and rejected; a
  // bare <image> or placement="hero" is worse still.
  for (const payload of [
    { kind: "voicemail", title: "New voicemail", body: "Sender Weiss" },
    { kind: "message", title: "New message", body: "845…: hello" },
    { kind: "missed-call", title: "Missed call", body: "Sender Weiss" },
  ]) {
    const xml = buildWindowsToastXml(payload);
    assert.doesNotMatch(xml, /<image/, `a toast must contain no <image>: ${xml}`);
    assert.doesNotMatch(xml, /placement=/, `no image placement of any kind: ${xml}`);
    assert.match(xml, /<binding template="ToastGeneric">/);
  }
  assert.match(main, /new Notification\(\{ toastXml: buildWindowsToastXml\(payload\) \}\)/);
});

test("the toast builder takes no logo argument, so one cannot creep back in", () => {
  assert.equal(buildWindowsToastXml.length, 1, "buildWindowsToastXml must take only the payload");
  const toastSrc = stripComments(read("src/notificationToast.ts"));
  assert.doesNotMatch(toastSrc, /<image/, "notificationToast.ts must not build an <image> element");
  assert.doesNotMatch(toastSrc, /appLogoOverride|hint-crop|placement=/);
});

test("a toast renders one text line when there is no body, two when there is", () => {
  const one = buildWindowsToastXml({ kind: "voicemail", title: "New voicemail", body: "  " });
  assert.equal(one.match(/<text>/g)?.length, 1, "a blank body must not leave an empty second line");
  const two = buildWindowsToastXml({ kind: "voicemail", title: "New voicemail", body: "Sender Weiss" });
  assert.equal(two.match(/<text>/g)?.length, 2);
  assert.match(two, /<text>New voicemail<\/text><text>Sender Weiss<\/text>/);
});

test("no notification is ever constructed with an icon option", () => {
  const executable = mainExecutable;
  const constructions = executable.match(/new Notification\(\{[^}]*\}\)/g) ?? [];
  assert.ok(constructions.length > 0, "expected at least one Notification construction");
  for (const c of constructions) {
    assert.ok(
      !/\bicon\s*:/.test(c),
      `Electron renders a Windows notification's \`icon\` as the toast's full-width INLINE ` +
        `image — that is the oversized voicemail icon. Found: ${c}`,
    );
  }
});

test("toast text is XML-escaped — caller names and message previews are user data", () => {
  // A customer really is called things like "Katz & Co", and an SMS preview is
  // whatever a stranger typed. One unescaped & makes Windows reject the whole
  // toast, so the notification silently never appears.
  const xml = buildWindowsToastXml({ kind: "message", title: 'Katz & Co <"1">', body: "he said <b>yes</b> & left" });
  assert.match(xml, /<text>Katz &amp; Co &lt;&quot;1&quot;&gt;<\/text>/);
  assert.match(xml, /<text>he said &lt;b&gt;yes&lt;\/b&gt; &amp; left<\/text>/);
  // Nothing the user typed may survive as markup.
  assert.doesNotMatch(xml.replace(/<\/?(toast|visual|binding|text|image)[^>]*>/g, ""), /[<>&](?!amp;|lt;|gt;|quot;|apos;)/);
});

test("the toast XML is well-formed", () => {
  // ⛔ A toast Windows refuses never appears and logs nothing — the failure mode
  // is a customer silently no longer being told about voicemail. A structural
  // check here catches a malformed template before it ships. (That the LIVE
  // string is accepted by Windows' own parser was proven separately with a real
  // toast; see the handoff.)
  const xml = buildWindowsToastXml({ kind: "voicemail", title: "New voicemail", body: "Sender Weiss" });
  const stack: string[] = [];
  for (const [, close, name, selfClose] of xml.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
    if (close) assert.equal(stack.pop(), name, `mismatched </${name}> in ${xml}`);
    else if (!selfClose) stack.push(name);
  }
  assert.deepEqual(stack, [], `unbalanced toast XML: ${xml}`);
  assert.match(xml, /^<toast>.*<\/toast>$/);
});

test("a toast Windows refuses falls back to a plain notification", () => {
  assert.match(
    main,
    /note\.on\("failed",/,
    "a toast with unusable XML never appears at all and logs nothing — a customer would " +
      "silently stop being told about voicemail",
  );
  assert.match(main, /showPlain\(\)/);
});

test("clicking a notification still opens the right place", () => {
  assert.match(main, /if \(payload\.kind === "incoming-call"\)/);
  assert.match(main, /loadPortal\(win, payload\.route\)/);
  assert.match(main, /note\.on\("click", onClick\)/);
});

// ── "no mention of Electron, ever" ─────────────────────────────────────────

test("the user agent carries no Electron token", () => {
  const electronDefault =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Connect/0.1.6 Chrome/142.0.7444.0 Electron/41.5.0 Safari/537.36";
  const ua = brandedUserAgent(electronDefault, "0.1.7");

  assert.doesNotMatch(ua, /electron/i, `the user agent still names Electron: ${ua}`);
  assert.doesNotMatch(ua, /\bConnect\//, `the user agent still carries the old product token: ${ua}`);
  // The Chrome token must survive UNCHANGED — sites and our own portal
  // feature-detect off it, and pinning a stale version breaks them over time.
  assert.match(ua, /Chrome\/142\.0\.7444\.0/);
  assert.match(ua, /AppleWebKit\/537\.36 \(KHTML, like Gecko\)/);
  assert.match(ua, /Safari\/537\.36$/);
  // The product token is how the desktop fleet is identified in nginx logs.
  assert.match(ua, /\bLoopcom\/0\.1\.7\b/, "dropping the product token would hide desktop traffic in the logs");
  assert.doesNotMatch(ua, /\s{2,}/, "removing tokens must not leave double spaces");
});

test("re-branding an already-branded user agent is a no-op", () => {
  // It runs at every startup, and a version bump must not stack tokens.
  const once = brandedUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Connect/0.1.6 Chrome/142.0.7444.0 Electron/41.5.0 Safari/537.36",
    "0.1.7",
  );
  const twice = brandedUserAgent(once, "0.1.7");
  assert.equal(twice, once);
  assert.equal(once.match(/Loopcom\//g)?.length, 1, "exactly one product token");
});

test("the user agent is branded before any window is created", () => {
  const uaIndex = mainExecutable.indexOf("app.userAgentFallback = branded");
  const windowIndex = mainExecutable.indexOf("createFullWindow(!shouldStartHidden())");
  assert.ok(uaIndex > 0, "main.ts must assign app.userAgentFallback");
  assert.ok(
    uaIndex < windowIndex,
    "the first page load would otherwise go out announcing Electron before the override lands",
  );
});

// ── the assets the app loads at runtime ────────────────────────────────────

test("every icon asset main.ts references exists", () => {
  for (const file of ["icon.ico", "icon.png"]) {
    const p = path.join(DESKTOP, "assets", file);
    assert.ok(fs.existsSync(p), `missing asset ${file}`);
    assert.ok(fs.statSync(p).size > 512, `${file} is suspiciously small`);
  }
});

/* ── the theme-following icon (2026-08-23) ───────────────────────────────── */

test("dark mode is navy-2a, light mode is blue-2b — Izzy's mapping, verbatim", () => {
  const { iconFileForTheme } = require("./themeIcon");
  assert.equal(iconFileForTheme(true, "win32"), "icon-dark.ico");
  assert.equal(iconFileForTheme(false, "win32"), "icon.ico");
  assert.equal(iconFileForTheme(true, "darwin"), "icon-dark.png");
  assert.equal(iconFileForTheme(false, "linux"), "icon.png");
});

test("the watcher applies once immediately and again on every OS toggle", () => {
  const { installThemeIconWatcher } = require("./themeIcon");
  const applied: Array<{ file: string; dark: boolean }> = [];
  let dark = false;
  let listener: (() => void) | null = null;
  installThemeIconWatcher({
    nativeTheme: {
      get shouldUseDarkColors() { return dark; },
      on: (_e: string, l: () => void) => { listener = l; },
    },
    applyIcons: (file: string, d: boolean) => applied.push({ file, dark: d }),
    // ⛔ a real setInterval here keeps the node:test process alive forever
    setIntervalFn: () => undefined,
  });
  assert.equal(applied.length, 1, "the current theme must be applied at install time");
  assert.equal(applied[0].dark, false);
  dark = true; listener!();
  dark = false; listener!();
  dark = true; listener!();
  assert.deepEqual(applied.map((a) => a.dark), [false, true, false, true]);
  assert.ok(applied[1].file.includes("-dark"), "dark did not pick the navy set");
  assert.ok(!applied[2].file.includes("-dark"), "light picked the wrong set");
});

test("both variants' assets really exist, every size", () => {
  // ⛔ A missing dark asset would make the swap a silent no-op: createFromPath on
  // a missing file yields an EMPTY nativeImage and Electron shows nothing.
  const assets = path.join(__dirname, "..", "assets");
  for (const suffix of ["", "-dark"]) {
    for (const f of [`icon${suffix}.ico`, `icon${suffix}.png`, `icon${suffix}-16.png`, `icon${suffix}-256.png`]) {
      assert.ok(fs.existsSync(path.join(assets, f)), `missing asset: ${f}`);
    }
  }
});

test("main.ts wires the watcher and resolves the icon per call, never once at boot", () => {
  const src = stripComments(main);
  assert.ok(src.includes("installThemeIconWatcher("), "the watcher is not installed");
  assert.ok(src.includes("iconFileForTheme(resolveDark({ nativeTheme, readSystemDark }))"),
    "iconPath no longer follows the live theme");
  assert.ok(!/const iconPath = process\.platform/.test(src),
    "iconPath went back to being resolved once at module load — the swap would be a lie");
  assert.ok(src.includes("tray.setImage(createAppIcon(16))"), "the tray is not re-imaged on toggle");
});

test("the tray icon follows the SYSTEM theme, with the app theme as fallback", () => {
  // ⛔ Found live on Izzy's machine: Windows' custom mode had system/taskbar DARK
  // and apps LIGHT. nativeTheme reports the APPS value, and keying on it alone put
  // the light icon on a dark taskbar. The system value wins whenever readable.
  const { resolveDark } = require("./themeIcon");
  const nt = (dark: boolean) => ({ shouldUseDarkColors: dark, on: () => {} });
  assert.equal(resolveDark({ nativeTheme: nt(false), readSystemDark: () => true }), true,
    "system dark must beat apps light — Izzy's exact machine");
  assert.equal(resolveDark({ nativeTheme: nt(true), readSystemDark: () => false }), false,
    "system light must beat apps dark");
  assert.equal(resolveDark({ nativeTheme: nt(true), readSystemDark: () => null }), true,
    "an unreadable system value falls back to the app theme");
  assert.equal(resolveDark({ nativeTheme: nt(false) }), false, "no reader at all still works");
});

test("a system-only theme change is caught by the poll, which fires no event anywhere", () => {
  const { installThemeIconWatcher } = require("./themeIcon");
  const applied: string[] = [];
  let systemDark = false;
  let tick: (() => void) | null = null;
  installThemeIconWatcher({
    nativeTheme: { shouldUseDarkColors: false, on: () => {} },
    readSystemDark: () => systemDark,
    applyIcons: (file: string) => applied.push(file),
    pollMs: 1,
    setIntervalFn: (fn: () => void) => { tick = fn; },
  });
  assert.equal(applied.length, 1);
  tick!(); // nothing changed — must NOT re-apply
  assert.equal(applied.length, 1, "an unchanged poll re-applied the icon");
  systemDark = true; tick!();
  assert.equal(applied.length, 2, "the poll missed a system-only change");
  assert.ok(applied[1].includes("-dark"));
  systemDark = false; tick!();
  assert.ok(!applied[2].includes("-dark"));
});

test("main.ts reads SystemUsesLightTheme with real backslashes in the path", () => {
  // ⛔ In a JS string the separator must be an ESCAPED backslash (two chars in
  // source). A single backslash collapses — "HKCU\S..." becomes "HKCUS..." — and
  // reg query fails on every call; the null fallback then hides it, so the system
  // theme would silently never win. The source therefore contains the two-char
  // sequence backslash-backslash between HKCU and SOFTWARE.
  const bs = String.fromCharCode(92);
  assert.ok(main.includes("HKCU" + bs + bs + "SOFTWARE"), "the registry path lost its backslashes");
  assert.ok(main.includes("SystemUsesLightTheme"), "SystemUsesLightTheme query is missing");
  assert.ok(main.includes("readSystemDark"), "main no longer reads the system theme");
  assert.ok(main.includes("resolveDark({ nativeTheme, readSystemDark })"),
    "the window icon resolver no longer follows the system theme");
});

test("the taskbar icon is re-asserted on a ladder after first show — the button appears late", () => {
  // ⛔ Found live: the window reported valid HICONs but the taskbar drew the
  // generic paper icon, because the button is created a beat after first paint and
  // the initial setIcon lands before it exists. A delayed re-assert cures it.
  assert.match(main, /win\.once\("show", \(\) => \{/,
    "the one-shot post-show re-assert is gone");
  assert.match(main, /for \(const ms of \[120, 400, 1200\]\) setTimeout\(apply, ms\)/,
    "the delayed re-assert ladder is gone");
});
