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
const CONNECT_COMPANY_NAME = "Connect Communications, LLC";
const CONNECT_SUPPORT_EMAIL = "support@connectcomunications.com";
const CONNECT_SUPPORT_DOMAIN = "connectcomunications.com";
const CONNECT_SUPPORT_PHONE = "845-723-1213";
const CONNECT_BLUE = "#0284c7";

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

function supportBlock(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;border-collapse:separate;border-spacing:0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
    <tr>
      <td style="padding:16px 18px;font-family:-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Arial,sans-serif;">
        <p style="margin:0 0 6px;font-size:15px;line-height:22px;font-weight:700;color:#0f172a;">Need help with billing?</p>
        <p style="margin:0;font-size:14px;line-height:22px;color:#475569;">
          <strong style="color:#334155;">${CONNECT_COMPANY_NAME}</strong><br/>
          <a href="mailto:${CONNECT_SUPPORT_EMAIL}" style="color:${CONNECT_BLUE};text-decoration:none;">${CONNECT_SUPPORT_EMAIL}</a><br/>
          <a href="https://${CONNECT_SUPPORT_DOMAIN}" style="color:${CONNECT_BLUE};text-decoration:none;">${CONNECT_SUPPORT_DOMAIN}</a> &nbsp;|&nbsp; ${CONNECT_SUPPORT_PHONE}
        </p>
      </td>
    </tr>
  </table>`;
}

function brandFooter(): string {
  return `<p style="margin:0;font-size:13px;line-height:20px;color:#64748b;">Sent by Connect Communications billing.</p>`;
}

/**
 * White/light email shell — table-based and Outlook-safe for major email clients.
 */
function emailShell(title: string, body: string, _brand: InvoiceEmailBranding): string {
  const logoSrc = getDefaultLogoUrl();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeHtml(title)}</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-shell { width: 100% !important; }
        .email-pad { padding-left: 18px !important; padding-right: 18px !important; }
        .summary-label, .summary-value { display: block !important; width: 100% !important; box-sizing: border-box !important; text-align: left !important; }
        .summary-label { padding-bottom: 3px !important; }
        .summary-value { padding-left: 0 !important; padding-top: 0 !important; font-size: 17px !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
        .cta-link { display: block !important; width: 100% !important; box-sizing: border-box !important; }
        .shell-wrap { padding-left: 0 !important; padding-right: 0 !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f3f6fa;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
    <center role="article" aria-roledescription="email" lang="en" style="width:100%;background:#f3f6fa;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#f3f6fa;border-collapse:collapse;">
        <tr>
          <td align="center" class="shell-wrap" style="padding:24px 12px;">
            <!--[if mso]>
            <table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr><td>
            <![endif]-->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="email-shell" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #dbe4ee;border-radius:16px;overflow:hidden;">
              <tr>
                <td style="height:5px;background:${CONNECT_BLUE};font-size:0;line-height:0;">&nbsp;</td>
              </tr>
              <tr>
                <td class="email-pad" style="padding:24px 28px 18px;font-family:-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Arial,sans-serif;background:#ffffff;">
                  <img src="${escapeHtml(logoSrc)}" alt="Connect Communications" width="156" style="display:block;width:156px;max-width:156px;height:auto;border:0;outline:none;text-decoration:none;margin:0 0 18px;" />
                  <p style="margin:0 0 6px;font-size:13px;line-height:18px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${CONNECT_BLUE};">Connect Communications billing</p>
                  <h1 style="margin:0;font-size:26px;line-height:32px;font-weight:750;color:#0f172a;">${escapeHtml(title)}</h1>
                </td>
              </tr>
              <tr>
                <td class="email-pad" style="padding:0 28px 26px;font-family:-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Arial,sans-serif;background:#ffffff;color:#1e293b;font-size:16px;line-height:25px;">
                  ${body}
                  ${supportBlock()}
                </td>
              </tr>
              <tr>
                <td class="email-pad" style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:18px 28px;font-family:-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Arial,sans-serif;">
                  ${brandFooter()}
                </td>
              </tr>
            </table>
            <!--[if mso]>
            </td></tr></table>
            <![endif]-->
          </td>
        </tr>
      </table>
    </center>
  </body>
</html>`;
}

