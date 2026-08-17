// ─── Email template helpers ──────────────────────────────────────────────────
// All templates return { subject, html, text }.
// Designs target Gmail, Apple Mail, and modern web clients.
// Table-based layout for broad compatibility.

function esc(value: string | null | undefined): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function preheader(text: string): string {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#f8fafc;">${esc(text)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`;
}

function shell(opts: {
  preheaderText?: string;
  headerTitle: string;
  headerSubtitle?: string;
  body: string;
}): string {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <title>${esc(opts.headerTitle)}</title>
</head>
<body style="margin:0;padding:0;background:#eef2ff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
${opts.preheaderText ? preheader(opts.preheaderText) : ""}
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background:linear-gradient(160deg,#eef2ff 0%,#dde7ff 100%);min-height:100vh;">
  <tr>
    <td align="center" style="padding:44px 16px 48px;">

      <!-- Brand label above card -->
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;margin-bottom:18px;">
        <tr>
          <td align="center">
            <span style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#6366f1;font-weight:800;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;">Connect Communications</span>
          </td>
        </tr>
      </table>

      <!-- Card -->
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(99,102,241,0.12),0 4px 20px rgba(0,0,0,0.07);">

        <!-- Card header -->
        <tr>
          <td style="padding:40px 44px 34px;background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 55%,#0891b2 100%);">
            <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.55);font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;">Connect Communications</p>
            <h1 style="margin:0;font-size:27px;line-height:1.25;color:#ffffff;font-weight:800;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;">${esc(opts.headerTitle)}</h1>
            ${opts.headerSubtitle ? `<p style="margin:9px 0 0;font-size:15px;color:rgba(255,255,255,0.72);font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;">${esc(opts.headerSubtitle)}</p>` : ""}
          </td>
        </tr>

        <!-- Card body -->
        <tr>
          <td style="padding:38px 44px 32px;color:#374151;font-size:15px;line-height:1.75;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;">
            ${opts.body}
          </td>
        </tr>

        <!-- Card footer -->
        <tr>
          <td style="padding:18px 44px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11.5px;color:#9ca3af;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;">
              © ${year} Connect Communications · All rights reserved.<br>
              This email was sent on behalf of your organization.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ─── LoopCom shell ────────────────────────────────────────────────────────────
// Used by the invite email. The other templates below still use `shell()` above;
// they are deliberately unchanged until their redesign is approved.

/**
 * Absolute URL of the LoopCom wordmark for emails.
 *
 * ⛔ Resolved HERE, from the environment at CALL time — never passed in by the
 * caller. TWO paths queue the invite email (server.ts admin invites and
 * onboarding/setupOrchestrator.ts sign-ups) and passing this as an input is
 * exactly how the Android APK link went missing from every self-service sign-up
 * while admin invites still had it. Neither caller can forget what it never
 * supplies.
 *
 * ⛔ Email clients cannot read a relative path or a data: URI — this must stay an
 * absolute https URL to a publicly reachable file.
 */
export function brandLogoUrl(): string {
  const origin = String(
    process.env.PORTAL_PUBLIC_URL
    || process.env.CONNECT_APP_URL
    || process.env.APP_PUBLIC_URL
    || "https://app.connectcomunications.com"
  ).replace(/\/+$/, "");
  // ⛔ The EMAIL asset, not the portal one. Mail clients refetch this every time
  // a message is opened, and the email renders it at 168px — the 560px portal
  // file was 81 KB for no visible gain. This is 336px (a true 2x) at 34 KB,
  // same pixels, just not three times more than anyone sees.
  // ⛔ Do NOT swap in a colour-quantised version to shrink it further: those
  // top out at alpha 253, so the logo renders faintly translucent — the wrong
  // direction on a white background where it already reads soft.
  return `${origin}/brand/loopcom/loopcom-wordmark-email-336.png`;
}

/**
 * Light-only email shell in the LoopCom theme.
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
export function loopComShell(opts: {
  preheaderText?: string;
  headerTitle: string;
  headerSubtitle?: string;
  body: string;
}): string {
  const year = new Date().getFullYear();
  const font = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
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
${opts.preheaderText ? preheader(opts.preheaderText) : ""}
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f1f4f8" style="background:#f1f4f8;">
  <tr>
    <td align="center" style="padding:34px 14px 42px;">

      <!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600"><tr><td><![endif]-->
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" class="lc-card" bgcolor="#ffffff" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;">

        <!-- Logo, on the card. One asset, no dark plate, no tagline. -->
        <tr>
          <td align="center" class="lc-pad" style="padding:32px 44px 20px;">
            <img src="${esc(brandLogoUrl())}" alt="Loopcom" width="168" height="30" class="lc-logo"
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
              This email was sent on behalf of your organization.
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

/** Brand-blue CTA. Gradient over a solid bgcolor so Outlook degrades to flat. */
function lcCtaButton(label: string, url: string): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" class="lc-btn" style="margin:30px 0 4px;">
  <tr>
    <td align="center" bgcolor="#22a8ff" style="border-radius:10px;background:#22a8ff;background-image:linear-gradient(135deg,#22a8ff,#4f7bff);">
      <a href="${esc(url)}" target="_blank" style="display:inline-block;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:15px 30px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.01em;">${esc(label)}</a>
    </td>
  </tr>
</table>`;
}

/** Outlined secondary CTA (the Android download). */
function lcSecondaryButton(label: string, url: string): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" class="lc-btn" style="margin:14px 0 4px;">
  <tr>
    <td align="center" bgcolor="#ffffff" style="border:1.5px solid #22a8ff;border-radius:10px;background:#ffffff;">
      <a href="${esc(url)}" target="_blank" style="display:inline-block;color:#0b6fc4;text-decoration:none;font-weight:700;font-size:14px;padding:13px 26px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.01em;">${esc(label)}</a>
    </td>
  </tr>
</table>`;
}

