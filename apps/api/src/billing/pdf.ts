import path from "node:path";
import fs from "node:fs";
import PDFDocument from "pdfkit";
import { money } from "./emailTemplates";
import { resolveInvoiceEmailBranding, sanitizePlainText } from "./invoiceBranding";

// Bundled Connect logo — embedded in PDF when no tenant logo is configured.
// PDF cannot fetch remote URLs, so a local fallback is used instead.
const BUNDLED_LOGO_PATH = path.join(__dirname, "assets", "connect-logo.png");

function logoBuffer(): Buffer | null {
  try {
    if (fs.existsSync(BUNDLED_LOGO_PATH)) {
      return fs.readFileSync(BUNDLED_LOGO_PATH);
    }
  } catch {
    // If the file is missing in a non-standard build, skip silently.
  }
  return null;
}

function formatBillingAddress(addr: unknown): string | null {
  if (!addr || typeof addr !== "object") return null;
  const o = addr as Record<string, unknown>;
  const line1 = sanitizePlainText(o.line1 ?? o.address1 ?? o.street, 200);
  const line2 = sanitizePlainText(o.line2 ?? o.address2, 200);
  const city = sanitizePlainText(o.city, 120);
  const region = sanitizePlainText(o.state ?? o.region, 80);
  const postal = sanitizePlainText(o.postalCode ?? o.zip, 32);
  const parts = [line1, line2, [city, region].filter(Boolean).join(", "), postal].filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

function formatDateShort(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    PAID: "PAID",
    OPEN: "OPEN",
    DRAFT: "DRAFT",
    FAILED: "PAYMENT FAILED",
    OVERDUE: "OVERDUE",
    VOID: "VOID",
  };
  return map[status] ?? status;
}

type InvoiceNoticeConfig = {
  e911?: string | null;
  regulatoryRecovery?: string | null;
  telecomTaxes?: string | null;
  usf?: string | null;
  trs?: string | null;
  disputeNotice?: string | null;
  lateFeePolicy?: string | null;
  remittanceNotice?: string | null;
};

const DEFAULT_INVOICE_NOTICES: Required<InvoiceNoticeConfig> = {
  e911:
    "E911 surcharges may apply based on service address jurisdiction and are assessed by applicable state/local authorities.",
  regulatoryRecovery:
    "Regulatory Recovery Fees, when listed, are provider-assessed charges to recover compliance costs and are not government taxes.",
  telecomTaxes:
    "Telecom taxes and surcharges vary by jurisdiction and may include federal, state, county, and local assessments.",
  usf:
    "Federal Universal Service Fund (FUSF/USF) related charges may be passed through or recovered where applicable.",
  trs:
    "TRS/relay-related program charges may apply where required by regulation.",
  disputeNotice:
    "For billing support or disputes, contact the billing support team and include your invoice number for fastest response.",
  lateFeePolicy:
    "Late fee policy is governed by your service agreement and configured billing terms.",
  remittanceNotice:
    "Payment remittance and dispute handling follow your master service agreement and published billing terms.",
};

const NOTICE_KEYS: Array<keyof InvoiceNoticeConfig> = [
  "e911",
  "regulatoryRecovery",
  "telecomTaxes",
  "usf",
  "trs",
  "disputeNotice",
  "lateFeePolicy",
  "remittanceNotice",
];

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function resolveInvoiceNotices(settings: Record<string, unknown>): string[] {
  const metadata = asObject(settings.metadata);
  const noticeInput = asObject(metadata.billingNotices);
  const out: string[] = [];
  for (const key of NOTICE_KEYS) {
    const custom = sanitizePlainText(noticeInput[key], 900);
    const enabledRaw = noticeInput[`${key}Enabled`];
    const enabled = enabledRaw == null ? true : enabledRaw !== false;
    if (!enabled) continue;
    const fallback = DEFAULT_INVOICE_NOTICES[key] ?? "";
    out.push(custom || fallback);
  }
  return out;
}

function collectRegulatoryChargeCents(lineItems: any[]): number {
  const pattern = /\b(e911|911|regulatory|recovery|usf|fusf|trs|relay|telecom surcharge)\b/i;
  return lineItems
    .filter((item) => pattern.test(String(item?.description || "")))
    .reduce((sum, item) => sum + Number(item?.amountCents || 0), 0);
}