/** Formatted summary row for the info box tables in email body. */
function summaryRow(label: string, value: string, topBorder = true, bold = false): string {
  const border = topBorder ? "border-top:1px solid #e2e8f0;" : "";
  const vStyle = bold
    ? `font-size:19px;line-height:26px;color:#0f172a;font-weight:800;text-align:right;${border}`
    : `font-size:15px;line-height:22px;color:#0f172a;font-weight:700;text-align:right;${border}`;
  return `<tr>
    <td class="summary-label" style="padding:12px 0;font-size:14px;line-height:21px;color:#64748b;${border}">${label}</td>
    <td class="summary-value" style="padding:12px 0 12px 16px;${vStyle}">${value}</td>
  </tr>`;
}

/** Light, readable invoice summary card. */
function infoBox(rows: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;background:#f8fafc;border:1px solid #dbe4ee;border-radius:14px;margin:22px 0;">
  <tr><td style="padding:18px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${rows}
    </table>
  </td></tr>
</table>`;
}

/** Primary CTA button. */
function ctaButton(href: string, label: string, color = "#0284c7"): string {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;margin:24px 0 14px;">
    <tr>
      <td align="center" bgcolor="${color}" style="border-radius:10px;background:${color};mso-padding-alt:15px 28px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${safeHref}" style="height:48px;v-text-anchor:middle;width:190px;" arcsize="18%" strokecolor="${color}" fillcolor="${color}">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${safeLabel}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-- -->
        <a class="cta-link" href="${safeHref}" style="display:inline-block;min-width:150px;background:${color};border-radius:10px;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:800;text-align:center;text-decoration:none;padding:15px 28px;-webkit-text-size-adjust:none;">${safeLabel}</a>
        <!--<![endif]-->
      </td>
    </tr>
  </table>`;
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
  portalInvoiceUrl?: string | null;
  billingInvoiceId: string;
  balanceDueCents?: number;
  servicePeriod?: string | null;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand ?? null);
  const bal = input.balanceDueCents != null ? input.balanceDueCents : input.totalCents;
  const subject = `Invoice ${input.invoiceNumber} — ${money(bal)} due`;

  const rows = [
    summaryRow("Amount due", `<strong style="color:${CONNECT_BLUE};">${money(bal)}</strong>`, false, true),
    summaryRow("Invoice number", escapeHtml(input.invoiceNumber)),
    summaryRow("Due date", fmtDate(input.dueDate)),
  ];
  if (input.servicePeriod) {
    rows.push(summaryRow("Service period", escapeHtml(input.servicePeriod)));
  }
  if (brand.displayName && brand.displayName !== DEFAULT_INVOICE_DISPLAY_NAME) {
    rows.push(summaryRow("Billed company", escapeHtml(brand.displayName)));
  }

  const payInstr = brand.paymentInstructions
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:separate;border-spacing:0;background:#f0f9ff;border-left:4px solid ${CONNECT_BLUE};border-radius:10px;">
        <tr><td style="padding:14px 16px;font-size:15px;line-height:23px;color:#1e293b;">${escapeHtml(brand.paymentInstructions).replace(/\n/g, "<br/>")}</td></tr>
      </table>`
    : "";
  const payButton = input.portalInvoiceUrl ? ctaButton(input.portalInvoiceUrl, "Pay Invoice") : "";

  const body = `
    <p style="margin:0 0 10px;font-size:17px;line-height:25px;font-weight:700;color:#1e293b;">Your invoice is ready.</p>
    <p style="margin:0 0 20px;font-size:16px;line-height:25px;color:#475569;">Review the attached PDF or pay online.</p>
    ${infoBox(rows.join(""))}
    ${payButton}
    ${payInstr}
    <p style="margin:18px 0 0;font-size:14px;line-height:22px;color:#64748b;">Your invoice PDF is attached.</p>
    ${billingInvoiceEmailMarker(input.billingInvoiceId)}
  `;

  const textLines = [
    subject,
    `Amount due: ${money(bal)}`,
    `Invoice number: ${input.invoiceNumber}`,
    `Due date: ${fmtDate(input.dueDate)}`,
    input.portalInvoiceUrl ? `Pay invoice: ${input.portalInvoiceUrl}` : null,
    "",
    "Your invoice PDF is attached.",
    `Questions? Contact Connect Communications billing at ${CONNECT_SUPPORT_EMAIL} or ${CONNECT_SUPPORT_PHONE}.`,
  ].filter((line): line is string => line != null);
  const text = textLines.join("\n");
  return { subject, html: emailShell("Invoice ready", body, brand), text };
}

/** Admin / manual resend — PDF is attached when the email job is sent. */
export function invoiceReadyEmail(input: {
  invoiceNumber: string;
  totalCents: number;
  dueDate: Date;
  invoiceUrl?: string | null;
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
  payUrl?: string | null;
  brand?: InvoiceEmailBranding | null;
}): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand ?? null);
  const subject = `Pay invoice ${input.invoiceNumber}`;

  const rows = [
    summaryRow("Amount due", `<strong style="color:${CONNECT_BLUE};">${money(input.totalCents)}</strong>`, false, true),
    summaryRow("Invoice number", escapeHtml(input.invoiceNumber)),
    summaryRow("Due date", fmtDate(input.dueDate)),
  ];
  if (brand.displayName && brand.displayName !== DEFAULT_INVOICE_DISPLAY_NAME) {
    rows.push(summaryRow("Billed company", escapeHtml(brand.displayName)));
  }
  const payButton = input.payUrl ? ctaButton(input.payUrl, "Pay Invoice", "#15803d") : "";

  const body = `
    <p style="margin:0 0 10px;font-size:17px;line-height:25px;font-weight:700;color:#1e293b;">Payment requested.</p>
    <p style="margin:0 0 20px;font-size:16px;line-height:25px;color:#475569;">Please use the secure payment button below for this invoice.</p>
    ${infoBox(rows.join(""))}
    ${payButton}
  `;
  const text = [
    subject,
    `Amount due: ${money(input.totalCents)}`,
    `Invoice number: ${input.invoiceNumber}`,
    `Due date: ${fmtDate(input.dueDate)}`,
    input.payUrl ? `Pay invoice: ${input.payUrl}` : null,
    `Questions? Contact Connect Communications billing at ${CONNECT_SUPPORT_EMAIL} or ${CONNECT_SUPPORT_PHONE}.`,
  ].filter((line): line is string => line != null).join("\n");
  return { subject, html: emailShell("Payment link", body, brand), text };
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
    summaryRow("Invoice number", escapeHtml(input.invoiceNumber)),
    summaryRow("Payment date", fmtDate(input.paidAt)),
  ];
  if (input.cardLabel) {
    rows.push(summaryRow("Payment method", escapeHtml(input.cardLabel)));
  }

  const viewBtn = input.portalInvoiceUrl
    ? `<p style="margin:0 0 12px;">${ctaButton(input.portalInvoiceUrl, "View invoice")}</p>`
    : "";

  const h1 = input.paidViaAutopay ? "Autopay successful" : "Payment received";

  const body = `
    <div style="margin-bottom:16px;">
      <span style="display:inline-block;background:#dcfce7;color:#15803d;font-weight:700;font-size:13px;padding:4px 14px;border-radius:20px;">✓ Payment confirmed</span>
    </div>
    <p style="margin:0 0 16px;font-size:17px;line-height:25px;font-weight:700;color:#1e293b;">Thank you — we received your payment.</p>
    ${autopayNote}
    ${infoBox(rows.join(""))}
    ${viewBtn}
    <p style="margin:12px 0 0;font-size:14px;line-height:22px;color:#64748b;">Your invoice PDF is attached.</p>
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

