import { DEFAULT_INVOICE_DISPLAY_NAME, escapeHtml, type InvoiceEmailBranding, resolveInvoiceEmailBranding } from "./invoiceBranding";
import { formatBillingDate } from "./billingTime";

export function money(cents: number): string {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

/** Human-readable date: "May 19, 2026" */
function fmtDate(d: Date | string): string {
  return formatBillingDate(d);
}

/** Get fallback Connect logo URL from PUBLIC_PORTAL_URL env. */
function getDefaultLogoUrl(): string {
  const base = (process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com").replace(/\/$/, "");
  return `${base}/connect-logo.png`;
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
  if (brand.supportEmail) {
    parts.push(`<a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:#0284c7;text-decoration:none;">${escapeHtml(brand.supportEmail)}</a>`);
  }
  if (brand.supportPhone) parts.push(escapeHtml(brand.supportPhone));
  if (!parts.length) return "";
  return `<p style="margin:20px 0 0;padding:12px 16px;background:#f1f5f9;border-radius:6px;font-size:13px;color:#475569;">Questions? Contact billing support: ${parts.join(" &nbsp;·&nbsp; ")}</p>`;
}

function brandFooter(brand: InvoiceEmailBranding): string {
  const bits: string[] = [];
  if (brand.footerNote) {
    bits.push(
      `<p style="margin:0 0 8px;font-size:12px;color:#64748b;line-height:1.55;">${escapeHtml(brand.footerNote).replace(/\n/g, "<br/>")}</p>`,
    );
  }
  bits.push(
    `<p style="margin:0;font-size:12px;color:#94a3b8;">Sent by <strong style="color:#64748b;">${escapeHtml(brand.displayName)}</strong> via Connect Communications billing. Taxes and regulatory fees are applied according to your configured billing profile.</p>`,
  );
  return bits.join("");
}

/**
 * White/light email shell — safe for all major email clients.
 * Outer: light gray (#f1f5f9). Card: white. Header: Connect blue.
 */
function emailShell(title: string, body: string, brand: InvoiceEmailBranding): string {
  const b = mergeBrand(brand);
  const logoSrc = b.logoUrl || getDefaultLogoUrl();
  const logo = `<div style="margin-bottom:10px;"><img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(b.displayName)}" width="140" style="max-width:160px;height:auto;display:inline-block;border:0;" /></div>`;
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">
          <!-- Header -->
          <tr>
            <td style="background:#0284c7;border-radius:10px 10px 0 0;padding:24px 28px;">
              ${logo}
              <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#bae6fd;margin-bottom:3px;">${escapeHtml(b.displayName)}</div>
              <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.25;">${escapeHtml(title)}</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:28px 28px 20px;color:#1e293b;font-size:15px;line-height:1.65;">
              ${body}
              ${supportBlock(b)}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:16px 28px;">
              ${brandFooter(b)}
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** Formatted summary row for the info box tables in email body. */
function summaryRow(label: string, value: string, topBorder = true, bold = false): string {
  const border = topBorder ? "border-top:1px solid #f1f5f9;" : "";
  const vStyle = bold
    ? `font-size:14px;color:#0f172a;font-weight:700;text-align:right;${border}`
    : `font-size:14px;color:#0f172a;font-weight:600;text-align:right;${border}`;
  return `<tr>
    <td style="padding:8px 0;font-size:14px;color:#64748b;${border}">${label}</td>
    <td style="${vStyle}">${value}</td>
  </tr>`;
}

/** Blue accent info box (used for summary tables). */
function infoBox(rows: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin:20px 0;">
  <tr><td style="padding:16px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${rows}
    </table>
  </td></tr>
</table>`;
}

/** Primary CTA button. */
function ctaButton(href: string, label: string, color = "#0284c7"): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:8px;margin-top:4px;">${escapeHtml(label)}</a>`;
}

// ---------------------------------------------------------------------------
// Exported templates
// ---------------------------------------------------------------------------

/** Scheduled / automated invoice delivery (tenant BillingInvoice). */
/** Hidden marker parsed when attaching invoice PDFs to outbound email jobs. */
export function billingInvoiceEmailMarker(invoiceId: string): string {
  return `<!-- connect-billing-invoice:${invoiceId} -->`;
}

export function invoiceSentEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  dueDate: Date;
  portalInvoiceUrl: string;
  billingInvoiceId: string;
  balanceDueCents?: number;
  servicePeriod?: string | null;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand ?? null);
  const bal = input.balanceDueCents != null ? input.balanceDueCents : input.totalCents;
  const subject = `${brand.displayName !== DEFAULT_INVOICE_DISPLAY_NAME ? `${brand.displayName} — ` : ""}Invoice ${input.invoiceNumber} — ${money(bal)} due`;

  const rows = [
    summaryRow("Amount due", `<strong style="font-size:16px;color:#0284c7;">${money(bal)}</strong>`, false, true),
    summaryRow("Invoice", escapeHtml(input.invoiceNumber)),
    summaryRow("Due date", fmtDate(input.dueDate)),
  ];
  if (input.servicePeriod) {
    rows.push(summaryRow("Service period", escapeHtml(input.servicePeriod)));
  }
  const terms = brand.paymentTermsDays
    ? `<p style="margin:0 0 16px;font-size:13px;color:#94a3b8;">Payment terms: Net ${brand.paymentTermsDays} days</p>`
    : "";

  const payInstr = brand.paymentInstructions
    ? `<div style="margin:16px 0;padding:14px 16px;background:#f0f9ff;border-left:3px solid #0284c7;border-radius:0 6px 6px 0;font-size:14px;color:#1e293b;line-height:1.55;">${escapeHtml(brand.paymentInstructions).replace(/\n/g, "<br/>")}</div>`
    : "";

  const body = `
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#1e293b;">Your invoice is ready.</p>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;">Please review and pay by the due date below.</p>
    ${infoBox(rows.join(""))}
    ${terms}
    <p style="margin:0 0 16px;">${ctaButton(input.portalInvoiceUrl, "View & pay invoice")}</p>
    ${payInstr}
    <p style="margin:16px 0 0;font-size:13px;color:#64748b;">Your invoice PDF is attached to this email.</p>
    ${billingInvoiceEmailMarker(input.billingInvoiceId)}
  `;

  const text = `${subject}\nDue: ${fmtDate(input.dueDate)}\nPay: ${input.portalInvoiceUrl}\n\nYour invoice PDF is attached to this email.`;
  return { subject, html: emailShell("Invoice ready", body, brand), text };
}

/** Admin / manual resend — PDF is attached when the email job is sent. */
export function invoiceReadyEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  dueDate: Date;
  invoiceUrl: string;
  billingInvoiceId: string;
  servicePeriod?: string | null;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  return invoiceSentEmail({
    invoiceNumber: input.invoiceNumber,
    totalCents: input.totalCents,
    dueDate: input.dueDate,
    portalInvoiceUrl: input.invoiceUrl,
    billingInvoiceId: input.billingInvoiceId,
    servicePeriod: input.servicePeriod,
    brand: input.brand ?? null,
  });
}

