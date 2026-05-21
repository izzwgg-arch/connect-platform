import path from "node:path";
import fs from "node:fs";
import PDFDocument from "pdfkit";
import { money } from "./emailTemplates";
import { resolveInvoiceEmailBranding, sanitizePlainText } from "./invoiceBranding";

const BUNDLED_LOGO_PATH = path.join(__dirname, "assets", "connect-logo.png");

const CONNECT_LEGAL_NAME = "Connect Communications, LLC";
const CONNECT_SUPPORT_EMAIL = "support@connectcommunications.com";
const CONNECT_PHONE = "(949) 123-4567";
const CONNECT_WEBSITE = "connectcommunications.com";
const CONNECT_ADDRESS_LINES = ["500 Spectrum Center Dr, Suite 1150", "Irvine, CA 92618"];
const CONNECT_PORTAL_HOST = "app.connectcommunications.com";
const CONNECT_PAY_PATH = "/pay";

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
  tone?: "default" | "credit" | "paid" | "due";
};

function logoBuffer(): Buffer | null {
  try {
    if (fs.existsSync(BUNDLED_LOGO_PATH)) return fs.readFileSync(BUNDLED_LOGO_PATH);
  } catch {
    // Missing logo should never block invoice generation.
  }
  return null;
}

function sanitizeLine(value: unknown, max = 240): string {
  return sanitizePlainText(value, max) || "";
}

function formatBillingAddress(addr: unknown): string[] {
  if (!addr || typeof addr !== "object") return [];
  const o = addr as Record<string, unknown>;
  const line1 = sanitizeLine(o.line1 ?? o.address1 ?? o.street, 200);
  const line2 = sanitizeLine(o.line2 ?? o.address2, 200);
  const city = sanitizeLine(o.city, 120);
  const region = sanitizeLine(o.state ?? o.region, 80);
  const postal = sanitizeLine(o.postalCode ?? o.zip, 32);
  return [line1, line2, [city, region, postal].filter(Boolean).join(", ")].filter(Boolean);
}

function formatDateShort(d: Date | string | null | undefined): string {
  if (!d) return "--";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "--";
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function statusLabel(status: string): string {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "PAID") return "PAID";
  if (normalized === "VOID") return "VOID";
  if (normalized === "DRAFT") return "DRAFT";
  return "UNPAID";
}

function normalizeText(value: unknown): string {
  return String(value || "").toLowerCase();
}

function classifyLineItem(item: InvoiceLineItem): "tax" | "fee" | "credit" | "default" {
  const text = normalizeText(`${item.type || ""} ${item.description || ""}`);
  if (text.includes("discount") || text.includes("credit")) return "credit";
  if (text.includes("tax")) return "tax";
  if (
    text.includes("e911")
    || text.includes("911")
    || text.includes("usf")
    || text.includes("fusf")
    || text.includes("trs")
    || text.includes("relay")
    || text.includes("regulatory")
    || text.includes("recovery")
    || text.includes("surcharge")
    || text.includes("fee")
  ) return "fee";
  return "default";
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
  const fees = lineItems
    .filter((item) => classifyLineItem(item) === "fee")
    .reduce((sum, item) => sum + Math.max(0, Number(item.amountCents || 0)), 0);
  const taxes = taxFromInvoice || lineItems
    .filter((item) => classifyLineItem(item) === "tax")
    .reduce((sum, item) => sum + Math.max(0, Number(item.amountCents || 0)), 0);

  const rows: TotalRow[] = [
    { label: "Subtotal", valueCents: subtotal },
    { label: "Tax", valueCents: taxes },
    { label: "Telecom surcharges", valueCents: fees },
    { label: "Invoice total", valueCents: total },
    { label: "Amount paid", valueCents: -paid, tone: "paid" },
    { label: "Balance due", valueCents: balance, tone: "due" },
  ];
  return rows;
}

