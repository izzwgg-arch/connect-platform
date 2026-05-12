import { DEFAULT_INVOICE_DISPLAY_NAME, escapeHtml, type InvoiceEmailBranding, resolveInvoiceEmailBranding } from "./invoiceBranding";

export function money(cents: number): string {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

const CONNECT_FALLBACK = resolveInvoiceEmailBranding({}, null);

function mergeBrand(brand?: InvoiceEmailBranding | null): InvoiceEmailBranding {
  if (!brand) return CONNECT_FALLBACK;
  return {
    displayName: brand.displayName || CONNECT_FALLBACK.displayName,
    logoUrl: brand.logoUrl ?? null,
    supportEmail: brand.supportEmail ?? null,
    supportPhone: brand.supportPhone ?? null,
    footerNote: brand.footerNote ?? null,
    paymentInstructions: brand.paymentInstructions ?? null,
    paymentTermsDays: brand.paymentTermsDays ?? CONNECT_FALLBACK.paymentTermsDays,
  };
}

function supportBlock(brand: InvoiceEmailBranding): string {
  const parts: string[] = [];
  if (brand.supportEmail) parts.push(`<a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:#38bdf8;">${escapeHtml(brand.supportEmail)}</a>`);
  if (brand.supportPhone) parts.push(escapeHtml(brand.supportPhone));
  if (!parts.length) return "";
  return `<p style="margin:16px 0 0;font-size:14px;color:#94a3b8;">Billing support: ${parts.join(" · ")}</p>`;
}

function brandFooter(brand: InvoiceEmailBranding): string {
  const bits: string[] = [];
  if (brand.footerNote) {
    bits.push(`<div style="margin-top:14px;padding-top:14px;border-top:1px solid #24324d;color:#94a3b8;font-size:13px;line-height:1.55;">${escapeHtml(brand.footerNote).replace(/\n/g, "<br/>")}</div>`);
  }
  bits.push(
    `<div style="margin-top:12px;font-size:12px;line-height:1.5;color:#64748b;">Sent by <strong style="color:#cbd5e1;">${escapeHtml(brand.displayName)}</strong> via Connect Communications billing.</div>`,
  );
  return bits.join("");
}

function emailShell(title: string, body: string, brand: InvoiceEmailBranding): string {
  const b = mergeBrand(brand);
  const logo = b.logoUrl
    ? `<div style="text-align:center;margin-bottom:12px;"><img src="${escapeHtml(b.logoUrl)}" alt="" width="140" style="max-width:180px;height:auto;display:inline-block;border:0;" /></div>`
    : "";
  return `<!doctype html>
<html>
  <body style="margin:0;background:#0b1220;color:#e5edf7;font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;background:#0b1220;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:linear-gradient(180deg,#111a2e 0%,#0f1628 100%);border:1px solid #24324d;border-radius:18px;overflow:hidden;">
          <tr><td style="padding:22px 22px 16px;border-bottom:1px solid #24324d;">
            ${logo}
            <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#7dd3fc;">${escapeHtml(b.displayName)}</div>
            <h1 style="margin:6px 0 0;font-size:22px;line-height:1.25;color:#fff;">${escapeHtml(title)}</h1>
          </td></tr>
          <tr><td style="padding:22px;color:#d7e3f4;font-size:15px;line-height:1.65;">${body}${supportBlock(b)}</td></tr>
          <tr><td style="padding:0 22px 20px;">${brandFooter(b)}</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** Scheduled / automated invoice delivery (tenant BillingInvoice). */
export function invoiceSentEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  dueDate: Date;
  portalInvoiceUrl: string;
  pdfUrl: string;
  balanceDueCents?: number;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand ?? null);
  const due = input.dueDate.toISOString().slice(0, 10);
  const bal = input.balanceDueCents != null ? input.balanceDueCents : input.totalCents;
  const subject = `${brand.displayName !== DEFAULT_INVOICE_DISPLAY_NAME ? `${brand.displayName} — ` : ""}Invoice ${input.invoiceNumber} — ${money(bal)} due`;
  const terms = `<p style="font-size:14px;color:#94a3b8;">Payment terms: Net <strong>${brand.paymentTermsDays}</strong> days unless otherwise stated on the invoice.</p>`;
  const payInstr = brand.paymentInstructions
    ? `<div style="margin-top:12px;padding:12px 14px;background:#0b1220;border-radius:12px;border:1px solid #24324d;font-size:14px;color:#cbd5e1;line-height:1.55;">${escapeHtml(brand.paymentInstructions).replace(/\n/g, "<br/>")}</div>`
    : "";
  const body = `
    <p>Your invoice <strong>${escapeHtml(input.invoiceNumber)}</strong> is ready.</p>
    <p><strong>Amount due:</strong> ${money(bal)}<br>
    <strong>Due date:</strong> ${due}</p>
    ${terms}
    <p style="margin-top:18px;"><a href="${escapeHtml(input.portalInvoiceUrl)}" style="display:inline-block;background:#38bdf8;color:#06101d;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:12px;">View &amp; pay in portal</a></p>
    ${payInstr}
    <p style="font-size:14px;color:#94a3b8;margin-top:16px;">PDF (sign-in may be required):<br><a href="${escapeHtml(input.pdfUrl)}" style="color:#7dd3fc;word-break:break-all;">${escapeHtml(input.pdfUrl)}</a></p>
  `;
  const text = `${subject}\nDue: ${due}\nPortal: ${input.portalInvoiceUrl}\nPDF: ${input.pdfUrl}`;
  return { subject, html: emailShell("Invoice ready", body, brand), text };
}

/** Admin / manual resend — pass `pdfUrl` when known (JWT PDF route). */
export function invoiceReadyEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  dueDate: Date;
  invoiceUrl: string;
  pdfUrl?: string;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  return invoiceSentEmail({
    invoiceNumber: input.invoiceNumber,
    totalCents: input.totalCents,
    dueDate: input.dueDate,
    portalInvoiceUrl: input.invoiceUrl,
    pdfUrl: input.pdfUrl || input.invoiceUrl,
    brand: input.brand ?? null,
  });
}

export function paymentLinkEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  dueDate: Date;
  payUrl: string;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand ?? null);
  const subject =
    brand.displayName !== DEFAULT_INVOICE_DISPLAY_NAME ? `Pay invoice ${input.invoiceNumber} — ${brand.displayName}` : `Pay invoice ${input.invoiceNumber}`;
  const due = input.dueDate.toISOString().slice(0, 10);
  const body = `
    <p>Please complete payment for invoice <strong>${escapeHtml(input.invoiceNumber)}</strong>.</p>
    <p><strong>Amount due:</strong> ${money(input.totalCents)}<br><strong>Due:</strong> ${due}</p>
    <p style="margin-top:18px;"><a href="${escapeHtml(input.payUrl)}" style="display:inline-block;background:#22c55e;color:#052e16;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:12px;">Open invoice &amp; pay</a></p>
  `;
  return { subject, html: emailShell("Payment link", body, brand), text: `${subject}\n${input.payUrl}` };
}

export function paymentReceiptEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  paidAt: Date;
  cardLabel?: string | null;
  portalInvoiceUrl?: string | null;
  paidViaAutopay?: boolean;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand ?? null);
  const auto = input.paidViaAutopay
    ? `<p style="color:#86efac;font-size:14px;">Your saved payment method was charged automatically on your billing date.</p>`
    : "";
  const subject = input.paidViaAutopay ? `Autopay receipt — ${input.invoiceNumber}` : `Payment received — ${input.invoiceNumber}`;
  const card = input.cardLabel ? `<p><strong>Payment method:</strong> ${escapeHtml(input.cardLabel)}</p>` : "";
  const portal = input.portalInvoiceUrl
    ? `<p><a href="${escapeHtml(input.portalInvoiceUrl)}" style="color:#7dd3fc;">View invoice in portal</a></p>`
    : "";
  const h1 = input.paidViaAutopay ? "Autopay successful" : "Payment received";
  const body = `<p>Thank you — we received payment for invoice <strong>${escapeHtml(input.invoiceNumber)}</strong>.</p>${auto}<p><strong>Amount:</strong> ${money(input.totalCents)} on ${input.paidAt.toISOString().slice(0, 10)}</p>${card}${portal}`;
  return { subject, html: emailShell(h1, body, brand), text: `${subject}\n${money(input.totalCents)}` };
}

export function paymentFailedEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  reason?: string | null;
  updateUrl: string;
  payUrl?: string | null;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand ?? null);
  const subject = `Payment could not be completed — ${input.invoiceNumber}`;
  const pay = input.payUrl
    ? `<p style="margin-top:14px;"><a href="${escapeHtml(input.payUrl)}" style="display:inline-block;background:#22c55e;color:#052e16;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:12px;">Try payment again</a></p>`
    : "";
  const body = `
    <p>We could not process the payment for invoice <strong>${escapeHtml(input.invoiceNumber)}</strong>.</p>
    <p><strong>Amount:</strong> ${money(input.totalCents)}<br>
    <strong>Details:</strong> ${escapeHtml(input.reason || "The payment processor declined or errored.")}</p>
    ${pay}
    <p style="margin-top:14px;"><a href="${escapeHtml(input.updateUrl)}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:12px;">Update saved card</a></p>
  `;
  return { subject, html: emailShell("Autopay / payment issue", body, brand), text: `${subject}\n${input.updateUrl}${input.payUrl ? `\n${input.payUrl}` : ""}` };
}
