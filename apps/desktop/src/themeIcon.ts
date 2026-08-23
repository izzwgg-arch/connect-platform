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
  /**
   * ⛔⛔ THE TASKBAR FOLLOWS THE SYSTEM THEME, NOT THE APP THEME — found live on
   * Izzy's own machine (2026-08-23), which runs Windows' split mode: system/taskbar
   * DARK, apps LIGHT. nativeTheme.shouldUseDarkColors reports the APPS value, so
   * keying on it alone showed the light icon on a dark taskbar. This injected read
   * returns Windows' SystemUsesLightTheme as a dark-boolean (true = system is
   * dark), or null when unreadable — and null falls back to the app theme.
   */
  readSystemDark?: () => boolean | null;
  /** Re-applies tray + window icons for the CURRENT theme. Injected by main.ts. */
  applyIcons: (file: string, dark: boolean) => void;
  log?: (line: string) => void;
  /**
   * ⛔ Windows fires NO event when only the SYSTEM half of a custom theme changes
   * (nativeTheme watches the apps value), so the system value is re-read on a
   * gentle poll as well as on every "updated". One registry read per tick.
   */
  pollMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
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
export function resolveDark(deps: Pick<ThemeIconDeps, "nativeTheme" | "readSystemDark">): boolean {
  // System theme first — that is the surface the icon sits on — app theme as the
  // fallback when the system value cannot be read.
  const sys = deps.readSystemDark?.();
  if (sys === true || sys === false) return sys;
  return Boolean(deps.nativeTheme.shouldUseDarkColors);
}

export function installThemeIconWatcher(deps: ThemeIconDeps): { currentIconFile: () => string } {
  let last: string | null = null;
  const apply = (why: string) => {
    const dark = resolveDark(deps);
    const file = iconFileForTheme(dark);
    if (file === last) return;
    last = file;
    deps.log?.(`theme ${dark ? "dark" : "light"} (${why}) -> ${file}`);
    deps.applyIcons(file, dark);
  };
  apply("boot");
  // Fires when the APPS theme (or the whole mode) changes.
  deps.nativeTheme.on("updated", () => apply("nativeTheme"));
  // Catches a SYSTEM-only change, which fires no event anywhere.
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  setIntervalFn(() => apply("poll"), deps.pollMs ?? 15_000);
  return { currentIconFile: () => iconFileForTheme(resolveDark(deps)) };
}
