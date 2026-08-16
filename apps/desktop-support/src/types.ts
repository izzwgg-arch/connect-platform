/**
 * Types for the Loopcom Support app.
 *
 * ⛔ This is a SEPARATE application from the Connect desktop app on purpose. It
 * installs alongside it, keeps its own settings folder, and has no auto-updater.
 * Nothing here is shared with `apps/desktop` — a change made here cannot reach a
 * customer's phone system, which is the entire point of the split.
 */

/** A screen or window the customer could share. */
export type DesktopScreenSource = {
  id: string;
  name: string;
  /** data: URI of a still, so the customer sees what they are about to share. */
  thumbnailDataUrl: string;
  isScreen: boolean;
};

/** What the machine says about itself, stamped onto the session for the audit row. */
export type DesktopMachineInfo = {
  hostname: string;
  platform: string;
  release: string;
  appVersion: string;
  username: string;
};

export type RemoteSupportBannerState = {
  visible: boolean;
  supportName?: string;
  controlGranted?: boolean;
};

export type LanScanHost = {
  ip: string;
  mac: string;
  respondedOnHttp?: boolean;
};

export type LanScanOutcome = {
  subnet: string | null;
  hostsSeen: number;
  hosts: LanScanHost[];
  outcome: "ok" | "partial" | "failed";
  note?: string;
};
