/**
 * The app icon follows the person's Windows theme.
 *
 * Izzy, 2026-08-23: "the icon changes whether the person has dark mode or light
 * mode … 2A would be dark mode. 2B would be the light mode."
 *
 * ⛔⛔ WHAT CAN AND CANNOT FOLLOW A THEME, stated once so nobody re-litigates it:
 * the icon EMBEDDED IN THE EXE (Start menu, pinned shortcuts, Add/Remove, the
 * toast header) is one per program — Windows reads it out of the executable and
 * there is no theme-aware form of it. That baked icon stays blue-2b, the chosen
 * default. What CAN switch, and does here, is everything the RUNNING app draws:
 * the tray icon and every window's own icon (which is what the live taskbar
 * button shows). nativeTheme fires "updated" the moment the OS toggle moves, so
 * the swap is instantaneous.
 *
 * ⛔ Pure where it decides, injected where it acts — the mapping is a function of
 * (dark, platform) and nothing else, so the rule is provable without Electron.
 */

export type ThemeIconDeps = {
  nativeTheme: {
    readonly shouldUseDarkColors: boolean;
    on(event: "updated", listener: () => void): unknown;
  };
  /** Re-applies tray + window icons for the CURRENT theme. Injected by main.ts. */
  applyIcons: (file: string, dark: boolean) => void;
  log?: (line: string) => void;
};

/**
 * Which asset carries the icon for this theme.
 *
 * ⛔ THE MAPPING IS IZZY'S, VERBATIM: dark mode -> navy-2a (the -dark set),
 * light mode -> blue-2b (the default set). Windows takes the .ico so every tray
 * size comes from a designer frame; everywhere else takes the 256 PNG.
 */
export function iconFileForTheme(dark: boolean, platform: NodeJS.Platform = process.platform): string {
  const suffix = dark ? "-dark" : "";
  return platform === "win32" ? `icon${suffix}.ico` : `icon${suffix}.png`;
}

/**
 * Apply the current theme's icon now, and again every time the OS toggle moves.
 * Returns the applier so callers (window creation, tray creation, the restore
 * re-assert) can pull the CURRENT icon rather than a remembered one.
 */
export function installThemeIconWatcher(deps: ThemeIconDeps): { currentIconFile: () => string } {
  const apply = () => {
    const dark = Boolean(deps.nativeTheme.shouldUseDarkColors);
    const file = iconFileForTheme(dark);
    deps.log?.(`theme ${dark ? "dark" : "light"} -> ${file}`);
    deps.applyIcons(file, dark);
  };
  apply();
  // ⛔ The whole feature is this listener: Windows flips AppsUseLightTheme,
  // Chromium watches the registry key, "updated" fires, the icons swap — no
  // polling and no restart.
  deps.nativeTheme.on("updated", apply);
  return { currentIconFile: () => iconFileForTheme(Boolean(deps.nativeTheme.shouldUseDarkColors)) };
}
