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

function ctaButton(label: string, url: string, color = "#2563eb"): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:30px 0 4px;">
  <tr>
    <td align="left" bgcolor="${color}" style="border-radius:10px;">
      <a href="${esc(url)}" target="_blank" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:15px 30px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:0.01em;">${esc(label)}</a>
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
}): { subject: string; html: string; text: string } {
  const firstName = (input.userFirstName || input.userName.split(" ")[0] || "there").trim();
  const badges: Array<{ label: string; value: string }> = [{ label: "Organization", value: input.tenantName }];
  if (input.extensionNumber) badges.push({ label: "Extension", value: input.extensionNumber });

  const body = `
<p style="margin:0 0 18px;font-size:17px;font-weight:600;color:#1e293b;">Hi ${esc(firstName)},</p>
<p style="margin:0 0 18px;">You've been invited to join <strong>${esc(input.tenantName)}</strong> on Connect Communications.</p>
<p style="margin:0 0 20px;color:#64748b;">Your account is ready. Create a password to get started — it only takes a moment.</p>

${infoBadgesTable(badges)}

${ctaButton("Create Your Password", input.setupUrl)}

<p style="margin:20px 0 0;font-size:13px;color:#94a3b8;">This one-time link expires in <strong>${input.expiresHours} hours</strong>. After that you can request a new invite from your administrator.</p>

${divider()}

<p style="margin:0;font-size:13px;color:#94a3b8;">If you were not expecting this invite, you can safely ignore this email. No account will be created without your action.</p>`;

  const text = [
    `Welcome to Connect Communications`,
    ``,
    `Hi ${firstName},`,
    ``,
    `You've been invited to join ${input.tenantName} on Connect Communications.`,
    ...(input.extensionNumber ? [`Extension: ${input.extensionNumber}`] : []),
    ``,
    `Create your password: ${input.setupUrl}`,
    ``,
    `This one-time link expires in ${input.expiresHours} hours.`,
    ``,
    `If you were not expecting this invite, you can safely ignore this email.`,
  ].join("\n");

  return {
    subject: `Welcome to Connect Communications — Create Your Password`,
    html: shell({
      preheaderText: `Hi ${firstName}, your Connect Communications account at ${input.tenantName} is ready. Create your password to get started.`,
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