/** Info badges with the brand accent rail. */
function lcBadges(badges: Array<{ label: string; value: string }>): string {
  if (!badges.length) return "";
  const font = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
  const rows = badges.map(
    (b) => `<tr>
      <td style="padding:4px 0;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0">
          <tr>
            <td bgcolor="#f1f5f9" style="padding:9px 14px;background:#f1f5f9;border-radius:8px;border-left:3px solid #22a8ff;">
              <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.09em;color:#6b7280;font-family:${font};">${esc(b.label)}&nbsp; </span><span style="font-size:14px;font-weight:600;color:#1e293b;font-family:${font};">${esc(b.value)}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
  );
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:20px 0 24px;">
  ${rows.join("\n")}
</table>`;
}

function ctaButton(label: string, url: string, color = "#2563eb"): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:30px 0 4px;">
  <tr>
    <td align="left" bgcolor="${color}" style="border-radius:10px;">
      <a href="${esc(url)}" target="_blank" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:15px 30px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:0.01em;">${esc(label)}</a>
    </td>
  </tr>
</table>`;
}

function secondaryCtaButton(label: string, url: string): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:14px 0 4px;">
  <tr>
    <td align="left" style="border:1.5px solid #2563eb;border-radius:10px;background:#ffffff;">
      <a href="${esc(url)}" target="_blank" style="display:inline-block;color:#2563eb;text-decoration:none;font-weight:700;font-size:14px;padding:13px 26px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:0.01em;">${esc(label)}</a>
    </td>
  </tr>
</table>`;
}