function roundedPanel(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, fill = "#ffffff", stroke = "#e5e7eb", radius = 8) {
  doc.save();
  doc.roundedRect(x, y, w, h, radius).fillAndStroke(fill, stroke);
  doc.restore();
}

function label(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w: number, color = "#2563eb") {
  doc.fillColor(color).font("Helvetica-Bold").fontSize(6.8).text(text.toUpperCase(), x, y, {
    width: w,
    characterSpacing: 0.7,
  });
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number, top = 46): number {
  if (y + needed <= doc.page.height - 42) return y;
  doc.addPage();
  doc.rect(0, 0, doc.page.width, 5).fill("#2563eb");
  return top;
}

function textHeight(doc: PDFKit.PDFDocument, text: string, width: number, size: number, font = "Helvetica", lineGap = 1) {
  return doc.font(font).fontSize(size).heightOfString(text, { width, lineGap });
}

function drawStatusPill(doc: PDFKit.PDFDocument, statusText: string, x: number, y: number) {
  const paid = statusText === "PAID";
  const muted = statusText === "VOID" || statusText === "DRAFT";
  const bg = paid ? "#ecfdf3" : muted ? "#f3f4f6" : "#fff1f2";
  const fg = paid ? "#067647" : muted ? "#4b5563" : "#b42318";
  const border = paid ? "#bbf7d0" : muted ? "#e5e7eb" : "#fecdd3";
  const width = Math.max(52, doc.font("Helvetica-Bold").fontSize(6.5).widthOfString(statusText) + 18);
  doc.roundedRect(x - width, y, width, 17, 8.5).fillAndStroke(bg, border);
  doc.fillColor(fg).font("Helvetica-Bold").fontSize(6.5).text(statusText, x - width, y + 5.3, { width, align: "center" });
}

function drawIconBox(doc: PDFKit.PDFDocument, icon: string, x: number, y: number, blue = true) {
  const stroke = blue ? "#2563eb" : "#64748b";
  const fill = blue ? "#eff6ff" : "#f8fafc";
  doc.roundedRect(x, y, 16, 16, 4).fillAndStroke(fill, "#dbe3ef");
  doc.fillColor(stroke).font("Helvetica-Bold").fontSize(icon.length > 1 ? 5.7 : 7.2).text(icon, x, y + 5, { width: 16, align: "center" });
}

function drawCalendarIcon(doc: PDFKit.PDFDocument, x: number, y: number) {
  doc.roundedRect(x, y, 14, 14, 2).strokeColor("#2563eb").lineWidth(0.8).stroke();
  doc.moveTo(x, y + 4).lineTo(x + 14, y + 4).stroke();
  doc.moveTo(x + 4, y - 1).lineTo(x + 4, y + 2).stroke();
  doc.moveTo(x + 10, y - 1).lineTo(x + 10, y + 2).stroke();
  doc.circle(x + 5, y + 8, 0.7).fill("#2563eb");
  doc.circle(x + 9, y + 8, 0.7).fill("#2563eb");
}

function drawShieldIcon(doc: PDFKit.PDFDocument, x: number, y: number) {
  doc.save();
  doc.moveTo(x + 7, y).lineTo(x + 13, y + 3).lineTo(x + 11, y + 11).lineTo(x + 7, y + 14).lineTo(x + 3, y + 11).lineTo(x + 1, y + 3).closePath();
  doc.strokeColor("#64748b").lineWidth(0.8).stroke();
  doc.moveTo(x + 4.2, y + 7).lineTo(x + 6.2, y + 9.2).lineTo(x + 10, y + 5.2).stroke();
  doc.restore();
}

function drawSupportIcon(doc: PDFKit.PDFDocument, x: number, y: number) {
  doc.circle(x + 7, y + 7, 6).strokeColor("#64748b").lineWidth(0.8).stroke();
  doc.moveTo(x + 1, y + 8).lineTo(x + 1, y + 12).stroke();
  doc.moveTo(x + 13, y + 8).lineTo(x + 13, y + 12).stroke();
  doc.circle(x + 11, y + 13, 1).fill("#64748b");
}

