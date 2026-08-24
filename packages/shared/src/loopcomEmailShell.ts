/**
 * THE Loopcom email shell — one place decides what a Loopcom email looks like.
 *
 * ⛔ This file is the ONLY definition of that look. It was lifted verbatim out of
 * `apps/api/src/userEmailTemplates.ts` (where it was born 2026-08-16) so that
 * `apps/agent` can use the same one instead of carrying a second copy. The api
 * still exposes `loopComShell()` as a thin wrapper, so every existing api caller
 * is untouched and its output is byte-identical.
 *
 * ⛔⛔ THE LOGO URL IS A REQUIRED PARAMETER HERE, AND THAT IS NOT A LICENCE FOR
 * CALLERS TO PASS IT. Each app supplies it in exactly ONE wrapper
 * (`loopComShell` in apps/api, `loopcomShellForAgent` in apps/agent), resolved
 * from that app's own environment at call time. The email BUILDERS never see it.
 * The rule this protects is recorded on `brandLogoUrl()` in apps/api: TWO paths
 * queue the invite email, and making the logo an input of the builder is exactly
 * how the Android APK link went missing from every self-service sign-up while
 * admin invites still had it. A shared package cannot read an app's env, so the
 * parameter stops at the wrapper — never let it climb any higher.
 *
 * Built to render on phones, desktop webmail AND Outlook's Word engine, which
 * means every one of these is deliberate — do not "modernise" them away:
 *   - tables + inline styles only; Outlook ignores <style> for layout
 *   - an mso conditional wrapper gives Outlook a fixed 600px table, because it
 *     does not support max-width and would otherwise render full-bleed
 *   - every gradient sits on top of a solid `bgcolor` attribute, so Outlook
 *     degrades to flat brand blue instead of to nothing
 *   - the <style> block carries ONLY the mobile media query, which is an
 *     enhancement; the email is already correct without it
 *   - color-scheme meta pins light, since the design is light by default.
 *     ⛔ This is a request, not a guarantee: Gmail and Apple Mail may still
 *     auto-invert on a phone and no sender can prevent that.
 */

export const LOOPCOM_EMAIL_FONT =
  `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export function escapeEmailHtml(value: string | null | undefined): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function emailPreheader(text: string): string {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#f8fafc;">${escapeEmailHtml(text)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`;
}

export interface LoopcomEmailShellOptions {
  preheaderText?: string;
  headerTitle: string;
  headerSubtitle?: string;
  body: string;
  /** Absolute https URL of the wordmark. Supplied by the app's ONE wrapper. */
  logoUrl: string;
  /**
   * The customer company this email is FOR — their tenant name, printed in the
   * footer as "This email was sent on behalf of <name>."
   *
   * ⛔ OPTIONAL, AND THE FALLBACK IS THE POINT. Omitted, blank or whitespace and
   * the footer says the generic "your organization" exactly as it always has, so
   * a caller that genuinely cannot name the tenant degrades to the old wording
   * instead of printing an empty sentence or, far worse, guessing a name. Never
   * make this required and never invent a value for it — an email that names the
   * WRONG company is worse than one that names none.
   */
  organizationName?: string | null;
  /** Injectable only so tests can pin the footer year. */
  year?: number;
}

export function loopcomEmailShell(opts: LoopcomEmailShellOptions): string {
  const year = opts.year ?? new Date().getFullYear();
  const esc = escapeEmailHtml;
  const font = LOOPCOM_EMAIL_FONT;
  // Trimmed, so a tenant row holding "" or "   " reads as "no name given"
  // rather than rendering "sent on behalf of ." at the bottom of the email.
  const org = String(opts.organizationName || "").trim();
  const onBehalfOf = org ? esc(org) : "your organization";
  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${esc(opts.headerTitle)}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    @media only screen and (max-width:620px) {
      .lc-card { width:100% !important; }
      .lc-pad { padding-left:22px !important; padding-right:22px !important; }
      .lc-h1 { font-size:22px !important; }
      .lc-logo { width:142px !important; height:auto !important; }
      .lc-btn a { display:block !important; text-align:center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f1f4f8;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
${opts.preheaderText ? emailPreheader(opts.preheaderText) : ""}
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f1f4f8" style="background:#f1f4f8;">
  <tr>
    <td align="center" style="padding:34px 14px 42px;">

      <!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600"><tr><td><![endif]-->
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" class="lc-card" bgcolor="#ffffff" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;">

        <!-- Logo, on the card. One asset, no dark plate, no tagline. -->
        <tr>
          <td align="center" class="lc-pad" style="padding:32px 44px 20px;">
            <img src="${esc(opts.logoUrl)}" alt="Loopcom" width="168" height="30" class="lc-logo"
                 style="display:block;border:0;outline:none;text-decoration:none;width:168px;height:30px;color:#0f172a;font-family:${font};font-size:19px;font-weight:700;letter-spacing:-.02em;">
          </td>
        </tr>

        <!-- Accent rule -->
        <tr>
          <td class="lc-pad" style="padding:0 44px;">
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr><td height="2" bgcolor="#22a8ff" style="height:2px;line-height:2px;font-size:0;background:#22a8ff;background-image:linear-gradient(90deg,#22a8ff,#4f7bff);">&nbsp;</td></tr>
            </table>
          </td>
        </tr>

        <!-- Title -->
        <tr>
          <td class="lc-pad" style="padding:26px 44px 0;">
            <h1 class="lc-h1" style="margin:0;font-size:26px;line-height:1.25;color:#0f172a;font-weight:800;font-family:${font};mso-line-height-rule:exactly;">${esc(opts.headerTitle)}</h1>
            ${opts.headerSubtitle ? `<p style="margin:8px 0 0;font-size:15px;color:#64748b;font-family:${font};">${esc(opts.headerSubtitle)}</p>` : ""}
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td class="lc-pad" style="padding:22px 44px 30px;color:#374151;font-size:15px;line-height:1.75;font-family:${font};mso-line-height-rule:exactly;">
            ${opts.body}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td class="lc-pad" bgcolor="#f8fafc" style="padding:18px 44px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11.5px;color:#9ca3af;line-height:1.6;font-family:${font};">
              &copy; ${year} Loopcom &middot; All rights reserved.<br>
              This email was sent on behalf of ${onBehalfOf}.
            </p>
          </td>
        </tr>

      </table>
      <!--[if mso]></td></tr></table><![endif]-->

    </td>
  </tr>
</table>
</body>
</html>`;
}
