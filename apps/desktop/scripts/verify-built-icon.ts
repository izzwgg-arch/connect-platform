/**
 * Post-build guard: prove the SHIPPED .exe really carries the Loopcom icon.
 *
 * ⛔ WHY THIS EXISTS — the failure it is built to make impossible
 * ---------------------------------------------------------------
 * `apps/desktop/package.json` used to carry `"signAndEditExecutable": false`,
 * which tells electron-builder to skip rcedit. rcedit is the ONLY thing that
 * embeds `assets/icon.ico` into the executable, so every installer ever shipped
 * carried **Electron's default atom icon** inside `Connect.exe`. Proven on the
 * installed 0.1.6 build by extracting the exe's icon and putting it beside the
 * repo's — atom on the left, our icon on the right.
 *
 * That is the whole mechanism behind "the icon is there for a few minutes and
 * then it disappears": `new BrowserWindow({ icon })` paints the taskbar button
 * while a window exists, but Windows re-resolves the app's identity from the
 * EXECUTABLE (and the shortcut pointing at it) whenever the button is regrouped,
 * the window hides to the tray, or the icon cache is re-read — and fell back to
 * the atom. Nothing in the app can fix that from the renderer side; the bytes
 * have to be in the exe.
 *
 * ⛔ A CONFIG ASSERTION IS NOT ENOUGH, so this does not make one. Checking that
 * `signAndEditExecutable !== false` only proves what we asked for. rcedit can
 * fail (locked file, antivirus, a bad .ico) and electron-builder has been known
 * to warn rather than fail. This reads the built artifact and compares the
 * actual RT_ICON resources against `assets/icon.ico`, byte for byte. If the atom
 * is in there, this fails the build.
 *
 * Run by `pnpm dist` automatically. Also runnable alone after a build:
 *     cd apps/desktop && pnpm verify:icon
 */

import fs from "node:fs";
import path from "node:path";

const DESKTOP = path.resolve(__dirname, "..");
const ICO = path.join(DESKTOP, "assets", "icon.ico");
const RELEASE = path.join(DESKTOP, "release");

/** The exe name electron-builder produces == build.productName. */
const PRODUCT_NAME = "Loopcom";

// ── .ico parsing ────────────────────────────────────────────────────────────
// An .ico is a 6-byte header, then one 16-byte directory entry per image, then
// the image payloads. Each payload is embedded VERBATIM as an RT_ICON resource
// by rcedit — which is exactly what makes the comparison below a byte match
// rather than a similarity score.

type IconImage = { width: number; height: number; bytes: Buffer };

function readIcoImages(file: string): IconImage[] {
  const buf = fs.readFileSync(file);
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error(`${file} is not an .ico (bad magic)`);
  }
  const count = buf.readUInt16LE(4);
  const out: IconImage[] = [];
  for (let i = 0; i < count; i += 1) {
    const e = 6 + i * 16;
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    out.push({
      // 0 means 256 in the .ico directory.
      width: buf.readUInt8(e) || 256,
      height: buf.readUInt8(e + 1) || 256,
      bytes: buf.subarray(offset, offset + size),
    });
  }
  return out;
}

// ── PE resource walking ─────────────────────────────────────────────────────
// Enough of the PE format to pull out RT_ICON. Deliberately dependency-free:
// this runs on Izzy's Windows box inside `pnpm dist`, and a build guard that
// needs an install step is a build guard people delete.

const RT_ICON = 3;

