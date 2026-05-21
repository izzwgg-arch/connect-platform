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
  const map: Record<string, string> = {
    PAID: "PAID",
    OPEN: "PENDING",
    DRAFT: "DRAFT",
    FAILED: "PAYMENT FAILED",
    OVERDUE: "OVERDUE",
    VOID: "VOID",
  };
  return map[String(status || "").toUpperCase()] ?? String(status || "OPEN").toUpperCase();
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

  const rows: TotalRow[] = [{ label: "Service subtotal", valueCents: subtotal }];
  if (discount > 0) rows.push({ label: "Discounts / credits", valueCents: -discount, tone: "credit" });
  if (fees > 0) rows.push({ label: "Telecom fees & surcharges", valueCents: fees });
  if (taxes > 0) rows.push({ label: "Taxes", valueCents: taxes });
  if (paid > 0) rows.push({ label: "Amount paid", valueCents: -paid, tone: "paid" });
  rows.push({ label: "Balance due", valueCents: balance, tone: "due" });
  return rows;
}

function regulatoryNotices(brand: ReturnType<typeof resolveInvoiceEmailBranding>, invoice: any): string[] {
  const support = [brand.supportEmail, brand.supportPhone].filter(Boolean).join(" or ");
  const invoiceRef = invoice.invoiceNumber || invoice.id;
  const notices = [
    "Taxes, telecom fees, and regulatory surcharges are itemized when applicable to your service, service address, jurisdiction, and configured billing profile.",
    "E911 charges, if shown, support emergency calling obligations and may vary by location, number count, or service configuration.",
    "Regulatory recovery, Federal Universal Service Fund (USF/FUSF), and Telecommunications Relay Service (TRS) related charges are displayed when applicable; they are not represented here as taxes unless labeled as taxes.",
    `Payment terms are Net ${brand.paymentTermsDays} days unless a different written agreement applies. Past-due balances may be subject to collection handling or late-fee policies configured by your provider.`,
    support
      ? `For billing questions, disputes, or remittance support, contact ${support}. Include invoice ${invoiceRef} with your request.`
      : `For billing questions, disputes, or remittance support, contact your Connect billing administrator and include invoice ${invoiceRef}.`,
  ];
  return [...notices, ...splitPlainText(brand.footerNote)];
}

function roundedPanel(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, fill: string, stroke = "#e2e8f0") {
  doc.save();
  doc.roundedRect(x, y, w, h, 14).fillAndStroke(fill, stroke);
  doc.restore();
}

