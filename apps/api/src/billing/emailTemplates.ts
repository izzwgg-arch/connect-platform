export function money(cents: number): string {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#0b1220;color:#e5edf7;font-family:Inter,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#0b1220;">
      <tr><td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#111a2e;border:1px solid #24324d;border-radius:20px;overflow:hidden;">
          <tr><td style="padding:28px 32px;border-bottom:1px solid #24324d;">
            <div style="font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#7dd3fc;">ConnectComms</div>
            <h1 style="margin:8px 0 0;font-size:26px;line-height:1.2;color:#fff;">${title}</h1>
          </td></tr>
          <tr><td style="padding:28px 32px;color:#d7e3f4;font-size:15px;line-height:1.65;">${body}</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function invoiceReadyEmail(input: { invoiceNumber: string; totalCents: number; dueDate: Date; invoiceUrl: string }): { subject: string; html: string; text: string } {
  const subject = `Your ConnectComms invoice ${input.invoiceNumber} is ready`;
  const body = `
    <p>Your invoice <strong>${input.invoiceNumber}</strong> is ready.</p>
    <p><strong>Amount due:</strong> ${money(input.totalCents)}<br>
    <strong>Due date:</strong> ${input.dueDate.toISOString().slice(0, 10)}</p>
    <p><a href="${input.invoiceUrl}" style="display:inline-block;background:#38bdf8;color:#06101d;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:12px;">View invoice</a></p>
  `;
  return { subject, html: shell("Invoice Ready", body), text: `${subject}\nAmount due: ${money(input.totalCents)}\n${input.invoiceUrl}` };
}

export function paymentReceiptEmail(input: { invoiceNumber: string; totalCents: number; paidAt: Date; cardLabel?: string | null }): { subject: string; html: string; text: string } {
  const subject = `Payment received - ${input.invoiceNumber}`;
  const card = input.cardLabel ? `<p><strong>Payment method:</strong> ${input.cardLabel}</p>` : "";
  const body = `<p>Thanks, payment was received for invoice <strong>${input.invoiceNumber}</strong>.</p><p><strong>Paid:</strong> ${money(input.totalCents)} on ${input.paidAt.toISOString().slice(0, 10)}</p>${card}`;
  return { subject, html: shell("Payment Received", body), text: `${subject}\nPaid: ${money(input.totalCents)}` };
}

export function paymentFailedEmail(input: { invoiceNumber: string; totalCents: number; reason?: string | null; updateUrl: string }): { subject: string; html: string; text: string } {
  const subject = `Payment failed - ${input.invoiceNumber}`;
  const body = `
    <p>We could not process the saved payment method for invoice <strong>${input.invoiceNumber}</strong>.</p>
    <p><strong>Amount:</strong> ${money(input.totalCents)}<br>
    <strong>Reason:</strong> ${input.reason || "The payment processor declined the transaction."}</p>
    <p><a href="${input.updateUrl}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:12px;">Update payment method</a></p>
  `;
  return { subject, html: shell("Payment Failed", body), text: `${subject}\nAmount: ${money(input.totalCents)}\n${input.updateUrl}` };
}
