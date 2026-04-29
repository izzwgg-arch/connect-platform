function esc(value: string | null | undefined): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  </head>
  <body style="margin:0;background:#eef3fb;color:#0f172a;font-family:Inter,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#eef3fb;">
      <tr><td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #dbe5f2;border-radius:22px;overflow:hidden;box-shadow:0 24px 70px rgba(15,23,42,.12);">
          <tr><td style="padding:30px 34px;background:linear-gradient(135deg,#0f172a,#1e3a8a);">
            <div style="font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#93c5fd;font-weight:800;">Connect Communications</div>
            <h1 style="margin:10px 0 0;font-size:28px;line-height:1.2;color:#fff;">${esc(title)}</h1>
          </td></tr>
          <tr><td style="padding:30px 34px;color:#334155;font-size:15px;line-height:1.65;">${body}</td></tr>
          <tr><td style="padding:18px 34px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.5;">
            This email was sent by Connect Communications. If you did not expect it, you can ignore it.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function cta(label: string, url: string): string {
  return `<p style="margin:26px 0;"><a href="${esc(url)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;padding:13px 20px;border-radius:999px;">${esc(label)}</a></p>`;
}

export function welcomeCreatePasswordEmail(input: {
  userName: string;
  tenantName: string;
  extensionNumber?: string | null;
  setupUrl: string;
  expiresHours: number;
}): { subject: string; html: string; text: string } {
  const extension = input.extensionNumber ? `<li><strong>Extension:</strong> ${esc(input.extensionNumber)}</li>` : "";
  const body = `
    <p>Hi ${esc(input.userName)},</p>
    <p>Your Connect Communications account for <strong>${esc(input.tenantName)}</strong> is ready.</p>
    <ul style="padding-left:18px;margin:18px 0;color:#475569;">
      ${extension}
      <li>Use the button below to create your password and sign in.</li>
    </ul>
    ${cta("Create Your Password", input.setupUrl)}
    <p style="color:#64748b;font-size:13px;">This one-time setup link expires in ${input.expiresHours} hours.</p>
  `;
  const text = `Welcome to Connect Communications\n\nHi ${input.userName}, your account for ${input.tenantName} is ready.${input.extensionNumber ? `\nExtension: ${input.extensionNumber}` : ""}\nCreate your password: ${input.setupUrl}\nThis one-time link expires in ${input.expiresHours} hours.`;
  return { subject: "Welcome to Connect Communications", html: shell("Welcome to Connect", body), text };
}

export function passwordResetEmail(input: {
  userName: string;
  resetUrl: string;
  expiresMinutes: number;
}): { subject: string; html: string; text: string } {
  const body = `
    <p>Hi ${esc(input.userName)},</p>
    <p>We received a request to reset your Connect Communications password.</p>
    ${cta("Reset Password", input.resetUrl)}
    <p style="color:#64748b;font-size:13px;">This one-time link expires in ${input.expiresMinutes} minutes. If you did not request this, no action is needed.</p>
  `;
  const text = `Reset your Connect Communications password\n\nReset link: ${input.resetUrl}\nThis one-time link expires in ${input.expiresMinutes} minutes.`;
  return { subject: "Reset your Connect Communications password", html: shell("Reset Your Password", body), text };
}

export function passwordChangedEmail(input: { userName: string }): { subject: string; html: string; text: string } {
  const body = `
    <p>Hi ${esc(input.userName)},</p>
    <p>Your Connect Communications password was changed successfully.</p>
    <p style="color:#64748b;font-size:13px;">If this was not you, contact your administrator immediately.</p>
  `;
  return {
    subject: "Your Connect Communications password was changed",
    html: shell("Password Changed", body),
    text: "Your Connect Communications password was changed. If this was not you, contact your administrator immediately.",
  };
}