function infoBadgesTable(badges: Array<{ label: string; value: string }>): string {
  if (!badges.length) return "";
  const rows = badges.map(
    (b) => `<tr>
      <td style="padding:4px 0;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:9px 14px;background:#f1f5f9;border-radius:8px;border-left:3px solid #2563eb;">
              <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.09em;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;">${esc(b.label)}&nbsp; </span><span style="font-size:14px;font-weight:600;color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;">${esc(b.value)}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
  );
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:20px 0 24px;">
  ${rows.join("\n")}
</table>`;
}

function divider(): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0;">
  <tr><td style="border-top:1px solid #e5e7eb;font-size:0;">&nbsp;</td></tr>
</table>`;
}

// ─── Email 1: User Invite / Create Password ───────────────────────────────────

export function welcomeCreatePasswordEmail(input: {
  userName: string;
  userFirstName?: string | null;
  tenantName: string;
  extensionNumber?: string | null;
  setupUrl: string;
  expiresHours: number;
  androidApkUrl?: string | null;
}): { subject: string; html: string; text: string } {
  const firstName = (input.userFirstName || input.userName.split(" ")[0] || "there").trim();
  const badges: Array<{ label: string; value: string }> = [{ label: "Organization", value: input.tenantName }];
  if (input.extensionNumber) badges.push({ label: "Extension", value: input.extensionNumber });

  const androidSection = input.androidApkUrl
    ? `
${divider()}

<p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#1e293b;">Loopcom Mobile (Android)</p>
<p style="margin:0 0 4px;color:#64748b;font-size:14px;">After you create your password, install the Loopcom app to receive calls, voicemail, and mobile features. Use the button below — it opens our secure download page with the latest APK.</p>

${lcSecondaryButton("Download Loopcom for Android", input.androidApkUrl)}

<p style="margin:8px 0 0;font-size:12px;color:#94a3b8;">Android may ask you to allow installs from this source the first time.</p>
`
    : "";

  const body = `
<p style="margin:0 0 18px;font-size:17px;font-weight:600;color:#1e293b;">Hi ${esc(firstName)},</p>
<p style="margin:0 0 18px;">You've been invited to join <strong>${esc(input.tenantName)}</strong> on Loopcom.</p>
<p style="margin:0 0 20px;color:#64748b;">Your account is ready. Create a password to get started — it only takes a moment.</p>

${lcBadges(badges)}

${lcCtaButton("Create Your Password", input.setupUrl)}

<p style="margin:20px 0 0;font-size:13px;color:#94a3b8;">This one-time link expires in <strong>${input.expiresHours} hours</strong>. After that you can request a new invite from your administrator.</p>

${androidSection}

${divider()}

<p style="margin:0;font-size:13px;color:#94a3b8;">If you were not expecting this invite, you can safely ignore this email. No account will be created without your action.</p>`;

  const text = [
    `Welcome to Loopcom`,
    ``,
    `Hi ${firstName},`,
    ``,
    `You've been invited to join ${input.tenantName} on Loopcom.`,
    ...(input.extensionNumber ? [`Extension: ${input.extensionNumber}`] : []),
    ``,
    `Create your password: ${input.setupUrl}`,
    ``,
    `This one-time link expires in ${input.expiresHours} hours.`,
    ``,
    ...(input.androidApkUrl
      ? [
          `Loopcom Mobile (Android):`,
          `After creating your password, install the app from:`,
          input.androidApkUrl,
          `(Opens the Loopcom download page with the latest APK. Android may ask you to allow installs from this source the first time.)`,
          ``,
        ]
      : []),
    `If you were not expecting this invite, you can safely ignore this email.`,
  ].join("\n");

  return {
    subject: `Welcome to Loopcom — Create Your Password`,
    html: loopComShell({
      preheaderText: `Hi ${firstName}, your Loopcom account at ${input.tenantName} is ready. Create your password to get started.`,
      headerTitle: "You're Invited",
      headerSubtitle: `Welcome to ${input.tenantName}`,
      body,
    }),
    text,
  };
}

// ─── Email 2: Password Created Confirmation ───────────────────────────────────