function label(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w: number, color = "#64748b") {
  doc.fillColor(color).font("Helvetica-Bold").fontSize(7.5).text(text.toUpperCase(), x, y, {
    width: w,
    characterSpacing: 0.6,
  });
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number, top = 48): number {
  if (y + needed <= doc.page.height - 54) return y;
  doc.addPage();
  return top;
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

  const ink = "#0f172a";
  const muted = "#64748b";
  const slate = "#111827";
  const cyan = "#0891b2";
  const cyanSoft = "#ecfeff";
  const panel = "#f8fafc";
  const line = "#e2e8f0";

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

    // Subtle brand rail instead of a bright blue header block.
    doc.rect(0, 0, pageW, 7).fill(cyan);
    doc.rect(0, 7, pageW, 92).fill("#ffffff");
    doc.moveTo(ml, 99).lineTo(mr, 99).strokeColor(line).lineWidth(1).stroke();

    if (logo) {
      try {
        doc.image(logo, ml, 32, { fit: [160, 44] });
      } catch {
        doc.fillColor(ink).font("Helvetica-Bold").fontSize(15).text(brand.displayName, ml, 40, { width: 190 });
      }
    } else {
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(15).text(brand.displayName, ml, 40, { width: 190 });
    }

    doc.fillColor(muted).font("Helvetica-Bold").fontSize(7.5).text("ENTERPRISE VOIP BILLING", ml, 78, {
      width: 210,
      characterSpacing: 0.7,
    });

    const statusText = statusLabel(invoice.status || "OPEN");
    const chipColors: Record<string, [string, string]> = {
      PAID: ["#ecfdf5", "#166534"],
      "PAYMENT FAILED": ["#fef2f2", "#991b1b"],
      OVERDUE: ["#fff7ed", "#9a3412"],
      VOID: ["#f1f5f9", "#475569"],
      DRAFT: ["#f1f5f9", "#475569"],
      PENDING: ["#fffbeb", "#92400e"],
    };
    const [chipBg, chipFg] = chipColors[statusText] ?? ["#fffbeb", "#92400e"];
    const chipW = Math.max(66, doc.font("Helvetica-Bold").fontSize(8).widthOfString(statusText) + 22);
    doc.roundedRect(mr - chipW, 28, chipW, 20, 10).fill(chipBg);
    doc.fillColor(chipFg).font("Helvetica-Bold").fontSize(8).text(statusText, mr - chipW, 34, { width: chipW, align: "center" });
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(25).text(invoice.invoiceNumber || invoice.id, ml + 260, 53, { width: contentW - 260, align: "right" });
    doc.fillColor(muted).font("Helvetica").fontSize(9).text(`Issued ${formatDateShort(invoice.createdAt || invoice.issueDate)}`, ml + 260, 82, { width: contentW - 260, align: "right" });

    let y = 122;
    const gap = 14;
    const partyW = (contentW - gap * 2) / 3;
    const payW = partyW;
    const partyH = 118;
    roundedPanel(doc, ml, y, partyW, partyH, "#ffffff");
    roundedPanel(doc, ml + partyW + gap, y, partyW, partyH, "#ffffff");
    roundedPanel(doc, ml + (partyW + gap) * 2, y, payW, partyH, slate, "#1f2937");

    label(doc, "Bill from", ml + 16, y + 16, partyW - 32);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(12).text(brand.displayName, ml + 16, y + 33, { width: partyW - 32 });
    let partyY = doc.y + 5;
    if (brand.supportEmail) {
      doc.fillColor(muted).font("Helvetica").fontSize(8.5).text(brand.supportEmail, ml + 16, partyY, { width: partyW - 32 });
      partyY = doc.y + 3;
    }
    if (brand.supportPhone) doc.fillColor(muted).font("Helvetica").fontSize(8.5).text(brand.supportPhone, ml + 16, partyY, { width: partyW - 32 });

    const billX = ml + partyW + gap;
    label(doc, "Bill to", billX + 16, y + 16, partyW - 32);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(12).text(tenantName, billX + 16, y + 33, { width: partyW - 32 });
    let billY = doc.y + 5;
    if (billingEmail) {
      doc.fillColor(muted).font("Helvetica").fontSize(8.5).text(billingEmail, billX + 16, billY, { width: partyW - 32 });
      billY = doc.y + 3;
    }
    if (billTo && billTo !== tenantName) {
      doc.fillColor(muted).font("Helvetica").fontSize(8.5).text(billTo, billX + 16, billY, { width: partyW - 32, lineGap: 1 });
    }

    const payX = ml + (partyW + gap) * 2;
    label(doc, "Balance due", payX + 16, y + 16, payW - 32, "#67e8f9");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(24).text(money(invoice.balanceDueCents ?? invoice.totalCents), payX + 16, y + 32, { width: payW - 32 });
    doc.fillColor("#cbd5e1").font("Helvetica").fontSize(8.5).text(`Due ${formatDateShort(invoice.dueDate)}  |  Net ${brand.paymentTermsDays}`, payX + 16, y + 62, { width: payW - 32 });
    doc.roundedRect(payX + 16, y + 84, payW - 32, 22, 9).fill(cyan);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9).text("Pay Invoice Securely", payX + 16, y + 91, { width: payW - 32, align: "center" });
    doc.link(payX + 16, y + 84, payW - 32, 22, payUrl);

    y += partyH + 20;

    // Metadata strip.
    const meta = [
      ["Invoice date", formatDateShort(invoice.createdAt || invoice.issueDate)],
      ["Due date", formatDateShort(invoice.dueDate)],
      ["Service period", `${formatDateShort(invoice.periodStart)} - ${formatDateShort(invoice.periodEnd)}`],
      ["Total", money(invoice.totalCents)],
    ];
    const metaW = contentW / meta.length;
    doc.roundedRect(ml, y, contentW, 54, 12).fillAndStroke("#ffffff", line);
    meta.forEach(([k, v], idx) => {
      const x = ml + idx * metaW;
      if (idx > 0) doc.moveTo(x, y).lineTo(x, y + 54).strokeColor(line).lineWidth(0.5).stroke();
      label(doc, k, x + 13, y + 13, metaW - 26);
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(9.5).text(v, x + 13, y + 29, { width: metaW - 26 });
    });
    y += 78;

    label(doc, "Services & usage", ml, y, 180);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(17).text("Line items", ml, y + 14);
    doc.fillColor(muted).font("Helvetica").fontSize(8.5).text("Voice platform services, usage, credits, taxes, and telecom surcharges itemized for review.", ml + 260, y + 17, { width: contentW - 260, align: "right" });
    y += 48;

    const descW = 276;
    const qtyX = ml + 330;
    const rateX = ml + 388;
    const amtX = ml + 474;
    doc.roundedRect(ml, y, contentW, 28, 10).fill(panel);
    doc.fillColor(muted).font("Helvetica-Bold").fontSize(7.5);
    doc.text("DESCRIPTION", ml + 14, y + 10, { width: descW });
    doc.text("QTY", qtyX, y + 10, { width: 42, align: "right" });
    doc.text("RATE", rateX, y + 10, { width: 72, align: "right" });
    doc.text("AMOUNT", amtX, y + 10, { width: 70, align: "right" });
    y += 36;

    for (const item of lineItems) {
      y = ensureSpace(doc, y, 50);
      const classification = classifyLineItem(item);
      const description = String(item.description || "Billing item");
      const descriptionH = doc.font("Helvetica-Bold").fontSize(9.5).heightOfString(description, { width: descW });
      const rowH = Math.max(42, descriptionH + 24);
      doc.moveTo(ml, y - 5).lineTo(mr, y - 5).strokeColor("#edf2f7").lineWidth(0.5).stroke();
      doc.roundedRect(ml + 14, y, Math.max(34, doc.font("Helvetica-Bold").fontSize(6.8).widthOfString(classification.label) + 14), 14, 7).fill(classification.tone === "credit" ? "#ecfdf5" : classification.tone === "service" ? cyanSoft : "#f1f5f9");
      doc.fillColor(classification.tone === "credit" ? "#047857" : classification.tone === "service" ? "#0e7490" : "#475569")
        .font("Helvetica-Bold")
        .fontSize(6.8)
        .text(classification.label.toUpperCase(), ml + 21, y + 4);
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(9.5).text(description, ml + 14, y + 19, { width: descW, lineGap: 1 });
      doc.fillColor(muted).font("Helvetica").fontSize(9).text(String(item.quantity ?? 1), qtyX, y + 20, { width: 42, align: "right" });
      doc.text(money(item.unitPriceCents ?? 0), rateX, y + 20, { width: 72, align: "right" });
      doc.fillColor(ink).font("Helvetica-Bold").text(money(item.amountCents ?? 0), amtX, y + 20, { width: 70, align: "right" });
      y += rowH;
    }

    if (lineItems.length === 0) {
      doc.fillColor(muted).font("Helvetica").fontSize(9).text("No line items are attached to this invoice.", ml, y, { width: contentW, align: "center" });
      y += 28;
    }

    y += 14;
    y = ensureSpace(doc, y, 170);

    const notesW = contentW - 220;
    const summaryW = 200;
    const summaryX = mr - summaryW;
    const bottomY = y;
    const noteLines = splitPlainText(brand.paymentInstructions);
    const noteText = noteLines.length
      ? noteLines.join("\n")
      : "Pay securely online from this invoice page. For ACH, wire, check, or remittance instructions, contact billing support before sending payment.";
    const notesH = Math.max(116, doc.font("Helvetica").fontSize(8.5).heightOfString(noteText, { width: notesW - 32, lineGap: 2 }) + 54);
    const summaryRows = buildTotalsRows(invoice, lineItems);
    const summaryH = Math.max(notesH, 42 + summaryRows.length * 19 + 22);

    roundedPanel(doc, ml, bottomY, notesW, summaryH, "#ffffff");
    label(doc, "Payment instructions", ml + 16, bottomY + 18, notesW - 32);
    doc.fillColor("#475569").font("Helvetica").fontSize(8.5).text(noteText, ml + 16, bottomY + 38, { width: notesW - 32, lineGap: 2 });
    doc.fillColor(muted).fontSize(7.5).text(`Manual payment URL: ${payUrl}`, ml + 16, bottomY + summaryH - 24, { width: notesW - 32 });

    roundedPanel(doc, summaryX, bottomY, summaryW, summaryH, "#ffffff");
    label(doc, "Billing summary", summaryX + 16, bottomY + 18, summaryW - 32);
    let sy = bottomY + 42;
    summaryRows.forEach((row) => {
      const isDue = row.tone === "due";
      doc.fillColor(row.tone === "credit" || row.tone === "paid" ? "#047857" : isDue ? ink : "#475569")
        .font(isDue ? "Helvetica-Bold" : "Helvetica")
        .fontSize(isDue ? 10.5 : 8.5);
      doc.text(row.label, summaryX + 16, sy, { width: 98 });
      doc.font("Helvetica-Bold").text(money(row.valueCents), summaryX + 116, sy, { width: 68, align: "right" });
      sy += isDue ? 24 : 18;
      if (!isDue) doc.moveTo(summaryX + 16, sy - 5).lineTo(summaryX + summaryW - 16, sy - 5).strokeColor("#eef2f7").lineWidth(0.4).stroke();
    });

    y = bottomY + summaryH + 24;
    y = ensureSpace(doc, y, 150);

    label(doc, "Regulatory & billing notices", ml, y, 230);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(15).text("Telecom billing disclosures", ml, y + 14, { width: contentW });
    y += 40;
    regulatoryNotices(brand, invoice).forEach((notice) => {
      y = ensureSpace(doc, y, 34);
      const h = doc.font("Helvetica").fontSize(7.7).heightOfString(notice, { width: contentW - 18, lineGap: 1 });
      doc.fillColor(cyan).font("Helvetica-Bold").fontSize(8).text("-", ml, y);
      doc.fillColor("#475569").font("Helvetica").fontSize(7.7).text(notice, ml + 14, y, { width: contentW - 18, lineGap: 1 });
      y += h + 7;
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
