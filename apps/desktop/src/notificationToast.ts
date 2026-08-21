/**
 * The Windows toast XML for a desktop notification.
 *
 * ⛔ WHY THIS EXISTS AS ITS OWN MODULE, importing nothing from electron: so the
 * exact string the app ships can be handed to Windows' own toast parser in a
 * probe, and asserted in a unit test, without booting Electron. A toast that
 * Windows refuses never appears at all and logs nothing — the failure mode is a
 * customer silently no longer being told about voicemail — so "does Windows
 * accept this XML" has to be answerable outside the app.
 *
 * ⛔ THE BUG THIS REPLACES. Electron's default Windows notification takes the
 * `icon` option and renders it as the toast's INLINE image — a full-width
 * picture filling the body of the popup. Passing a 512px app icon there is what
 * produced the oversized icon on every voicemail notification. There is no
 * Electron option to shrink it: the ONLY way to get the standard Windows layout
 * is to hand Windows the toast XML directly, which is what `toastXml` is for.
 * It supersedes `title`, `body` and `icon` entirely on Windows, so those must
 * not also be passed.
 */

export type DesktopNotificationPayload = {
  kind: string;
  title: string;
  body?: string;
  route?: string;
};

/** Toast text is user data — caller names, message previews, company names. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Text only — deliberately NO `<image>` element of any kind.
 *
 * ⛔⛔ DO NOT ADD ONE BACK, IN ANY PLACEMENT. Windows already draws the app's
 * logo small in the toast's HEADER row, beside the app name, and that is the
 * layout every well-behaved app has (Claude, Slack, Teams, Outlook — Izzy
 * pointed at Claude's own toast as the reference on 2026-08-21). Adding an
 * `<image>` puts a SECOND copy of the same logo in the body:
 *
 *   - `placement="appLogoOverride"` renders a ~64px square left of the text;
 *   - `placement="hero"` or a bare `<image>` renders it full-width.
 *
 * Both were rejected. `appLogoOverride` was tried first and shown to Izzy, who
 * called it "that big-ass icon" — it is the thing this pass was asked to remove,
 * so re-adding it is a regression, not an improvement.
 *
 * ⛔ Dropping the image also removes a trap: `assets/` is packed INSIDE
 * `app.asar`, and Windows' toast renderer is a separate OS process that cannot
 * read inside an asar archive. `fs.existsSync` answers TRUE for such a path
 * (Electron shims fs for the app's own process), so the image would simply not
 * render in the shipped build while looking perfectly fine in development.
 *
 * ⛔ THE HEADER ICON AND NAME ARE NOT SET HERE AND CANNOT BE. Windows reads both
 * from the Start Menu shortcut carrying the app's AppUserModelID: the name is
 * `nsis.shortcutName` and the icon is the shortcut's target executable's own
 * embedded icon. That is precisely why `signAndEditExecutable` must stay true —
 * with it false the exe kept Electron's atom, and the atom is what showed in
 * this toast's header.
 */
export function buildWindowsToastXml(payload: DesktopNotificationPayload): string {
  const body = (payload.body || "").trim();
  return [
    "<toast>",
    "<visual>",
    '<binding template="ToastGeneric">',
    `<text>${escapeXml(payload.title)}</text>`,
    body ? `<text>${escapeXml(body)}</text>` : "",
    "</binding>",
    "</visual>",
    "</toast>",
  ].join("");
}
