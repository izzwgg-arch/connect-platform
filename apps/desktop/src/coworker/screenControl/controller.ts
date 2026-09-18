/**
 * The interface the runtime talks to for screen control — PURE (no Electron), so
 * the runtime and its tests never import a display. The real implementation is
 * `screenController.ts` (Electron overlay + the Local Worker: UI Automation, the
 * signature-stamped SendInput, the yield/Escape hook, capture); tests pass a fake
 * of this shape.
 *
 * ⛔ The runtime is still the security boundary. This interface only ACTS once the
 * runtime's policy gate and the ask-once session rule (see session.ts) have said
 * yes. Nothing here re-decides policy.
 */
import type { ScreenActionName, ScreenControlSession } from "./session";
import type { WindowsToolName } from "../computerControl/windowsControl";

export type ScreenActionResult = {
  ok: boolean;
  error?: string;
  message?: string;
  [k: string]: unknown;
};

export interface ScreenController {
  /** The pure session the runtime reads for the ask-once gate. */
  readonly session: ScreenControlSession;
  /** The per-machine opt-in ("Let the Coworker control the screen"). Default on since 2026-09-18; the tray can turn it off. */
  isEnabled(): boolean;
  /** True when this exact task holds an open, approved control session. */
  isApprovedFor(taskId: string): boolean;

  /** Open control after the approval landed: raise the overlay, arm Escape + yield. */
  begin(taskId: string, reason: string, signal: AbortSignal): Promise<ScreenActionResult & { display?: { width: number; height: number } }>;
  /** UI Automation snapshot of a window's controls (buttons-first eyes). Default: the foreground window. */
  read(taskId: string, args: Record<string, unknown>): Promise<ScreenActionResult>;
  /** A downscaled screenshot the MODEL can see — `{ image: { mediaType, dataBase64, width, height } }`. `args.window` / `args.region` narrow it. */
  look(taskId: string, args?: Record<string, unknown>): Promise<ScreenActionResult & { image?: { mediaType: string; dataBase64: string; width: number; height: number } }>;
  /** One click/type/key/scroll/move — target-first (no cursor) or x/y fallback. */
  act(taskId: string, name: ScreenActionName, args: Record<string, unknown>): Promise<ScreenActionResult>;
  /** Save a PNG of the screen into the workspace (record; not model vision). */
  capture(taskId: string, saveAs: string | undefined): Promise<ScreenActionResult & { path?: string }>;
  /** The semantic Windows actions (computer_windows_* / app launch / process kill). Absent on a controller without a worker. */
  windows?(taskId: string, name: WindowsToolName, args: Record<string, unknown>): Promise<ScreenActionResult>;
  /** Stop controlling: drop the overlay, disarm Escape + yield. Always safe. */
  end(taskId: string, reason?: string): Promise<ScreenActionResult>;
  /** Health of the underlying worker, for diagnostics. */
  health?(): Promise<Record<string, unknown>>;
}

/** A separate optional capability: run one PowerShell script elevated (UAC). */
export type ElevatedShellResult = {
  ok: boolean;
  error?: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
};
export type RunElevatedPowerShell = (
  script: string,
  opts: { timeoutSec?: number; signal: AbortSignal },
) => Promise<ElevatedShellResult>;

export type { ScreenActionName };