// ─── Refund confirmation email ────────────────────────────────────────────────

export type PaymentRefundedEmailInput = {
  customerName?: string | null;
  invoiceNumber: string;
  refundedAmountCents: number;
  originalPaymentDate?: Date | string | null;
  refundIssuedDate?: Date | string | null;
  cardLabel?: string | null;
  portalInvoiceUrl?: string | null;
  /** true = copy should acknowledge a billing glitch; false = routine refund */
  isDuplicateChargeRefund?: boolean;
  brand?: InvoiceEmailBranding | null;
};

export function paymentRefundedEmail(input: PaymentRefundedEmailInput): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand);
  const amount = money(input.refundedAmountCents);
  const subject = `Refund of ${amount} — Invoice ${escapeHtml(input.invoiceNumber)}`;

  const rows: string[] = [];
  if (input.customerName) rows.push(summaryRow("Account", escapeHtml(input.customerName), false));
  rows.push(summaryRow("Invoice", escapeHtml(input.invoiceNumber), !input.customerName));
  rows.push(summaryRow("Refund amount", `<strong style="color:#16a34a;">${escapeHtml(amount)}</strong>`));
  if (input.cardLabel) rows.push(summaryRow("Payment method", escapeHtml(input.cardLabel)));
  if (input.originalPaymentDate) rows.push(summaryRow("Original payment date", fmtDate(input.originalPaymentDate)));
  if (input.refundIssuedDate) rows.push(summaryRow("Refund issued", fmtDate(input.refundIssuedDate)));
  rows.push(summaryRow("Expected timing", "2–3 business days to appear on your statement"));

  const viewBtn = input.portalInvoiceUrl
    ? `<p style="margin:24px 0 0;">${ctaButton(input.portalInvoiceUrl, "View invoice", CONNECT_BLUE)}</p>`
    : "";

  const intro = input.isDuplicateChargeRefund
    ? `<p style="margin:0 0 6px;font-size:14px;color:#64748b;">We're sorry for the inconvenience — a billing glitch caused a duplicate charge this month. We've issued a full refund.</p>`
    : `<p style="margin:0 0 6px;font-size:14px;color:#64748b;">Your refund has been processed and should appear within 2–3 business days.</p>`;

  const body = `
    <div style="margin-bottom:16px;">
      <span style="display:inline-block;background:#dcfce7;color:#15803d;font-weight:700;font-size:13px;padding:4px 14px;border-radius:20px;">✓ Refund issued</span>
    </div>
    <p style="margin:0 0 12px;font-size:16px;font-weight:600;color:#1e293b;">Your refund of ${escapeHtml(amount)} is on its way.</p>
    ${intro}
    ${infoBox(rows.join(""))}
    ${viewBtn}
  `;

  return {
    subject,
    html: emailShell("Refund confirmation", body, brand),
    text: `${subject}\nRefund amount: ${amount}\nInvoice: ${input.invoiceNumber}\nExpected: 2-3 business days`,
  };
}