/** Payment link email (customer self-serve or operator-triggered). */
export function paymentLinkEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  dueDate: Date;
  payUrl: string;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand ?? null);
  const subject =
    brand.displayName !== DEFAULT_INVOICE_DISPLAY_NAME
      ? `Pay invoice ${input.invoiceNumber} — ${brand.displayName}`
      : `Pay invoice ${input.invoiceNumber}`;

  const rows = [
    summaryRow("Amount due", `<strong style="font-size:16px;color:#0284c7;">${money(input.totalCents)}</strong>`, false, true),
    summaryRow("Invoice", escapeHtml(input.invoiceNumber)),
    summaryRow("Due date", fmtDate(input.dueDate)),
  ];

  const body = `
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#1e293b;">Payment requested.</p>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;">Please complete payment for the invoice below.</p>
    ${infoBox(rows.join(""))}
    <p style="margin:0 0 16px;">${ctaButton(input.payUrl, "Open invoice & pay", "#15803d")}</p>
  `;
  return { subject, html: emailShell("Payment link", body, brand), text: `${subject}\n${input.payUrl}` };
}

/** Payment receipt email sent after successful charge. */
export function paymentReceiptEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  paidAt: Date;
  billingInvoiceId: string;
  cardLabel?: string | null;
  portalInvoiceUrl?: string | null;
  paidViaAutopay?: boolean;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand ?? null);
  const subject = input.paidViaAutopay
    ? `Autopay receipt — ${input.invoiceNumber}`
    : `Payment received — ${input.invoiceNumber}`;

  const autopayNote = input.paidViaAutopay
    ? `<p style="margin:0 0 16px;font-size:14px;color:#15803d;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:10px 14px;">Your saved payment method was charged automatically on your billing date.</p>`
    : "";

  const rows = [
    summaryRow("Amount paid", `<strong style="font-size:16px;color:#15803d;">${money(input.totalCents)}</strong>`, false, true),
    summaryRow("Invoice", escapeHtml(input.invoiceNumber)),
    summaryRow("Payment date", fmtDate(input.paidAt)),
  ];
  if (input.cardLabel) {
    rows.push(summaryRow("Payment method", escapeHtml(input.cardLabel)));
  }

  const viewBtn = input.portalInvoiceUrl
    ? `<p style="margin:0 0 12px;">${ctaButton(input.portalInvoiceUrl, "View invoice")}</p>`
    : "";

  const pdfNote = `<p style="margin:12px 0 0;font-size:13px;color:#64748b;">Your invoice PDF is attached to this email.</p>`;

  const h1 = input.paidViaAutopay ? "Autopay successful" : "Payment received";

  const body = `
    <div style="margin-bottom:16px;">
      <span style="display:inline-block;background:#dcfce7;color:#15803d;font-weight:700;font-size:13px;padding:4px 14px;border-radius:20px;">✓ Payment confirmed</span>
    </div>
    <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#1e293b;">Thank you — we received your payment.</p>
    ${autopayNote}
    ${infoBox(rows.join(""))}
    ${viewBtn}
    ${pdfNote}
    ${billingInvoiceEmailMarker(input.billingInvoiceId)}
  `;

  return {
    subject,
    html: emailShell(h1, body, brand),
    text: `${subject}\nAmount: ${money(input.totalCents)}\nInvoice: ${input.invoiceNumber}\nPaid: ${fmtDate(input.paidAt)}${input.portalInvoiceUrl ? `\nPortal: ${input.portalInvoiceUrl}` : ""}`,
  };
}

/** Payment failed / autopay declined notification. */
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

  const rows = [
    summaryRow("Invoice", escapeHtml(input.invoiceNumber), false),
    summaryRow("Amount", money(input.totalCents)),
    summaryRow("Details", escapeHtml(input.reason || "The payment processor declined or returned an error.")),
  ];

  const retryBtn = input.payUrl
    ? `<p style="margin:0 0 10px;">${ctaButton(input.payUrl, "Try payment again", "#15803d")}</p>`
    : "";

  const body = `
    <div style="margin-bottom:16px;">
      <span style="display:inline-block;background:#fee2e2;color:#b91c1c;font-weight:700;font-size:13px;padding:4px 14px;border-radius:20px;">⚠ Payment issue</span>
    </div>
    <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#1e293b;">We could not process your payment.</p>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;">Please update your payment method or retry.</p>
    ${infoBox(rows.join(""))}
    ${retryBtn}
    <p style="margin:0 0 16px;">${ctaButton(input.updateUrl, "Update saved card", "#ea580c")}</p>
  `;

  return {
    subject,
    html: emailShell("Payment issue", body, brand),
    text: `${subject}\n${input.updateUrl}${input.payUrl ? `\n${input.payUrl}` : ""}`,
  };
}