function payFallbackUrl(): string {
  return `${CONNECT_PORTAL_HOST}${CONNECT_PAY_PATH}`;
}

export async function renderBillingInvoicePdf(invoice: any): Promise<Buffer> {
  const settings = invoice.tenant?.billingSettings || {};
  const tenantName = invoice.tenant?.name || "Customer";
  const brand = resolveInvoiceEmailBranding(settings, tenantName);
  const billingEmail = sanitizeLine(settings.billingEmail, 320);
  const billToAddress = formatBillingAddress(settings.billingAddress);
  const serviceAddress = formatBillingAddress(settings.serviceAddress);
  const billToLines = (billToAddress.length ? billToAddress : serviceAddress).slice(0, 4);
  const payUrl = `${process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com"}/billing/invoices/${encodeURIComponent(invoice.id)}`;
  const logo = logoBuffer();
  const lineItems: InvoiceLineItem[] = invoice.lineItems || [];
  const statusText = statusLabel(invoice.status || "OPEN");
  const isPaid = statusText === "PAID";
  const balanceDue = Number(invoice.balanceDueCents ?? invoice.totalCents ?? 0);
  const showPayButton = !isPaid && balanceDue > 0;

  const ink = "#0f172a";
  const text = "#334155";
  const muted = "#64748b";
  const subtle = "#94a3b8";
  const blue = "#2563eb";
  const panel = "#f8fafc";
  const line = "#e5e7eb";
  const lightLine = "#eef2f7";

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margin: 0,
      info: { Title: `Invoice ${invoice.invoiceNumber || invoice.id}` },
      bufferPages: false,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const ml = 36;
    const mr = pageW - 36;
    const contentW = mr - ml;

    doc.rect(0, 0, pageW, 6).fill(blue);

    // Header: logo left, invoice title/number right.
    if (logo) {
      try {
        doc.image(logo, ml + 2, 34, { fit: [155, 48] });
      } catch {
        doc.fillColor(ink).font("Helvetica-Bold").fontSize(15).text(CONNECT_LEGAL_NAME, ml, 44, { width: 210 });
      }
    } else {
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(15).text(CONNECT_LEGAL_NAME, ml, 44, { width: 210 });
    }

    doc.fillColor(ink).font("Helvetica-Bold").fontSize(23).text("INVOICE", mr - 170, 31, { width: 170, align: "right" });
    doc.fillColor(blue).font("Helvetica-Bold").fontSize(10.2).text(invoice.invoiceNumber || invoice.id, mr - 170, 61, { width: 170, align: "right" });
    doc.fillColor(muted).font("Helvetica").fontSize(7.7).text(`Issued ${formatDateShort(invoice.createdAt || invoice.issueDate)}`, mr - 170, 79, { width: 170, align: "right" });
    drawStatusPill(doc, statusText, mr - 18, 101);

    // Bill-from and bill-to column block with a vertical separator like the reference.
    const infoY = 138;
    const billFromX = ml + 3;
    const billToX = ml + 220;
    doc.moveTo(ml + 192, infoY - 7).lineTo(ml + 192, infoY + 122).strokeColor(line).lineWidth(0.7).stroke();

    label(doc, "Bill from", billFromX, infoY, 150);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(8.8).text(CONNECT_LEGAL_NAME, billFromX, infoY + 20, { width: 160 });
    let fromY = doc.y + 8;
    for (const value of [...CONNECT_ADDRESS_LINES, CONNECT_SUPPORT_EMAIL, CONNECT_PHONE, CONNECT_WEBSITE]) {
      doc.fillColor(text).font("Helvetica").fontSize(7.4).text(value, billFromX, fromY, { width: 160, lineGap: 1 });
      fromY = doc.y + 6;
    }

    label(doc, "Bill to", billToX, infoY, 150);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(8.8).text(tenantName, billToX, infoY + 20, { width: 142 });
    let toY = doc.y + 8;
    for (const value of [...billToLines, billingEmail].filter(Boolean).slice(0, 5)) {
      doc.fillColor(text).font("Helvetica").fontSize(7.4).text(value, billToX, toY, { width: 142, lineGap: 1 });
      toY = doc.y + 6;
    }

    // Balance due card.
    const cardW = 192;
    const cardH = 172;
    const cardX = mr - cardW - 4;
    const cardY = 128;
    roundedPanel(doc, cardX, cardY, cardW, cardH, "#ffffff", "#dfe7f2", 7);
    doc.roundedRect(cardX + 2, cardY + 2, cardW - 4, cardH - 4, 6).strokeColor("#f3f6fb").lineWidth(0.6).stroke();
    label(doc, "Balance due", cardX + 18, cardY + 18, cardW - 36, "#334155");
    doc.fillColor(blue).font("Helvetica-Bold").fontSize(30).text(money(balanceDue), cardX + 18, cardY + 37, { width: cardW - 36 });
    drawCalendarIcon(doc, cardX + 18, cardY + 76);
    doc.fillColor(text).font("Helvetica").fontSize(7.3).text(`Due on ${formatDateShort(invoice.dueDate)}`, cardX + 39, cardY + 75, { width: cardW - 58 });
    doc.fillColor(muted).font("Helvetica").fontSize(7.1).text(`Net ${brand.paymentTermsDays} days`, cardX + 39, cardY + 88, { width: cardW - 58 });
    if (showPayButton) {
      doc.roundedRect(cardX + 18, cardY + 107, cardW - 36, 29, 5).fill(blue);
      drawIconBox(doc, "$", cardX + 45, cardY + 113, false);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5).text("Pay Now Securely", cardX + 18, cardY + 117, { width: cardW - 36, align: "center" });
      doc.link(cardX + 18, cardY + 107, cardW - 36, 29, payUrl);
      doc.fillColor(muted).font("Helvetica").fontSize(6.6).text("Or pay online at", cardX + 38, cardY + 150, { width: cardW - 56 });
      doc.fillColor(blue).font("Helvetica-Bold").fontSize(6.6).text(payFallbackUrl(), cardX + 38, cardY + 160, { width: cardW - 56 });
    } else {
      doc.fillColor("#067647").font("Helvetica-Bold").fontSize(8.5).text("Paid in full", cardX + 18, cardY + 113, { width: cardW - 36 });
    }

    // Divider and metadata row.
    let y = 318;
    doc.moveTo(ml, y).lineTo(mr, y).strokeColor(line).lineWidth(0.8).stroke();
    y += 22;
    const meta = [
      ["Issue date", formatDateShort(invoice.createdAt || invoice.issueDate), "cal"],
      ["Due date", formatDateShort(invoice.dueDate), "cal"],
      ["Service period", `${formatDateShort(invoice.periodStart)} - ${formatDateShort(invoice.periodEnd)}`, "cal"],
      ["Terms", `Net ${brand.paymentTermsDays} days`, "shield"],
    ];
    const metaW = contentW / meta.length;
    meta.forEach(([k, v, icon], idx) => {
      const x = ml + idx * metaW + 12;
      if (idx > 0) doc.moveTo(ml + idx * metaW, y - 4).lineTo(ml + idx * metaW, y + 34).strokeColor(lightLine).lineWidth(0.7).stroke();
      if (icon === "shield") drawShieldIcon(doc, x, y + 3);
      else drawCalendarIcon(doc, x, y + 3);
      label(doc, k, x + 23, y, metaW - 34, muted);
      doc.fillColor(k === "Due date" && !isPaid ? "#b42318" : ink).font("Helvetica-Bold").fontSize(7.6).text(v, x + 23, y + 15, { width: metaW - 34 });
    });
    y += 55;

    // Line items table: no badges, no extra section heading.
    const descW = 300;
    const qtyX = ml + 350;
    const rateX = ml + 424;
    const amtX = ml + 512;
    doc.roundedRect(ml, y, contentW, 27, 6).fillAndStroke(panel, line);
    doc.fillColor(muted).font("Helvetica-Bold").fontSize(6.8);
    doc.text("DESCRIPTION", ml + 16, y + 10, { width: descW });
    doc.text("QTY", qtyX, y + 10, { width: 42, align: "right" });
    doc.text("UNIT PRICE", rateX, y + 10, { width: 70, align: "right" });
    doc.text("AMOUNT", amtX, y + 10, { width: 64, align: "right" });
    y += 27;

    for (const item of lineItems) {
      y = ensureSpace(doc, y, 34);
      const description = String(item.description || "Billing item");
      const descriptionH = textHeight(doc, description, descW, 7.8, "Helvetica-Bold", 1);
      const rowH = Math.max(28, descriptionH + 14);
      doc.moveTo(ml, y).lineTo(mr, y).strokeColor(lightLine).lineWidth(0.7).stroke();
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(7.8).text(description, ml + 16, y + 10, { width: descW, lineGap: 1 });
      doc.fillColor(ink).font("Helvetica").fontSize(7.5).text(String(item.quantity ?? 1), qtyX, y + 10, { width: 42, align: "right" });
      doc.text(money(item.unitPriceCents ?? 0), rateX, y + 10, { width: 70, align: "right" });
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(7.5).text(money(item.amountCents ?? 0), amtX, y + 10, { width: 64, align: "right" });
      y += rowH;
    }
    if (lineItems.length === 0) {
      doc.moveTo(ml, y).lineTo(mr, y).strokeColor(lightLine).lineWidth(0.7).stroke();
      doc.fillColor(muted).font("Helvetica").fontSize(8).text("No line items are attached to this invoice.", ml, y + 12, { width: contentW, align: "center" });
      y += 36;
    }
    doc.moveTo(ml, y).lineTo(mr, y).strokeColor(lightLine).lineWidth(0.7).stroke();
    y += 20;

    // Notes and totals split.
    y = ensureSpace(doc, y, 134);
    const notesW = 226;
    const totalsW = 278;
    const notesH = 94;
    const splitY = y;
    roundedPanel(doc, ml, splitY, notesW, notesH, "#ffffff", line, 6);
    drawIconBox(doc, "?", ml + 16, splitY + 15);
    doc.fillColor(blue).font("Helvetica-Bold").fontSize(8.4).text("Notes", ml + 40, splitY + 17, { width: notesW - 56 });
    const noteCopy = splitPlainText(brand.footerNote)[0] || "Thank you for your business. If you have any questions about this invoice, please contact our billing support team.";
    doc.fillColor(muted).font("Helvetica").fontSize(7.4).text(noteCopy, ml + 16, splitY + 45, { width: notesW - 32, lineGap: 2 });

    const totalsX = mr - totalsW;
    roundedPanel(doc, totalsX, splitY - 8, totalsW, notesH + 28, "#ffffff", line, 6);
    let ty = splitY + 8;
    buildTotalsRows(invoice, lineItems).forEach((row) => {
      const due = row.tone === "due";
      const bold = due || row.label === "Invoice total";
      if (due) {
        doc.moveTo(totalsX + 14, ty - 6).lineTo(totalsX + totalsW - 14, ty - 6).strokeColor(lightLine).lineWidth(0.7).stroke();
      }
      doc.fillColor(due ? blue : row.tone === "paid" ? "#047857" : ink).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(due ? 11 : 7.8);
      doc.text(row.label, totalsX + 16, ty, { width: 145 });
      doc.font("Helvetica-Bold").text(money(row.valueCents), totalsX + 186, ty, { width: 76, align: "right" });
      ty += due ? 20 : 16;
    });
    y = splitY + notesH + 34;

    // Regulatory card, closely matching the four-column reference.
    y = ensureSpace(doc, y, 152);
    const regH = 136;
    roundedPanel(doc, ml, y, contentW, regH, "#ffffff", line, 6);
    label(doc, "Regulatory & billing notices", ml + 16, y + 14, contentW - 32);
    doc.moveTo(ml + 16, y + 30).lineTo(mr - 16, y + 30).strokeColor(line).lineWidth(0.7).stroke();
    const noticeCols = [
      ["911", "E911 Service", "E911 fees and surcharges may apply and are used to support emergency calling systems in your area."],
      ["DOC", "Regulatory Recovery", "Regulatory recovery fees may apply to recover costs associated with compliance and regulatory obligations."],
      ["$", "Taxes & Surcharges", "Applicable federal, state, local taxes and telecom surcharges may apply."],
      ["i", "More Information", "For a complete list of applicable terms and disclosures, please visit our billing portal."],
    ];
    const noticeW = (contentW - 32) / noticeCols.length;
    noticeCols.forEach(([icon, title, body], idx) => {
      const x = ml + 16 + idx * noticeW;
      if (idx > 0) doc.moveTo(x, y + 42).lineTo(x, y + 102).strokeColor(lightLine).lineWidth(0.7).stroke();
      drawIconBox(doc, icon, x + 2, y + 45, false);
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(7.3).text(title, x + 26, y + 45, { width: noticeW - 32 });
      doc.fillColor(text).font("Helvetica").fontSize(6.6).text(body, x + 26, y + 62, { width: noticeW - 36, lineGap: 1.2 });
    });
    doc.fillColor(text).font("Helvetica").fontSize(6.6).text(
      "Charges on this invoice are for telecommunications services and related products. Connect Communications, LLC is not responsible for government taxes or fees. For billing disputes, contact us within 60 days of the invoice date.",
      ml + 54,
      y + 108,
      { width: contentW - 108, align: "center", lineGap: 1 },
    );
    y += regH + 16;

    // Footer support row.
    y = ensureSpace(doc, y, 82);
    const footerH = 58;
    const footerW = contentW / 4;
    const footers = [
      ["support", "Billing Support", "Mon - Fri, 8am - 6pm PT\n(949) 123-4567\nsupport@connectcommunications.com"],
      ["portal", "Customer Portal", "View invoices, make payments,\nand manage your account.\napp.connectcommunications.com"],
      ["shield", "Secure Payments", "Your payments are\nencrypted and secure."],
      ["globe", "Thank You", "We appreciate your\nbusiness!"],
    ];
    footers.forEach(([icon, title, body], idx) => {
      const x = ml + idx * footerW;
      if (idx > 0) doc.moveTo(x, y + 2).lineTo(x, y + footerH - 6).strokeColor(lightLine).lineWidth(0.7).stroke();
      if (icon === "support") drawSupportIcon(doc, x + 10, y + 5);
      else if (icon === "shield") drawShieldIcon(doc, x + 10, y + 5);
      else drawIconBox(doc, icon === "portal" ? "PC" : "G", x + 9, y + 4, false);
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(7.2).text(title, x + 34, y + 4, { width: footerW - 42 });
      doc.fillColor(muted).font("Helvetica").fontSize(6.4).text(body, x + 34, y + 18, { width: footerW - 42, lineGap: 1.1 });
    });
    y += footerH + 4;
    doc.fillColor(muted).font("Helvetica").fontSize(6.4).text(
      `${CONNECT_LEGAL_NAME}   *   ${CONNECT_ADDRESS_LINES.join(", ")}   *   ${CONNECT_WEBSITE}`,
      ml,
      y,
      { width: contentW, align: "center" },
    );

    if (invoice.status === "PAID") {
      doc.save();
      doc.rotate(-22, { origin: [306, 396] });
      doc.fillOpacity(0.055).fillColor("#15803d").fontSize(70).font("Helvetica-Bold").text("PAID", 170, 360);
      doc.restore();
    }

    doc.end();
  });
}
