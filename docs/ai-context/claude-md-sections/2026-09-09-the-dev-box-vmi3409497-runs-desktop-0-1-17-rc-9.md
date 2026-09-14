# ⛔ AGENT HANDOFF — the dev box (VMI3409497) runs desktop `0.1.17-rc.9` now, REBUILT HERE from a clean export of HEAD and installed with `/S`; the fleet feed is UNTOUCHED at 0.1.16 (2026-09-09) — READ FIRST before "the latest desktop build", before building the desktop app on this machine, or before believing `apps/desktop/release/` exists

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**No code change, no deploy, no feed change.** Izzy, 2026-09-09: *"install the latest loopcom
windows app with the assistant that can run tasks on my computer. Install it on this computer
only, so update it."* — "this computer" = the dev box, which was on 0.1.16 (the fleet version);
Izzy's workstation already had rc.9 from `7f73086a`. Memory: [[loopcom-desktop-built-and-installed-on-devbox]].)

- ✅ **INSTALLED AND RUNNING: `Loopcom 0.1.17-rc.9`** (registry `DisplayVersion 0.1.17-rc.9`, exe
  `FileVersion 0.1.17-rc.9` / `Loopcom LLC`, log banner `=== log start v0.1.17-rc.9 ===`, 6
  processes). The updater checked the feed and wrote *"Update for version 0.1.17-rc.9 is not
  available (latest version: 0.1.16, downgrade is disallowed)"* — an rc install on top of the fleet
  feed is stable; it will not be pulled back to 0.1.16. `/S` exit 0 closed the running 0.1.16 app;
  relaunched by `Start-Process` on `%LOCALAPPDATA%\Programs\@connectdesktop\Loopcom.exe`.
- ✅ **THE ARTIFACT:** `apps/desktop/release/Connect-Setup-0.1.17-rc.9.exe` (100,414,720 bytes,
  sha256 `a664c20bbc0c04a609b0a9a52a292eb9116e5fe062d418c23483708f06097d7a`) + `.blockmap` +
  `latest.yml` (reads rc.9 — ⛔ NOT uploaded; `app.connectcomunications.com/desktop/latest.yml`
  still reads 0.1.16). `verify-built-icon` OK — 7 RT_ICON, the Loopcom icon and nothing else.
  Same desktop source as the workstation's rc.9: `git log 7f73086a..HEAD -- apps/desktop` is empty.
- ⛔⛔ **BUILT FROM `git archive HEAD`, NOT FROM THE WORKING TREE.** Another session was writing
  UNTRACKED `apps/desktop/src/coworker/{policyCore,toolCatalog}.ts` + `runtime/*` (a bigger
  Coworker runtime: browser/shell/windows/xlsx/mcp) and had symlinked `apps/desktop/node_modules`
  to ITS scratchpad. `tsconfig` includes `src/**/*.ts`, so an in-place build would have shipped that
  half-written work. Recipe that works on this box (no pnpm, no root `node_modules`):
  `git archive HEAD apps/desktop tsconfig.base.json packages/shared/src/coworker | tar -x -C <scratch>`;
  `npm install electron@41.5.0 electron-updater@6.8.9 electron-builder@26.8.1 typescript@6.0.3
  @types/node@25.6.0` (the lockfile's exact versions) in the scratch; `mklink /J node_modules`
  into the export; `tsc -p tsconfig.json`; `electron-builder --win` (downloads electron + nsis
  itself; `CSC_IDENTITY_AUTO_DISCOVERY=false`).
- ⛔ **winCodeSign still needs the pre-extract** (no `SeCreateSymbolicLink`, no Developer Mode):
  `curl -L` the `winCodeSign-2.6.0.7z` release asset into
  `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` and `7za x` it into `winCodeSign-2.6.0`
  (exit 2 on the two `.dylib` symlinks is fine; `rcedit-x64.exe` must exist). Done; the cache now
  persists on this box.
- ⛔ **`node scripts/verify-built-icon.ts` FAILS on Node 26** (`__dirname is not defined in ES
  module scope` — type-stripping loads it as ESM). Without tsx, compile it:
  `tsc --ignoreConfig scripts/verify-built-icon.ts --module commonjs --target es2022
  --moduleResolution node --ignoreDeprecations 6.0 --esModuleInterop --skipLibCheck --types node
  --outDir scripts` then `node scripts/verify-built-icon.js`.
- ⏳ **NOT PROVEN: the Coworker hands on THIS machine** — nobody has opened the bubble here and
  approved a `folder_summary` / `organize_folder` / `system_snapshot` card (acceptance in the
  2026-09-02 "HAS HANDS" section). Not done on purpose: an `organize_folder` moves Izzy's files.
- ⛔ **Do not "clean up" the untracked coworker files or the `node_modules` symlink in
  `apps/desktop`** — they belong to the other session. Publishing rc.9 to the fleet remains
  Izzy's call (it carries remote-desktop, coworker-hands and elevated-support work).
