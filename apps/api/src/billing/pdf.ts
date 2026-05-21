import path from "node:path";
import fs from "node:fs";
import PDFDocument from "pdfkit";
import { money } from "./emailTemplates";
import { resolveInvoiceEmailBranding, sanitizePlainText } from "./invoiceBranding";

const BUNDLED_LOGO_PATH = path.join(__dirname, "assets", "connect-logo.png");

type InvoiceLineItem = {
  id?: string;
  type?: string | null;
  description?: string | null;
  quantity?: number | string | null;
  unitPriceCents?: number | null;
  amountCents?: number | null;
};

type TotalRow = {
  label: string;
  valueCents: number;
  tone?: "default" | "credit" | "paid" | "due" | "muted";
};

const CONNECT_LEGAL_NAME = "Connect Communications, LLC";
const CONNECT_SUPPORT_EMAIL = "support@connectcommunications.com";

function logoBuffer(): Buffer | null {
  try {
    if (fs.existsSync(BUNDLED_LOGO_PATH)) return fs.readFileSync(BUNDLED_LOGO_PATH);
  } catch {
    // Missing logo should never block invoice generation.
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

function formatDateShort(d: Date | string | null | undefined): string {
  if (!d) return "--";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "--";
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function statusLabel(status: string): string {
  const normalized = String(status || "").toUpperCase();
  const map: Record<string, string> = {
    PAID: "PAID",
    OPEN: "UNPAID",
    DRAFT: "DRAFT",
    FAILED: "UNPAID",
    OVERDUE: "OVERDUE",
    VOID: "VOID",
  };
  return map[normalized] ?? "UNPAID";
}

function normalizeText(value: unknown): string {
  return String(value || "").toLowerCase();
}

function classifyLineItem(item: InvoiceLineItem): { label: string; tone: "service" | "tax" | "fee" | "credit" } {
  const text = normalizeText(`${item.type || ""} ${item.description || ""}`);
  if (text.includes("discount") || text.includes("credit")) return { label: "Credit", tone: "credit" };
  if (text.includes("e911") || text.includes("911")) return { label: "E911", tone: "fee" };
  if (text.includes("usf") || text.includes("fusf") || text.includes("universal service")) return { label: "USF", tone: "fee" };
  if (text.includes("trs") || text.includes("relay")) return { label: "TRS", tone: "fee" };
  if (text.includes("regulatory") || text.includes("recovery") || text.includes("surcharge")) return { label: "Regulatory", tone: "fee" };
  if (text.includes("tax")) return { label: "Tax", tone: "tax" };
  return { label: "Service", tone: "service" };
}

function splitPlainText(value: unknown): string[] {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildTotalsRows(invoice: any, lineItems: InvoiceLineItem[]): TotalRow[] {
  const subtotal = Number(invoice.subtotalCents ?? 0);
  const total = Number(invoice.totalCents ?? 0);
  const balance = Number(invoice.balanceDueCents ?? total);
  const taxFromInvoice = Number(invoice.taxCents ?? 0);
  const paid = Math.max(0, Number(invoice.amountPaidCents ?? 0), total - balance);
  const discount = Math.abs(
    lineItems
      .filter((item) => classifyLineItem(item).tone === "credit")
      .reduce((sum, item) => sum + Math.min(0, Number(item.amountCents || 0)), 0),
  );
  const fees = lineItems
    .filter((item) => classifyLineItem(item).tone === "fee")
    .reduce((sum, item) => sum + Math.max(0, Number(item.amountCents || 0)), 0);
  const taxes = taxFromInvoice || lineItems
    .filter((item) => classifyLineItem(item).tone === "tax")
    .reduce((sum, item) => sum + Math.max(0, Number(item.amountCents || 0)), 0);

  const rows: TotalRow[] = [{ label: "Subtotal", valueCents: subtotal }];
  if (discount > 0) rows.push({ label: "Credits", valueCents: -discount, tone: "credit" });
  if (fees > 0) rows.push({ label: "Fees", valueCents: fees });
  if (taxes > 0) rows.push({ label: "Taxes", valueCents: taxes });
  if (paid > 0) rows.push({ label: "Amount paid", valueCents: -paid, tone: "paid" });
  rows.push({ label: "Balance due", valueCents: balance, tone: "due" });
  return rows;
}

function regulatoryNotices(brand: ReturnType<typeof resolveInvoiceEmailBranding>, invoice: any): string[] {
  const invoiceRef = invoice.invoiceNumber || invoice.id;
  const notices = [
    "Taxes and regulatory surcharges are calculated from your billing profile, service address, and applicable invoice line items.",
    "E911, USF/FUSF, TRS, and regulatory recovery charges may appear when applicable to your service configuration.",
    `Payment terms are Net ${brand.paymentTermsDays} days unless a separate written agreement applies.`,
    `For billing questions or disputes, contact ${CONNECT_SUPPORT_EMAIL} and include invoice ${invoiceRef}.`,
  ];
  return [...notices, ...splitPlainText(brand.footerNote)];
}

function roundedPanel(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, fill: string, stroke = "#e5e7eb", radius = 12) {
  doc.save();
  doc.roundedRect(x, y, w, h, radius).fillAndStroke(fill, stroke);
  doc.restore();
}

function label(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w: number, color = "#6b7280") {
  doc.fillColor(color).font("Helvetica-Bold").fontSize(7).text(text.toUpperCase(), x, y, {
    width: w,
    characterSpacing: 0.6,
  });
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number, top = 48): number {
  if (y + needed <= doc.page.height - 54) return y;
  doc.addPage();
  doc.rect(0, 0, doc.page.width, 5).fill("#2563eb");
  return top;
}

function textHeight(doc: PDFKit.PDFDocument, text: string, width: number, size: number, font = "Helvetica", lineGap = 1) {
  return doc.font(font).fontSize(size).heightOfString(text, { width, lineGap });
}

function drawStatusPill(doc: PDFKit.PDFDocument, statusText: string, x: number, y: number) {
  const paid = statusText === "PAID";
  const voided = statusText === "VOID" || statusText === "DRAFT";
  const bg = paid ? "#ecfdf3" : voided ? "#f3f4f6" : "#fff7ed";
  const fg = paid ? "#067647" : voided ? "#4b5563" : "#c2410c";
  const border = paid ? "#bbf7d0" : voided ? "#e5e7eb" : "#fed7aa";
  const width = Math.max(58, doc.font("Helvetica-Bold").fontSize(7.5).widthOfString(statusText) + 22);
  doc.roundedRect(x - width, y, width, 20, 10).fillAndStroke(bg, border);
  doc.fillColor(fg).font("Helvetica-Bold").fontSize(7.5).text(statusText, x - width, y + 6, { width, align: "center" });
}

function drawMiniIcon(doc: PDFKit.PDFDocument, icon: string, x: number, y: number, bg = "#eff6ff", fg = "#2563eb") {
  doc.roundedRect(x, y, 22, 22, 7).fill(bg);
  doc.fillColor(fg).font("Helvetica-Bold").fontSize(9).text(icon, x, y + 6, { width: 22, align: "center" });
}

export async function renderBillingInvoicePdf(invoice: any): Promise<Buffer> {
  const settings = invoice.tenant?.billingSettings || {};
  const tenantName = invoice.tenant?.name || "Customer";
  const brand = resolveInvoiceEmailBranding(settings, tenantName);
  const billingEmail = sanitizePlainText(settings.billingEmail, 320);
  const billToAddress = formatBillingAddress(settings.billingAddress);
  const serviceAddress = formatBillingAddress(settings.serviceAddress);
  const billTo = billToAddress || serviceAddress || tenantName;
  const payUrl = `${process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com"}/billing/invoices/${encodeURIComponent(invoice.id)}`;
  const logo = logoBuffer();
  const lineItems: InvoiceLineItem[] = invoice.lineItems || [];
  const statusText = statusLabel(invoice.status || "OPEN");
  const isPaid = statusText === "PAID";
  const balanceDue = Number(invoice.balanceDueCents ?? invoice.totalCents ?? 0);
  const showPayButton = !isPaid && balanceDue > 0;

  const ink = "#0f172a";
  const muted = "#64748b";
  const subtle = "#94a3b8";
  const blue = "#2563eb";
  const blueSoft = "#eff6ff";
  const panel = "#f8fafc";
  const line = "#e5e7eb";
  const lightLine = "#eef2f7";

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margin: 48,
      info: { Title: `Invoice ${invoice.invoiceNumber || invoice.id}` },
      bufferPages: false,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const ml = 48;
    const mr = pageW - 48;
    const contentW = mr - ml;

    doc.rect(0, 0, pageW, 5).fill(blue);
    doc.rect(0, 5, pageW, 100).fill("#ffffff");

    if (logo) {
      try {
        doc.image(logo, ml, 31, { fit: [150, 42] });
      } catch {
        doc.fillColor(ink).font("Helvetica-Bold").fontSize(14).text(CONNECT_LEGAL_NAME, ml, 38, { width: 210 });
      }
    } else {
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(14).text(CONNECT_LEGAL_NAME, ml, 38, { width: 210 });
    }

    doc.fillColor(subtle).font("Helvetica-Bold").fontSize(7.2).text("BUSINESS VOICE & COMMUNICATIONS", ml, 78, { width: 220, characterSpacing: 0.8 });
    drawStatusPill(doc, statusText, mr, 29);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(24).text("Invoice", ml + 300, 52, { width: contentW - 300, align: "right" });
    doc.fillColor(muted).font("Helvetica").fontSize(9.5).text(invoice.invoiceNumber || invoice.id, ml + 300, 80, { width: contentW - 300, align: "right" });
    doc.moveTo(ml, 106).lineTo(mr, 106).strokeColor(line).lineWidth(1).stroke();

    let y = 130;
    const gap = 16;
    const leftW = 328;
    const rightW = contentW - leftW - gap;
    const partyCardH = 142;
    roundedPanel(doc, ml, y, leftW, partyCardH, "#ffffff", line, 14);

    const colGap = 18;
    const colW = (leftW - 44 - colGap) / 2;
    label(doc, "Bill from", ml + 18, y + 18, colW);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(10.5).text(CONNECT_LEGAL_NAME, ml + 18, y + 36, { width: colW, lineGap: 1 });
    doc.fillColor(muted).font("Helvetica").fontSize(8.4).text(CONNECT_SUPPORT_EMAIL, ml + 18, doc.y + 6, { width: colW });

    const billX = ml + 18 + colW + colGap;
    label(doc, "Bill to", billX, y + 18, colW);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(10.5).text(tenantName, billX, y + 36, { width: colW, lineGap: 1 });
    let billY = doc.y + 6;
    if (billingEmail) {
      doc.fillColor(muted).font("Helvetica").fontSize(8.4).text(billingEmail, billX, billY, { width: colW });
      billY = doc.y + 4;
    }
    if (billTo && billTo !== tenantName) {
      doc.fillColor(muted).font("Helvetica").fontSize(8.2).text(billTo, billX, billY, { width: colW, lineGap: 1 });
    }

    const balanceX = ml + leftW + gap;
    roundedPanel(doc, balanceX, y, rightW, partyCardH, "#ffffff", "#dbeafe", 16);
    doc.roundedRect(balanceX + 1, y + 1, rightW - 2, partyCardH - 2, 15).strokeColor("#eff6ff").stroke();
    label(doc, "Balance due", balanceX + 18, y + 18, rightW - 36, blue);
    doc.fillColor(blue).font("Helvetica-Bold").fontSize(26).text(money(balanceDue), balanceX + 18, y + 38, { width: rightW - 36 });
    doc.fillColor(muted).font("Helvetica").fontSize(8.7).text(`Due ${formatDateShort(invoice.dueDate)} | Net ${brand.paymentTermsDays}`, balanceX + 18, y + 70, { width: rightW - 36 });
    if (showPayButton) {
      doc.roundedRect(balanceX + 18, y + 93, rightW - 36, 26, 9).fill(blue);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9).text("Pay Now Securely", balanceX + 18, y + 101, { width: rightW - 36, align: "center" });
      doc.link(balanceX + 18, y + 93, rightW - 36, 26, payUrl);
      doc.fillColor(subtle).font("Helvetica").fontSize(6.8).text(payUrl, balanceX + 18, y + 124, { width: rightW - 36, ellipsis: true });
    } else {
      doc.fillColor("#067647").font("Helvetica-Bold").fontSize(9).text("No payment due", balanceX + 18, y + 99, { width: rightW - 36 });
    }

    y += partyCardH + 20;

    const meta = [
      ["Issue date", formatDateShort(invoice.createdAt || invoice.issueDate)],
      ["Due date", formatDateShort(invoice.dueDate)],
      ["Service period", `${formatDateShort(invoice.periodStart)} - ${formatDateShort(invoice.periodEnd)}`],
      ["Terms", `Net ${brand.paymentTermsDays}`],
    ];
    const metaW = contentW / meta.length;
    doc.roundedRect(ml, y, contentW, 56, 13).fillAndStroke(panel, line);
    meta.forEach(([k, v], idx) => {
      const x = ml + idx * metaW;
      if (idx > 0) doc.moveTo(x, y + 12).lineTo(x, y + 44).strokeColor(line).lineWidth(0.5).stroke();
      label(doc, k, x + 14, y + 13, metaW - 28);
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(9).text(v, x + 14, y + 31, { width: metaW - 28 });
    });
    y += 78;

    label(doc, "Invoice details", ml, y, 180);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(16).text("Line items", ml, y + 14);
    y += 42;

    const descW = 288;
    const qtyX = ml + 330;
    const rateX = ml + 388;
    const amtX = ml + 474;
    doc.roundedRect(ml, y, contentW, 30, 10).fill(panel);
    doc.fillColor(muted).font("Helvetica-Bold").fontSize(7.2);
    doc.text("DESCRIPTION", ml + 14, y + 10, { width: descW });
    doc.text("QTY", qtyX, y + 10, { width: 42, align: "right" });
    doc.text("RATE", rateX, y + 10, { width: 72, align: "right" });
    doc.text("AMOUNT", amtX, y + 10, { width: 70, align: "right" });
    y += 40;

    for (const item of lineItems) {
      y = ensureSpace(doc, y, 54);
      const classification = classifyLineItem(item);
      const description = String(item.description || "Billing item");
      const descriptionH = textHeight(doc, description, descW, 9, "Helvetica-Bold", 1);
      const rowH = Math.max(48, descriptionH + 26);
      doc.moveTo(ml, y - 6).lineTo(mr, y - 6).strokeColor(lightLine).lineWidth(0.6).stroke();
      doc.roundedRect(ml + 14, y + 2, Math.max(36, doc.font("Helvetica-Bold").fontSize(6.5).widthOfString(classification.label) + 14), 14, 7).fill(classification.tone === "credit" ? "#ecfdf3" : classification.tone === "service" ? blueSoft : "#f3f4f6");
      doc.fillColor(classification.tone === "credit" ? "#047857" : classification.tone === "service" ? "#0e7490" : "#475569")
        .font("Helvetica-Bold")
        .fontSize(6.5)
        .text(classification.label.toUpperCase(), ml + 21, y + 6);
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(9).text(description, ml + 14, y + 22, { width: descW, lineGap: 1 });
      doc.fillColor(muted).font("Helvetica").fontSize(8.8).text(String(item.quantity ?? 1), qtyX, y + 23, { width: 42, align: "right" });
      doc.text(money(item.unitPriceCents ?? 0), rateX, y + 23, { width: 72, align: "right" });
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(8.9).text(money(item.amountCents ?? 0), amtX, y + 23, { width: 70, align: "right" });
      y += rowH;
    }

    if (lineItems.length === 0) {
      doc.fillColor(muted).font("Helvetica").fontSize(9).text("No line items are attached to this invoice.", ml, y, { width: contentW, align: "center" });
      y += 28;
    }

    y += 12;
    y = ensureSpace(doc, y, 132);

    const notesW = contentW - 232;
    const summaryW = 212;
    const summaryX = mr - summaryW;
    const bottomY = y;
    const summaryRows = buildTotalsRows(invoice, lineItems);
    const notesH = 112;
    const summaryH = Math.max(notesH, 42 + summaryRows.length * 18 + 24);

    roundedPanel(doc, ml, bottomY, notesW, summaryH, "#ffffff", line, 14);
    label(doc, "Notes", ml + 16, bottomY + 18, notesW - 32);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(10.5).text("Thank you for choosing Connect.", ml + 16, bottomY + 38, { width: notesW - 32 });
    doc.fillColor(muted).font("Helvetica").fontSize(8.3).text(`Questions about this invoice? Contact ${CONNECT_SUPPORT_EMAIL}.`, ml + 16, bottomY + 58, { width: notesW - 32, lineGap: 2 });
    if (showPayButton) {
      doc.roundedRect(ml + 16, bottomY + 84, 116, 24, 8).fill(blue);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5).text("Pay Now", ml + 16, bottomY + 92, { width: 116, align: "center" });
      doc.link(ml + 16, bottomY + 84, 116, 24, payUrl);
      doc.fillColor(subtle).font("Helvetica").fontSize(6.8).text(payUrl, ml + 144, bottomY + 91, { width: notesW - 160, ellipsis: true });
    }

    roundedPanel(doc, summaryX, bottomY, summaryW, summaryH, "#ffffff", line, 14);
    label(doc, "Billing summary", summaryX + 16, bottomY + 18, summaryW - 32);
    let sy = bottomY + 42;
    summaryRows.forEach((row) => {
      const isDue = row.tone === "due";
      doc.fillColor(row.tone === "credit" || row.tone === "paid" ? "#047857" : isDue ? blue : "#475569")
        .font(isDue ? "Helvetica-Bold" : "Helvetica")
        .fontSize(isDue ? 11 : 8.5);
      doc.text(row.label, summaryX + 16, sy, { width: 98 });
      doc.font("Helvetica-Bold").text(money(row.valueCents), summaryX + 116, sy, { width: 80, align: "right" });
      sy += isDue ? 23 : 18;
      if (!isDue) doc.moveTo(summaryX + 16, sy - 5).lineTo(summaryX + summaryW - 16, sy - 5).strokeColor(lightLine).lineWidth(0.4).stroke();
    });

    y = bottomY + summaryH + 22;
    y = ensureSpace(doc, y, 166);

    roundedPanel(doc, ml, y, contentW, 150, "#ffffff", line, 14);
    drawMiniIcon(doc, "i", ml + 16, y + 18);
    label(doc, "Regulatory & billing notices", ml + 50, y + 18, 260);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(12.5).text("Telecom billing disclosures", ml + 50, y + 36, { width: 260 });
    const noticeX = ml + 300;
    let noticeY = y + 18;
    regulatoryNotices(brand, invoice).slice(0, 5).forEach((notice, idx) => {
      const h = textHeight(doc, notice, mr - noticeX - 16, 7.4, "Helvetica", 1);
      doc.fillColor(blue).font("Helvetica-Bold").fontSize(7.2).text(String(idx + 1).padStart(2, "0"), noticeX, noticeY, { width: 16 });
      doc.fillColor("#475569").font("Helvetica").fontSize(7.4).text(notice, noticeX + 24, noticeY, { width: mr - noticeX - 24, lineGap: 1 });
      noticeY += h + 7;
    });
    y += 174;

    y = ensureSpace(doc, y, 58);
    doc.moveTo(ml, y).lineTo(mr, y).strokeColor(line).lineWidth(0.8).stroke();
    y += 18;
    const footerItems = [
      ["?", "Billing Support", CONNECT_SUPPORT_EMAIL],
      [">", "Customer Portal", "app.connectcomunications.com"],
      ["$", "Secure Payments", "Encrypted card processing"],
      ["OK", "Thank You", "We appreciate your business"],
    ];
    const footerW = contentW / footerItems.length;
    footerItems.forEach(([icon, title, text], idx) => {
      const x = ml + idx * footerW;
      drawMiniIcon(doc, icon, x, y, idx === 0 ? "#eff6ff" : "#f8fafc", idx === 0 ? blue : "#64748b");
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(8.2).text(title, x + 28, y + 1, { width: footerW - 32 });
      doc.fillColor(muted).font("Helvetica").fontSize(7.2).text(text, x + 28, y + 13, { width: footerW - 32 });
    });

    if (invoice.status === "PAID") {
      doc.save();
      doc.rotate(-22, { origin: [306, 396] });
      doc.fillOpacity(0.07).fillColor("#15803d").fontSize(72).font("Helvetica-Bold").text("PAID", 166, 362);
      doc.restore();
    }

    doc.end();
  });
}
