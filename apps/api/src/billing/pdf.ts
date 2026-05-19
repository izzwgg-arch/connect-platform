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

export async function renderBillingInvoicePdf(invoice: any): Promise<Buffer> {
  const settings = invoice.tenant?.billingSettings || {};
  const tenantName = invoice.tenant?.name || "Customer";
  const brand = resolveInvoiceEmailBranding(settings, tenantName);
  const billToAddress = formatBillingAddress(settings.billingAddress);
  const serviceAddress = formatBillingAddress(settings.serviceAddress);
  const billTo = billToAddress || serviceAddress || tenantName;
  const billingEmail = sanitizePlainText(settings.billingEmail, 320);

  const payUrl = `${process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com"}/billing/invoices/${encodeURIComponent(invoice.id)}`;
  const logo = logoBuffer();

  // Palette
  const accent = "#0284c7";   // Connect blue
  const ink = "#0f172a";      // near-black
  const muted = "#64748b";    // medium gray
  const light = "#94a3b8";    // lighter gray
  const lineColor = "#e2e8f0"; // very light border

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48, info: { Title: `Invoice ${invoice.invoiceNumber || invoice.id}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const ml = 48; // margin left
    const mr = pageW - 48; // margin right

    // -----------------------------------------------------------------------
    // HEADER BAND — blue strip at top
    // -----------------------------------------------------------------------
    doc.save();
    doc.rect(0, 0, pageW, 80).fill(accent);
    doc.restore();

    // Logo (top-left inside header)
    let logoEndX = ml;
    if (logo) {
      try {
        doc.image(logo, ml, 14, { height: 46, fit: [160, 46] });
        logoEndX = ml + 170;
      } catch {
        // Image render failed — fall through to text header
      }
    }

    if (!logo) {
      // Text logo fallback
      doc.fillColor("#ffffff").fontSize(14).font("Helvetica-Bold").text(brand.displayName.toUpperCase(), ml, 28, { characterSpacing: 0.8 });
      doc.font("Helvetica");
    }

    // "INVOICE" label — right-aligned in header
    doc.fillColor("#bae6fd").fontSize(10).text("INVOICE", 0, 18, { width: mr, align: "right" });
    doc.fillColor("#ffffff").fontSize(24).font("Helvetica-Bold").text(invoice.invoiceNumber || invoice.id, 0, 30, { width: mr, align: "right" });
    doc.font("Helvetica");

    // -----------------------------------------------------------------------
    // STATUS CHIP just below header
    // -----------------------------------------------------------------------
    const statusText = statusLabel(invoice.status || "OPEN");
    const chipColors: Record<string, [string, string]> = {
      PAID: ["#dcfce7", "#15803d"],
      "PAYMENT FAILED": ["#fee2e2", "#b91c1c"],
      OVERDUE: ["#fff7ed", "#ea580c"],
      VOID: ["#f1f5f9", "#64748b"],
      DRAFT: ["#f1f5f9", "#64748b"],
      OPEN: ["#eff6ff", "#1d4ed8"],
    };
    const [chipBg, chipFg] = chipColors[statusText] ?? ["#eff6ff", "#1d4ed8"];
    const chipY = 90;
    const chipLabel = `  ${statusText}  `;
    doc.fontSize(9);
    doc.fillColor(chipBg).roundedRect(ml, chipY, doc.widthOfString(chipLabel) + 16, 18, 5).fill();
    doc.fillColor(chipFg).fontSize(9).font("Helvetica-Bold").text(statusText, ml + 8, chipY + 4);
    doc.font("Helvetica");

    // -----------------------------------------------------------------------
    // SECTION: Bill From (left) | Bill To (right)
    // -----------------------------------------------------------------------
    const sectionY = 120;
    const colW = (mr - ml - 20) / 2;
    const col2X = ml + colW + 20;

    // -- Bill From --
    doc.fillColor(light).fontSize(8).font("Helvetica-Bold").text("FROM", ml, sectionY);
    doc.font("Helvetica");
    let fromY = sectionY + 13;
    doc.fillColor(ink).fontSize(11).font("Helvetica-Bold").text(brand.displayName, ml, fromY, { width: colW });
    doc.font("Helvetica");
    fromY = doc.y + 3;
    if (brand.supportEmail) {
      doc.fillColor(muted).fontSize(9).text(brand.supportEmail, ml, fromY, { width: colW });
      fromY = doc.y + 2;
    }
    if (brand.supportPhone) {
      doc.fillColor(muted).fontSize(9).text(brand.supportPhone, ml, fromY, { width: colW });
    }

    // -- Bill To --
    doc.fillColor(light).fontSize(8).font("Helvetica-Bold").text("BILL TO", col2X, sectionY);
    doc.font("Helvetica");
    let toY = sectionY + 13;
    doc.fillColor(ink).fontSize(11).font("Helvetica-Bold").text(tenantName, col2X, toY, { width: colW });
    doc.font("Helvetica");
    toY = doc.y + 3;
    if (billingEmail) {
      doc.fillColor(muted).fontSize(9).text(billingEmail, col2X, toY, { width: colW });
      toY = doc.y + 2;
    }
    if (billTo && billTo !== tenantName) {
      doc.fillColor(muted).fontSize(9).text(billTo, col2X, toY, { width: colW, lineGap: 1 });
    }

    // -----------------------------------------------------------------------
    // SECTION: Invoice Details row
    // -----------------------------------------------------------------------
    let detailY = Math.max(doc.y, fromY + 4) + 16;
    doc.moveTo(ml, detailY).lineTo(mr, detailY).strokeColor(lineColor).lineWidth(1).stroke();
    detailY += 10;

    // Four key details in a row
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

    const detailColW = (mr - ml) / detailCols.length;
    detailCols.forEach(({ label, value }, i) => {
      const dx = ml + i * detailColW;
      doc.fillColor(light).fontSize(8).font("Helvetica-Bold").text(label.toUpperCase(), dx, detailY, { width: detailColW - 6 });
      doc.font("Helvetica");
      doc.fillColor(ink).fontSize(9).text(value, dx, detailY + 11, { width: detailColW - 6 });
    });

    // Payment terms
    if (brand.paymentTermsDays) {
      const termsX = mr - 120;
      doc.fillColor(light).fontSize(8).font("Helvetica-Bold").text("TERMS", termsX, detailY, { width: 120, align: "right" });
      doc.font("Helvetica");
      doc.fillColor(muted).fontSize(9).text(`Net ${brand.paymentTermsDays} days`, termsX, detailY + 11, { width: 120, align: "right" });
    }

    // -----------------------------------------------------------------------
    // LINE ITEMS TABLE
    // -----------------------------------------------------------------------
    let y = detailY + 40;
    doc.moveTo(ml, y).lineTo(mr, y).strokeColor(lineColor).lineWidth(0.5).stroke();
    y += 8;

    // Column headers
    doc.fillColor(light).fontSize(8).font("Helvetica-Bold");
    doc.text("DESCRIPTION", ml, y, { width: 250 });
    doc.text("QTY", 308, y, { width: 50, align: "right" });
    doc.text("UNIT PRICE", 368, y, { width: 80, align: "right" });
    doc.text("AMOUNT", 458, y, { width: 86, align: "right" });
    doc.font("Helvetica");
    y += 14;
    doc.moveTo(ml, y).lineTo(mr, y).strokeColor(lineColor).stroke();
    y += 6;

    for (const item of invoice.lineItems || []) {
      // Start a new page if close to bottom
      if (y > doc.page.height - 200) {
        doc.addPage();
        y = 48;
      }
      doc.fillColor(ink).fontSize(9).text(String(item.description || ""), ml, y, { width: 250 });
      const rowH = doc.heightOfString(String(item.description || ""), { width: 250 });
      doc.fillColor(muted).fontSize(9).text(String(item.quantity ?? 1), 308, y, { width: 50, align: "right" });
      doc.text(money(item.unitPriceCents), 368, y, { width: 80, align: "right" });
      doc.fillColor(ink).text(money(item.amountCents), 458, y, { width: 86, align: "right" });
      y += Math.max(rowH, 14) + 5;
      // Light separator between rows
      doc.moveTo(ml, y - 1).lineTo(mr, y - 1).strokeColor("#f8fafc").lineWidth(0.3).stroke();
    }

    // -----------------------------------------------------------------------
    // TOTALS
    // -----------------------------------------------------------------------
    y += 8;
    doc.moveTo(ml, y).lineTo(mr, y).strokeColor(lineColor).lineWidth(0.5).stroke();
    y += 12;

    const totalsLabelX = 360;
    const totalsValueX = 458;
    const totalsW = 86;

    function totalsRow(label: string, value: string, bold = false, color = muted) {
      doc.fillColor(color).fontSize(bold ? 11 : 9).font(bold ? "Helvetica-Bold" : "Helvetica");
      doc.text(label, totalsLabelX, y, { width: 90, align: "right" });
      doc.text(value, totalsValueX, y, { width: totalsW, align: "right" });
      doc.font("Helvetica");
      y += bold ? 18 : 14;
    }

    totalsRow("Subtotal", money(invoice.subtotalCents ?? 0));

    // Show discount if any DISCOUNT line items exist
    const discountLine = (invoice.lineItems || []).find((l: any) => l.type === "DISCOUNT");
    if (discountLine && discountLine.amountCents < 0) {
      totalsRow("Discount", money(discountLine.amountCents), false, "#15803d");
    }

    // Break out taxes if any
    if ((invoice.taxCents ?? 0) > 0) {
      totalsRow("Taxes & fees", money(invoice.taxCents));
    }

    y += 4;
    doc.moveTo(totalsLabelX, y).lineTo(mr, y).strokeColor(lineColor).lineWidth(0.5).stroke();
    y += 8;
    totalsRow("Invoice total", money(invoice.totalCents), true, ink);

    if ((invoice.amountPaidCents ?? 0) > 0 && invoice.status === "PAID") {
      totalsRow("Amount paid", money(invoice.amountPaidCents), false, "#15803d");
    }

    y += 4;
    doc.moveTo(totalsLabelX, y).lineTo(mr, y).strokeColor(accent).lineWidth(1).stroke();
    y += 8;
    doc.fillColor(accent).fontSize(12).font("Helvetica-Bold");
    doc.text("Balance due", totalsLabelX, y, { width: 90, align: "right" });
    doc.text(money(invoice.balanceDueCents ?? invoice.totalCents), totalsValueX, y, { width: totalsW, align: "right" });
    doc.font("Helvetica");
    y += 26;

    // -----------------------------------------------------------------------
    // PAY ONLINE LINK
    // -----------------------------------------------------------------------
    doc.moveTo(ml, y).lineTo(mr, y).strokeColor(lineColor).lineWidth(0.5).stroke();
    y += 10;
    doc.fillColor(muted).fontSize(9).text("Pay online:", ml, y);
    doc.fillColor(accent).fontSize(9).text(payUrl, ml + 60, y, { width: mr - ml - 60 });
    y = doc.y + 6;

    // -----------------------------------------------------------------------
    // PAYMENT INSTRUCTIONS (if set)
    // -----------------------------------------------------------------------
    if (brand.paymentInstructions) {
      y += 4;
      doc.fillColor(ink).fontSize(9).font("Helvetica-Bold").text("Payment instructions", ml, y);
      doc.font("Helvetica");
      y = doc.y + 3;
      doc.fillColor("#475569").fontSize(9).text(brand.paymentInstructions, ml, y, { width: mr - ml, lineGap: 2 });
      y = doc.y + 6;
    }

    // -----------------------------------------------------------------------
    // SUPPORT CONTACT
    // -----------------------------------------------------------------------
    if (brand.supportEmail || brand.supportPhone) {
      const bits = [
        brand.supportEmail ? `Email: ${brand.supportEmail}` : null,
        brand.supportPhone ? `Phone: ${brand.supportPhone}` : null,
      ].filter(Boolean);
      y = doc.y + 10;
      doc.fillColor(light).fontSize(8).text(bits.join("   ·   "), ml, y, { width: mr - ml });
      y = doc.y + 4;
    }

    // -----------------------------------------------------------------------
    // FOOTER — legal / tax disclaimer
    // -----------------------------------------------------------------------
    y = doc.y + 12;
    doc.moveTo(ml, y).lineTo(mr, y).strokeColor(lineColor).lineWidth(0.5).stroke();
    y += 8;

    const footerLines: string[] = [
      brand.footerNote || "",
      "Taxes and regulatory fees are applied according to your configured billing profile. This invoice does not constitute legal tax advice.",
      "For billing questions, contact your service provider. Thank you for your business.",
    ].filter(Boolean);

    doc.fillColor(light).fontSize(8).text(footerLines.join("  ·  "), ml, y, { width: mr - ml, lineGap: 2 });

    // -----------------------------------------------------------------------
    // PAID WATERMARK (diagonal stamp for paid invoices)
    // -----------------------------------------------------------------------
    if (invoice.status === "PAID") {
      doc.save();
      doc.rotate(-22, { origin: [306, 396] });
      doc.fillOpacity(0.08).fillColor("#15803d").fontSize(72).font("Helvetica-Bold").text("PAID", 160, 360);
      doc.restore();
    }

    doc.end();
  });
}