export async function renderBillingInvoicePdf(invoice: any): Promise<Buffer> {
  const settings = invoice.tenant?.billingSettings || {};
  const tenantName = invoice.tenant?.name || "Customer";
  const brand = resolveInvoiceEmailBranding(settings, tenantName);
  const billToAddress = formatBillingAddress(settings.billingAddress);
  const serviceAddress = formatBillingAddress(settings.serviceAddress);
  const billTo = billToAddress || serviceAddress || tenantName;
  const billingEmail = sanitizePlainText(settings.billingEmail, 320);
  const notices = resolveInvoiceNotices(settings);

  const payUrl = `${process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com"}/billing/invoices/${encodeURIComponent(invoice.id)}`;
  const logo = logoBuffer();
  const lineItems = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
  const regulatoryChargeCents = collectRegulatoryChargeCents(lineItems);
  const balanceDueCents = Number(invoice.balanceDueCents ?? invoice.totalCents ?? 0);

  // Palette
  const brandAccent = "#0ea5c6"; // muted cyan-blue that complements logo
  const ink = "#0f172a";
  const muted = "#475569";
  const slate = "#334155";
  const border = "#dbe5ef";
  const soft = "#f8fafc";
  const pale = "#eef4fa";

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48, info: { Title: `Invoice ${invoice.invoiceNumber || invoice.id}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const ml = 48; // margin left
    const mr = pageW - 48; // margin right
    const contentW = mr - ml;
    let y = 48;

    function ensureSpace(required: number) {
      if (y + required <= doc.page.height - 60) return;
      doc.addPage();
      y = 48;
      // Continuation rail keeps print context without heavy styling.
      doc.save();
      doc.lineWidth(1).strokeColor(border).moveTo(ml, y).lineTo(mr, y).stroke();
      doc.restore();
      y += 14;
      doc.fillColor(muted).fontSize(8).text(`Invoice ${invoice.invoiceNumber || invoice.id} (continued)`, ml, y);
      y += 14;
    }

    function card(x: number, cy: number, w: number, h: number) {
      doc.save();
      doc.fillColor("#ffffff").strokeColor(border).lineWidth(1).roundedRect(x, cy, w, h, 10).fillAndStroke();
      doc.restore();
    }

    // Premium minimal header (no giant blue block)
    doc.save();
    doc.rect(0, 0, pageW, 2).fill(brandAccent);
    doc.restore();

    const headerH = 106;
    card(ml, y, contentW, headerH);

    let logoEndX = ml + 18;
    if (logo) {
      try {
        doc.image(logo, ml + 16, y + 16, { fit: [160, 44], valign: "center" });
        logoEndX = ml + 178;
      } catch {
        // Image render failed — fall through to text header
      }
    }
    if (!logo) {
      doc.fillColor(ink).fontSize(14).font("Helvetica-Bold").text(brand.displayName.toUpperCase(), ml + 16, y + 30, { characterSpacing: 0.8 });
      doc.font("Helvetica");
    }

    doc.fillColor(slate).fontSize(9).font("Helvetica-Bold").text("INVOICE", logoEndX, y + 20, { width: 190, align: "left" });
    doc.fillColor(muted).fontSize(9).font("Helvetica").text(brand.displayName, logoEndX, y + 34, { width: 210, align: "left" });

    // Invoice number & status (right side)
    doc.fillColor(slate).fontSize(9).font("Helvetica-Bold").text("INVOICE NUMBER", ml, y + 18, { width: contentW - 14, align: "right" });
    doc.fillColor(ink).fontSize(20).font("Helvetica-Bold").text(invoice.invoiceNumber || invoice.id, ml, y + 30, {
      width: contentW - 14,
      align: "right",
    });
    doc.font("Helvetica");

    const statusText = statusLabel(invoice.status || "OPEN");
    const chipColors: Record<string, [string, string]> = {
      PAID: ["#dcfce7", "#166534"],
      "PAYMENT FAILED": ["#fee2e2", "#991b1b"],
      OVERDUE: ["#fff7ed", "#9a3412"],
      VOID: [soft, muted],
      DRAFT: [soft, muted],
      OPEN: [pale, "#0f766e"],
    };
    const [chipBg, chipFg] = chipColors[statusText] ?? ["#eff6ff", "#1d4ed8"];
    const chipY = y + 66;
    const chipLabel = ` ${statusText} `;
    doc.fontSize(9);
    const chipW = doc.widthOfString(chipLabel) + 18;
    doc.save();
    doc.fillColor(chipBg).strokeColor(border).roundedRect(mr - chipW - 16, chipY, chipW, 18, 8).fillAndStroke();
    doc.restore();
    doc.fillColor(chipFg).font("Helvetica-Bold").text(statusText, mr - chipW - 7, chipY + 4);
    doc.font("Helvetica");
    y += headerH + 14;

    // Bill-from / bill-to cards
    const colW = (contentW - 14) / 2;
    const col2X = ml + colW + 20;
    const fromCardY = y;
    card(ml, fromCardY, colW, 118);
    card(col2X, fromCardY, colW, 118);

    doc.fillColor(slate).fontSize(8).font("Helvetica-Bold").text("BILL FROM", ml + 14, y + 12);
    doc.font("Helvetica");
    let fromY = y + 26;
    doc.fillColor(ink).fontSize(11).font("Helvetica-Bold").text(brand.displayName, ml + 14, fromY, { width: colW - 26 });
    doc.font("Helvetica");
    fromY = doc.y + 3;
    if (brand.supportEmail) {
      doc.fillColor(muted).fontSize(9).text(brand.supportEmail, ml + 14, fromY, { width: colW - 26 });
      fromY = doc.y + 2;
    }
    if (brand.supportPhone) {
      doc.fillColor(muted).fontSize(9).text(brand.supportPhone, ml + 14, fromY, { width: colW - 26 });
    }

    doc.fillColor(slate).fontSize(8).font("Helvetica-Bold").text("BILL TO", col2X + 14, y + 12);
    doc.font("Helvetica");
    let toY = y + 26;
    doc.fillColor(ink).fontSize(11).font("Helvetica-Bold").text(tenantName, col2X + 14, toY, { width: colW - 26 });
    doc.font("Helvetica");
    toY = doc.y + 3;
    if (billingEmail) {
      doc.fillColor(muted).fontSize(9).text(billingEmail, col2X + 14, toY, { width: colW - 26 });
      toY = doc.y + 2;
    }
    if (billTo && billTo !== tenantName) {
      doc.fillColor(muted).fontSize(9).text(billTo, col2X + 14, toY, { width: colW - 26, lineGap: 1 });
    }
    y += 132;

    // Key details strip
    card(ml, y, contentW, 58);
    const detailCols = [
      { label: "Invoice #", value: invoice.invoiceNumber || invoice.id },
      { label: "Issue date", value: formatDateShort(invoice.issueDate || invoice.createdAt) },
      { label: "Due date", value: formatDateShort(invoice.dueDate) },
      {
        label: "Service period",
        value: `${formatDateShort(invoice.periodStart)} – ${formatDateShort(invoice.periodEnd)}`,
      },
    ];
    if (invoice.status === "PAID" && invoice.paidAt) {
      detailCols.push({ label: "Paid on", value: formatDateShort(invoice.paidAt) });
    }

    const detailColW = contentW / detailCols.length;
    detailCols.forEach(({ label, value }, i) => {
      const dx = ml + i * detailColW;
      doc.fillColor(slate).fontSize(8).font("Helvetica-Bold").text(label.toUpperCase(), dx + 12, y + 10, { width: detailColW - 18 });
      doc.font("Helvetica");
      doc.fillColor(ink).fontSize(9).text(value, dx + 12, y + 21, { width: detailColW - 18 });
    });
    y += 72;

    // Line items
    ensureSpace(180);
    doc.fillColor(ink).fontSize(12).font("Helvetica-Bold").text("Line Items", ml, y);
    doc.font("Helvetica");
    y += 10;
    card(ml, y, contentW, 28);
    doc.fillColor(slate).fontSize(8).font("Helvetica-Bold");
    doc.text("DESCRIPTION", ml + 12, y + 10, { width: 260 });
    doc.text("QTY", ml + 308, y + 10, { width: 40, align: "right" });
    doc.text("RATE", ml + 364, y + 10, { width: 78, align: "right" });
    doc.text("AMOUNT", ml + 452, y + 10, { width: 92, align: "right" });
    doc.font("Helvetica");
    y += 36;

    for (const item of lineItems) {
      const desc = String(item.description || "");
      const descHeight = doc.heightOfString(desc, { width: 260 });
      const rowHeight = Math.max(18, descHeight) + 10;
      ensureSpace(rowHeight + 4);
      doc.save();
      doc.strokeColor(border).lineWidth(0.5).moveTo(ml, y + rowHeight).lineTo(mr, y + rowHeight).stroke();
      doc.restore();
      doc.fillColor(ink).fontSize(9).text(desc, ml + 12, y + 5, { width: 260 });
      doc.fillColor(muted).fontSize(9).text(String(item.quantity ?? 1), ml + 308, y + 5, { width: 40, align: "right" });
      doc.text(money(item.unitPriceCents), ml + 364, y + 5, { width: 78, align: "right" });
      doc.fillColor(ink).text(money(item.amountCents), ml + 452, y + 5, { width: 92, align: "right" });
      y += rowHeight;
    }

    y += 14;
    ensureSpace(210);

    // Totals summary card
    const totalsCardW = 250;
    const totalsX = mr - totalsCardW;
    let totalsY = y;
    card(totalsX, totalsY, totalsCardW, 172);
    totalsY += 12;
    doc.fillColor(ink).fontSize(10).font("Helvetica-Bold").text("Billing Summary", totalsX + 14, totalsY);
    totalsY += 18;

    function totalsRow(label: string, value: string, opts?: { strong?: boolean; color?: string }) {
      const strong = !!opts?.strong;
      const color = opts?.color || muted;
      doc.fillColor(color).fontSize(strong ? 11 : 9).font(strong ? "Helvetica-Bold" : "Helvetica");
      doc.text(label, totalsX + 14, totalsY, { width: 140 });
      doc.text(value, totalsX + 14, totalsY, { width: totalsCardW - 28, align: "right" });
      doc.font("Helvetica");
      totalsY += strong ? 18 : 14;
    }

    totalsRow("Subtotal", money(invoice.subtotalCents ?? 0));
    const discountLine = lineItems.find((l: any) => l.type === "DISCOUNT");
    if (discountLine && discountLine.amountCents < 0) {
      totalsRow("Discount", money(discountLine.amountCents), { color: "#166534" });
    }
    if ((invoice.taxCents ?? 0) > 0) {
      totalsRow("Taxes & fees", money(invoice.taxCents));
    }
    if (regulatoryChargeCents > 0) {
      totalsRow("Regulatory charges", money(regulatoryChargeCents));
    }
    totalsY += 2;
    doc.save();
    doc.strokeColor(border).lineWidth(1).moveTo(totalsX + 14, totalsY).lineTo(totalsX + totalsCardW - 14, totalsY).stroke();
    doc.restore();
    totalsY += 8;
    totalsRow("Invoice total", money(invoice.totalCents), { strong: true, color: ink });
    if ((invoice.amountPaidCents ?? 0) > 0 && invoice.status === "PAID") {
      totalsRow("Amount paid", money(invoice.amountPaidCents), { color: "#166534" });
    }
    totalsY += 4;
    doc.save();
    doc.strokeColor(brandAccent).lineWidth(1).moveTo(totalsX + 14, totalsY).lineTo(totalsX + totalsCardW - 14, totalsY).stroke();
    doc.restore();
    totalsY += 8;
    doc.fillColor(ink).fontSize(12).font("Helvetica-Bold");
    doc.text("Balance due", totalsX + 14, totalsY, { width: 140 });
    doc.text(money(balanceDueCents), totalsX + 14, totalsY, { width: totalsCardW - 28, align: "right" });
    doc.font("Helvetica");
    y = Math.max(y, totalsY + 18);

    // Payment CTA card
    ensureSpace(128);
    card(ml, y, contentW, 96);
    doc.fillColor(ink).fontSize(10).font("Helvetica-Bold").text("Online Payment", ml + 14, y + 12);
    doc.font("Helvetica").fillColor(muted).fontSize(9).text(
      "Use the secure billing portal to pay this invoice. Keep your invoice number for reference.",
      ml + 14,
      y + 24,
      { width: contentW - 28 },
    );
    const btnX = ml + 14;
    const btnY = y + 50;
    const btnW = 170;
    const btnH = 26;
    doc.save();
    doc.fillColor("#0f172a").roundedRect(btnX, btnY, btnW, btnH, 6).fill();
    doc.restore();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10).text("Pay Invoice Securely", btnX + 18, btnY + 8);
    doc.link(btnX, btnY, btnW, btnH, payUrl);
    doc.font("Helvetica");
    doc.fillColor(muted).fontSize(8).text(`Fallback URL: ${payUrl}`, ml + 14, y + 80, { width: contentW - 28 });
    y += 110;

    // Optional payment instructions
    if (brand.paymentInstructions) {
      ensureSpace(64);
      card(ml, y, contentW, 52);
      doc.fillColor(ink).fontSize(9).font("Helvetica-Bold").text("Payment instructions", ml + 14, y + 10);
      doc.font("Helvetica");
      doc.fillColor(muted).fontSize(9).text(brand.paymentInstructions, ml + 14, y + 22, { width: contentW - 28, lineGap: 1 });
      y += 62;
    }

    // Support / dispute contact row
    if (brand.supportEmail || brand.supportPhone) {
      ensureSpace(34);
      const parts = [
        brand.supportEmail ? `Billing email: ${brand.supportEmail}` : null,
        brand.supportPhone ? `Billing phone: ${brand.supportPhone}` : null,
      ].filter(Boolean);
      doc.fillColor(muted).fontSize(8).text(parts.join("   ·   "), ml, y, { width: contentW });
      y += 14;
    }

    // Regulatory & Billing Notices section
    const noticesStartY = y + 10;
    const noticeCardH = 22 + notices.length * 13 + (brand.footerNote ? 20 : 0) + 22;
    ensureSpace(noticeCardH + 26);
    card(ml, noticesStartY, contentW, noticeCardH);
    doc.fillColor(ink).fontSize(10).font("Helvetica-Bold").text("Regulatory & Billing Notices", ml + 14, noticesStartY + 10);
    doc.font("Helvetica");
    let noticeY = noticesStartY + 24;
    for (const line of notices) {
      doc.fillColor(muted).fontSize(8.2).text(`• ${line}`, ml + 14, noticeY, { width: contentW - 28, lineGap: 1 });
      noticeY = doc.y + 2;
    }
    if (brand.paymentTermsDays) {
      doc.fillColor(muted).fontSize(8.2).text(`• Payment terms: Net ${brand.paymentTermsDays} days unless otherwise agreed in writing.`, ml + 14, noticeY, { width: contentW - 28, lineGap: 1 });
      noticeY = doc.y + 2;
    }
    if (brand.footerNote) {
      doc.fillColor(muted).fontSize(8.2).text(`• ${brand.footerNote}`, ml + 14, noticeY, { width: contentW - 28, lineGap: 1 });
      noticeY = doc.y + 2;
    }
    y = noticeY + 16;

    // Bottom print-safe footer
    doc.save();
    doc.strokeColor(border).lineWidth(0.5).moveTo(ml, y).lineTo(mr, y).stroke();
    doc.restore();
    y += 8;
    doc.fillColor("#64748b").fontSize(7.8).text(
      "This document is a billing statement generated for service accounting and payment operations. It is not tax or legal advice.",
      ml,
      y,
      { width: contentW, align: "left" },
    );

    // Paid watermark
    if (invoice.status === "PAID") {
      doc.save();
      doc.rotate(-22, { origin: [306, 396] });
      doc.fillOpacity(0.07).fillColor("#15803d").fontSize(72).font("Helvetica-Bold").text("PAID", 168, 370);
      doc.restore();
    }

    doc.end();
  });
}
