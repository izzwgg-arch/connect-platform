/**
 * The interface the runtime talks to for screen control — PURE (no Electron), so
 * the runtime and its tests never import a display. The real implementation is
 * `screenController.ts` (Electron: desktopCapturer, the SendInput helper, UI
 * Automation, the overlay windows); tests pass a fake of this shape.
 *
 * ⛔ The runtime is still the security boundary. This interface only ACTS once the
 * runtime's policy gate and the ask-once session rule (see session.ts) have said
 * yes. Nothing here re-decides policy.
 */
import type { ScreenActionName, ScreenControlSession } from "./session";

export type ScreenActionResult = {
  ok: boolean;
  error?: string;
  message?: string;
  [k: string]: unknown;
};

export interface ScreenController {
  /** The pure session the runtime reads for the ask-once gate. */
  readonly session: ScreenControlSession;
  /** The per-machine opt-in ("Let the Coworker control the screen"). Default off. */
  isEnabled(): boolean;
  /** True when this exact task holds an open, approved control session. */
  isApprovedFor(taskId: string): boolean;

  /** Open control after the approval landed: raise the overlay, arm Escape + yield. */
  begin(taskId: string, reason: string, signal: AbortSignal): Promise<ScreenActionResult & { display?: { width: number; height: number } }>;
  /** UI Automation snapshot of the foreground window's controls (buttons-first eyes). */
  read(taskId: string, args: Record<string, unknown>): Promise<ScreenActionResult>;
  /** One click/type/key/scroll/move — target-first (no cursor) or x/y fallback. */
  act(taskId: string, name: ScreenActionName, args: Record<string, unknown>): Promise<ScreenActionResult>;
  /** Save a PNG of the screen into the workspace (record; not model vision). */
  capture(taskId: string, saveAs: string | undefined): Promise<ScreenActionResult & { path?: string }>;
  /** Stop controlling: drop the overlay, disarm Escape + yield. Always safe. */
  end(taskId: string): Promise<ScreenActionResult>;
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