export function passwordCreatedConfirmationEmail(input: {
  userName: string;
  userFirstName?: string | null;
  tenantName: string;
  extensionNumber?: string | null;
  loginUrl: string;
}): { subject: string; html: string; text: string } {
  const firstName = (input.userFirstName || input.userName.split(" ")[0] || "there").trim();
  const badges: Array<{ label: string; value: string }> = [{ label: "Organization", value: input.tenantName }];
  if (input.extensionNumber) badges.push({ label: "Extension", value: input.extensionNumber });

  const body = `
<p style="margin:0 0 18px;font-size:17px;font-weight:600;color:#1e293b;">Hi ${esc(firstName)},</p>
<p style="margin:0 0 18px;">Your <strong>Connect Communications</strong> account at <strong>${esc(input.tenantName)}</strong> is now active.</p>
<p style="margin:0 0 20px;color:#64748b;">Your password has been created and you can now sign in and start using Connect.</p>

${infoBadgesTable(badges)}

${ctaButton("Log In to Connect", input.loginUrl, "#059669")}

${divider()}

<p style="margin:0;font-size:13px;color:#94a3b8;">If you did not create this account or set this password, contact your administrator immediately.</p>`;

  const text = [
    `Your Connect Communications account is ready`,
    ``,
    `Hi ${firstName},`,
    ``,
    `Your account at ${input.tenantName} is now active.`,
    ...(input.extensionNumber ? [`Extension: ${input.extensionNumber}`] : []),
    ``,
    `Log in here: ${input.loginUrl}`,
    ``,
    `If you did not set this password, contact your administrator immediately.`,
  ].join("\n");

  return {
    subject: `Your Connect Communications account is ready`,
    html: shell({
      preheaderText: `Your account at ${input.tenantName} is active. Log in to Connect Communications.`,
      headerTitle: "Your Account Is Ready",
      headerSubtitle: `Welcome aboard, ${firstName}`,
      body,
    }),
    text,
  };
}

// ─── Email 3: Password Reset ──────────────────────────────────────────────────

export function passwordResetEmail(input: {
  userName: string;
  resetUrl: string;
  expiresMinutes: number;
}): { subject: string; html: string; text: string } {
  const firstName = input.userName.split(" ")[0] || "there";
  const body = `
<p style="margin:0 0 18px;font-size:17px;font-weight:600;color:#1e293b;">Hi ${esc(firstName)},</p>
<p style="margin:0 0 18px;">We received a request to reset your <strong>Connect Communications</strong> password.</p>
<p style="margin:0 0 20px;color:#64748b;">Click the button below to choose a new password. This link is single-use and expires in ${input.expiresMinutes} minutes.</p>

${ctaButton("Reset Password", input.resetUrl, "#7c3aed")}

${divider()}

<p style="margin:0;font-size:13px;color:#94a3b8;">If you did not request a password reset, no action is needed. Your password will remain unchanged.</p>`;

  const text = [
    `Reset your Connect Communications password`,
    ``,
    `Hi ${firstName},`,
    ``,
    `Click the link below to reset your password. This link expires in ${input.expiresMinutes} minutes.`,
    ``,
    `Reset link: ${input.resetUrl}`,
    ``,
    `If you did not request this, no action is needed.`,
  ].join("\n");

  return {
    subject: `Reset your Connect Communications password`,
    html: shell({
      preheaderText: `Reset your Connect Communications password. This link expires in ${input.expiresMinutes} minutes.`,
      headerTitle: "Reset Your Password",
      body,
    }),
    text,
  };
}

// ─── Email 4: Password Changed Notification ───────────────────────────────────

export function passwordChangedEmail(input: {
  userName: string;
}): { subject: string; html: string; text: string } {
  const firstName = input.userName.split(" ")[0] || "there";
  const body = `
<p style="margin:0 0 18px;font-size:17px;font-weight:600;color:#1e293b;">Hi ${esc(firstName)},</p>
<p style="margin:0 0 18px;">Your <strong>Connect Communications</strong> password was changed successfully.</p>
<p style="margin:0 0 20px;color:#64748b;">If you made this change, no further action is needed.</p>

${divider()}

<p style="margin:0;font-size:13px;color:#ef4444;font-weight:500;">If you did not change your password, contact your administrator immediately.</p>`;

  return {
    subject: `Your Connect Communications password was changed`,
    html: shell({
      preheaderText: `Your Connect Communications password was changed. If this wasn't you, contact your administrator.`,
      headerTitle: "Password Changed",
      body,
    }),
    text: `Your Connect Communications password was changed successfully.\n\nIf this was not you, contact your administrator immediately.`,
  };
}