// ─── One-time duplicate-charge apology email ──────────────────────────────────

export type BillingApologyEmailInput = {
  customerName?: string | null;
  refundedAmountCents?: number | null;
  invoiceNumber?: string | null;
  originalPaymentDate?: Date | string | null;
  portalInvoiceUrl?: string | null;
  brand?: InvoiceEmailBranding | null;
};

export function billingApologyEmail(input: BillingApologyEmailInput): { subject: string; html: string; text: string } {
  const brand = mergeBrand(input.brand);
  const subject = "Important: Billing update and refund confirmation";
  const greeting = input.customerName ? `Hi ${escapeHtml(input.customerName)},` : "Hello,";

  const rows: string[] = [];
  if (input.invoiceNumber) rows.push(summaryRow("Invoice", escapeHtml(input.invoiceNumber), false));
  if (input.refundedAmountCents) rows.push(summaryRow("Amount refunded", `<strong style="color:#16a34a;">${escapeHtml(money(input.refundedAmountCents))}</strong>`));
  if (input.originalPaymentDate) rows.push(summaryRow("Original payment date", fmtDate(input.originalPaymentDate)));
  rows.push(summaryRow("Expected timing", "2–3 business days to appear on your statement"));

  const viewBtn = input.portalInvoiceUrl
    ? `<p style="margin:24px 0 0;">${ctaButton(input.portalInvoiceUrl, "View invoice", CONNECT_BLUE)}</p>`
    : "";

  const body = `
    <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#1e293b;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:15px;color:#334155;">
      We want to let you know about a billing issue that occurred today. Due to a system glitch,
      your account was charged a duplicate payment for this month. We sincerely apologize for this.
    </p>
    <p style="margin:0 0 16px;font-size:15px;color:#334155;">
      A full refund has already been issued. Depending on your bank, it should appear on your
      statement within 2–3 business days.
    </p>
    ${rows.length ? infoBox(rows.join("")) : ""}
    ${viewBtn}
    <p style="margin:24px 0 0;font-size:14px;color:#64748b;">
      If you have any questions or do not see the refund after 3 business days, please don't
      hesitate to reach out — we're happy to assist.
    </p>
  `;

  return {
    subject,
    html: emailShell("Billing update", body, brand),
    text: `${subject}\n${greeting}\nA duplicate charge occurred this month. A full refund has been issued and should appear within 2-3 business days.`,
  };
}
