/**
 * What the Loopcom Windows app offers the Coworker workspace (apps/desktop/src/
 * preload.ts `coworkerUi`, judged in apps/desktop/src/coworker/uiBridge.ts).
 *
 * ⛔ Absent in a browser tab. Every caller treats "no bridge" as "this computer's
 * settings aren't reachable from here" — never as an error, never as a default of
 * full access. In a browser the Coworker can still talk, read uploaded files and look
 * things up; it cannot touch a computer.
 */

export type AccessProfile = "SAFE" | "TRUSTED" | "AUTONOMOUS";
export type ToolGroups = { files: boolean; browser: boolean; sheets: boolean; git: boolean; shell: boolean; system: boolean; email: boolean };
export type AttachedFolder = { path: string; name: string; repo: boolean };

export type DesktopCoworkerState = {
  ok: boolean;
  linked: boolean;
  profile: AccessProfile;
  groups: ToolGroups;
  bubble: boolean;
  folders: AttachedFolder[];
  gitInstalled: boolean;
  appVersion: string;
};

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string; message?: string };

export type CoworkerUiBridge = {
  state: () => Promise<DesktopCoworkerState | { ok: false; error: string }>;
  setAccess: (profile: AccessProfile) => Promise<Result<{ profile: AccessProfile }>>;
  pickFolder: (opts?: { repo?: boolean }) => Promise<Result<{ folder: AttachedFolder }>>;
  attachDroppedFolder: (file: File) => Promise<Result<{ folder: AttachedFolder }>>;
  removeFolder: (path: string) => Promise<Result>;
  setGroups: (patch: Partial<ToolGroups>) => Promise<Result<{ groups: ToolGroups }>>;
  setBubble: (on: boolean) => Promise<Result<{ bubble: boolean }>>;
  openFull: (route?: string) => Promise<Result>;
  openBubble: () => Promise<Result>;
  taskFinished: (payload: { title?: string; body?: string; notify?: boolean }) => Promise<Result<{ shown: boolean }>>;
};

type WindowWithBridges = Window & {
  coworkerUi?: CoworkerUiBridge;
  coworkerWidget?: { closeChat?: () => void; openChat?: () => void };
  coworkerAdmin?: { cancel?: () => Promise<unknown> };
  connectDesktop?: { isDesktop?: boolean; windowKind?: string; window?: { openFull?: (route?: string) => Promise<unknown> } };
};

function win(): WindowWithBridges | null {
  return typeof window === "undefined" ? null : (window as WindowWithBridges);
}

export function coworkerUi(): CoworkerUiBridge | null {
  const w = win();
  const b = w?.coworkerUi;
  return b && typeof b.state === "function" ? b : null;
}

export function isDesktopApp(): boolean {
  return !!win()?.connectDesktop?.isDesktop;
}

/** The bubble's popover window (not the main app window). */
export function isBubbleWindow(): boolean {
  return win()?.connectDesktop?.windowKind === "coworker-chat";
}

export function closeBubble(): void {
  try { win()?.coworkerWidget?.closeChat?.(); } catch { /* not in the popover */ }
}

/** Stop everything running on the computer for this person, not just this turn's calls. */
export function cancelOnComputer(): void {
  try { void win()?.coworkerAdmin?.cancel?.(); } catch { /* not in the app */ }
}

export async function readDesktopState(): Promise<DesktopCoworkerState | null> {
  const b = coworkerUi();
  if (!b) return null;
  try {
    const s = await b.state();
    return s && s.ok ? (s as DesktopCoworkerState) : null;
  } catch {
    return null;
  }
}

export function accessLabel(p: AccessProfile | null | undefined): string {
  switch (p) {
    case "AUTONOMOUS": return "Full access";
    case "TRUSTED": return "Only asks for big things";
    default: return "Asks before changes";
  }
}
