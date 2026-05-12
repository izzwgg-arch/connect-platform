import PDFDocument from "pdfkit";
import { money } from "./emailTemplates";
import { resolveInvoiceEmailBranding, sanitizePlainText } from "./invoiceBranding";

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

export async function renderBillingInvoicePdf(invoice: any): Promise<Buffer> {
  const settings = invoice.tenant?.billingSettings || {};
  const tenantName = invoice.tenant?.name || "Customer";
  const brand = resolveInvoiceEmailBranding(settings, tenantName);
  const billTo = formatBillingAddress(settings.billingAddress) || tenantName;
  const payUrl = `${process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com"}/billing/invoices/${encodeURIComponent(invoice.id)}`;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48, info: { Title: `Invoice ${invoice.invoiceNumber || invoice.id}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const accent = "#0284c7";
    const ink = "#0f172a";
    const muted = "#64748b";
    const line = "#cbd5e1";

    doc.save();
    doc.rect(0, 0, doc.page.width, 112).fill("#f8fafc");
    doc.restore();

    doc.fillColor(accent).fontSize(11).text(brand.displayName.toUpperCase(), 48, 52, { characterSpacing: 1.2 });
    doc.fillColor(ink).fontSize(22).text("Invoice", 48, 68);
    doc.fillColor(muted).fontSize(10).text(`Payment terms: Net ${brand.paymentTermsDays} days`, 400, 72, { width: 150, align: "right" });

    let y = 128;
    doc.fillColor(ink).fontSize(12).text("Bill to", 48, y);
    doc.fillColor("#334155").fontSize(10).text(billTo, 48, y + 16, { width: 240, lineGap: 2 });

    doc.fillColor(ink).fontSize(12).text("Invoice details", 340, y);
    doc.fillColor("#334155").fontSize(10);
    const rightX = 340;
    let ry = y + 16;
    doc.text(`Number: ${invoice.invoiceNumber || invoice.id}`, rightX, ry);
    ry += 14;
    doc.text(`Status: ${invoice.status}`, rightX, ry);
    ry += 14;
    doc.text(`Issue: ${new Date(invoice.issueDate || invoice.createdAt).toISOString().slice(0, 10)}`, rightX, ry);
    ry += 14;
    doc.text(`Due: ${new Date(invoice.dueDate).toISOString().slice(0, 10)}`, rightX, ry);
    ry += 14;
    doc.text(`Period: ${new Date(invoice.periodStart).toISOString().slice(0, 10)} – ${new Date(invoice.periodEnd).toISOString().slice(0, 10)}`, rightX, ry, { width: 210 });

    y = 220;
    doc.moveTo(48, y).lineTo(550, y).strokeColor(line).lineWidth(0.5).stroke();
    y += 14;
    doc.fillColor(ink).fontSize(11).text("Description", 48, y, { width: 260, continued: true });
    doc.text("Qty", 330, y, { width: 50, align: "right", continued: true });
    doc.text("Unit", 390, y, { width: 70, align: "right", continued: true });
    doc.text("Amount", 470, y, { width: 80, align: "right" });
    y += 18;
    doc.moveTo(48, y).lineTo(550, y).strokeColor(line).stroke();
    y += 10;

    for (const item of invoice.lineItems || []) {
      const rowY = doc.y;
      doc.fillColor("#334155").fontSize(10).text(String(item.description), 48, rowY, { width: 260 });
      doc.text(String(item.quantity), 330, rowY, { width: 50, align: "right" });
      doc.text(money(item.unitPriceCents), 390, rowY, { width: 70, align: "right" });
      doc.text(money(item.amountCents), 470, rowY, { width: 80, align: "right" });
      doc.moveDown(0.75);
    }

    doc.moveDown(0.6);
    const totalsX = 360;
    let ty = doc.y + 4;
    doc.fillColor(muted).fontSize(10).text("Subtotal", totalsX, ty, { width: 90, align: "right" });
    doc.text(money(invoice.subtotalCents), 470, ty, { width: 80, align: "right" });
    ty += 16;
    doc.text("Taxes & fees", totalsX, ty, { width: 90, align: "right" });
    doc.text(money(invoice.taxCents), 470, ty, { width: 80, align: "right" });
    ty += 18;
    doc.fillColor(ink).fontSize(12).text("Invoice total", totalsX, ty, { width: 90, align: "right" });
    doc.text(money(invoice.totalCents), 470, ty, { width: 80, align: "right" });
    ty += 22;
    doc.fillColor(accent).fontSize(13).text("Balance due", totalsX, ty, { width: 90, align: "right" });
    doc.text(money(invoice.balanceDueCents ?? invoice.totalCents), 470, ty, { width: 80, align: "right" });

    ty += 28;
    doc.fillColor(muted).fontSize(9).text(`Pay online: ${payUrl}`, 48, ty, { width: 504, lineGap: 3 });

    if (brand.paymentInstructions) {
      ty = doc.y + 6;
      doc.fillColor(ink).fontSize(10).text("Payment instructions", 48, ty);
      ty = doc.y + 4;
      doc.fillColor("#475569").fontSize(9).text(brand.paymentInstructions, 48, ty, { width: 504, lineGap: 3 });
    }

    if (brand.supportEmail || brand.supportPhone) {
      ty = doc.y + 12;
      const bits = [brand.supportEmail ? `Email: ${brand.supportEmail}` : null, brand.supportPhone ? `Phone: ${brand.supportPhone}` : null].filter(Boolean);
      doc.fillColor(muted).fontSize(9).text(bits.join("   ·   "), 48, ty, { width: 504 });
    }

    if (brand.footerNote) {
      ty = doc.y + 14;
      doc.moveTo(48, ty).lineTo(550, ty).strokeColor(line).stroke();
      ty += 10;
      doc.fillColor(muted).fontSize(8).text(brand.footerNote, 48, ty, { width: 504, lineGap: 2 });
    }

    if (invoice.status === "PAID") {
      doc.save();
      doc.rotate(-18, { origin: [300, 420] }).fillOpacity(0.18).fillColor("#16a34a").fontSize(44).text("PAID", 230, 390);
      doc.restore();
    }

    doc.end();
  });
}