function readPeResources(file: string, typeId: number): Buffer[] {
  const buf = fs.readFileSync(file);
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") throw new Error(`${file}: not a PE image`);

  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const sectionTable = peOff + 24 + optSize;

  let rsrcRva = 0;
  let rsrcOff = 0;
  for (let i = 0; i < numSections; i += 1) {
    const s = sectionTable + i * 40;
    const name = buf.toString("ascii", s, s + 8).replace(/\0+$/, "");
    if (name === ".rsrc") {
      rsrcRva = buf.readUInt32LE(s + 12);
      rsrcOff = buf.readUInt32LE(s + 20);
      break;
    }
  }
  if (!rsrcOff) throw new Error(`${file}: no .rsrc section — the exe carries no resources at all`);

  const results: Buffer[] = [];

  // A resource directory is 16 bytes of header then (named + id) 8-byte
  // entries. An entry's OffsetToData with the high bit set points at a nested
  // directory; without it, at a leaf data entry. The tree is always
  // type -> name/id -> language.
  const walk = (dirOffset: number, depth: number, wantedType: number | null): void => {
    const named = buf.readUInt16LE(dirOffset + 12);
    const ids = buf.readUInt16LE(dirOffset + 14);
    for (let i = 0; i < named + ids; i += 1) {
      const e = dirOffset + 16 + i * 8;
      const nameField = buf.readUInt32LE(e);
      const dataField = buf.readUInt32LE(e + 4);
      if (depth === 0 && wantedType !== null) {
        const isString = (nameField & 0x80000000) !== 0;
        if (isString || nameField !== wantedType) continue;
      }
      if (dataField & 0x80000000) {
        walk(rsrcOff + (dataField & 0x7fffffff), depth + 1, null);
      } else {
        const leaf = rsrcOff + dataField;
        const dataRva = buf.readUInt32LE(leaf);
        const size = buf.readUInt32LE(leaf + 4);
        const start = rsrcOff + (dataRva - rsrcRva);
        results.push(buf.subarray(start, start + size));
      }
    }
  };

  walk(rsrcOff, 0, typeId);
  return results;
}

// ── the check ───────────────────────────────────────────────────────────────

function findExe(): string {
  // An explicit path is how this gets pointed at an ALREADY-INSTALLED build, which
  // is how the check itself was proven non-vacuous: run against the shipped 0.1.6
  // Connect.exe it correctly reports the embedded icon is not ours.
  const explicit = process.argv[2];
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`no exe at ${explicit}`);
    return explicit;
  }
  const unpacked = path.join(RELEASE, "win-unpacked", `${PRODUCT_NAME}.exe`);
  if (fs.existsSync(unpacked)) return unpacked;
  throw new Error(
    `no built exe at ${unpacked}\n` +
      `  Did the build produce a differently-named exe? The name comes from build.productName.\n` +
      `  Run \`pnpm dist\` first.`,
  );
}

function main(): number {
  const problems: string[] = [];

  const exe = findExe();
  const wanted = readIcoImages(ICO);
  const embedded = readPeResources(exe, RT_ICON);

  console.log(`verify:icon  exe      ${path.relative(DESKTOP, exe)}`);
  console.log(`verify:icon  icon.ico ${wanted.length} image(s): ${wanted.map((w) => w.width).join(", ")}`);
  console.log(`verify:icon  exe      ${embedded.length} RT_ICON resource(s)`);

  // 1. Every image from our .ico must be in the exe, byte for byte. This is the
  //    check that fails if rcedit was skipped (the atom's payloads are there
  //    instead of ours) or if it silently failed.
  for (const img of wanted) {
    const hit = embedded.some((res) => res.length === img.bytes.length && res.equals(img.bytes));
    if (!hit) problems.push(`the ${img.width}x${img.height} frame of assets/icon.ico is NOT embedded in the exe`);
  }

  // 2. …and nothing ELSE may be in there. If a foreign RT_ICON survives, the
  //    icon group Windows picks could still resolve to it. This is what makes
  //    "the Electron atom can never come back" a fact rather than a hope.
  const ours = new Set(wanted.map((w) => w.bytes.toString("base64")));
  const strangers = embedded.filter((res) => !ours.has(res.toString("base64")));
  if (strangers.length > 0) {
    problems.push(
      `${strangers.length} RT_ICON resource(s) in the exe are NOT from assets/icon.ico ` +
        `(sizes ${strangers.map((s) => s.length).join(", ")} bytes) — a foreign icon is still embedded`,
    );
  }

  // 3. rcedit writes the version strings in the same pass it writes the icon,
  //    so the product name landing is corroboration that the pass really ran.
  const exeBuf = fs.readFileSync(exe);
  if (exeBuf.indexOf(Buffer.from(PRODUCT_NAME, "utf16le")) === -1) {
    problems.push(`the exe's version info does not contain "${PRODUCT_NAME}" — rcedit did not run`);
  }

  if (problems.length > 0) {
    console.error("\nverify:icon FAILED\n");
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(
      "\n  The most likely cause is build.win.signAndEditExecutable being false, or rcedit\n" +
        "  failing (antivirus locking the exe is the usual culprit — retry the build).\n" +
        "  Do NOT 'fix' this by setting signAndEditExecutable back to false: that is the\n" +
        "  exact setting that shipped Electron's atom icon to the whole fleet.\n",
    );
    return 1;
  }

  console.log("verify:icon  OK — the exe carries the Loopcom icon and nothing else");
  return 0;
}

process.exit(main());
