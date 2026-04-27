import PDFDocument from "pdfkit";
import { money } from "./emailTemplates";

export async function renderBillingInvoicePdf(invoice: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fillColor("#0f172a").fontSize(24).text("ConnectComms", { continued: true });
    doc.fillColor("#0284c7").fontSize(12).text("  Invoice", { align: "right" });
    doc.moveDown(1.5);

    doc.fillColor("#111827").fontSize(18).text(invoice.invoiceNumber || invoice.id);
    doc.fontSize(10).fillColor("#64748b");
    doc.text(`Status: ${invoice.status}`);
    doc.text(`Issue date: ${new Date(invoice.issueDate || invoice.createdAt).toISOString().slice(0, 10)}`);
    doc.text(`Due date: ${new Date(invoice.dueDate).toISOString().slice(0, 10)}`);
    doc.text(`Billing period: ${new Date(invoice.periodStart).toISOString().slice(0, 10)} - ${new Date(invoice.periodEnd).toISOString().slice(0, 10)}`);
    if (invoice.tenant?.name) doc.text(`Tenant: ${invoice.tenant.name}`);
    doc.moveDown(1.2);

    doc.fillColor("#0f172a").fontSize(12).text("Description", 48, doc.y, { width: 260, continued: true });
    doc.text("Qty", 330, doc.y, { width: 50, align: "right", continued: true });
    doc.text("Unit", 390, doc.y, { width: 70, align: "right", continued: true });
    doc.text("Amount", 470, doc.y, { width: 80, align: "right" });
    doc.moveTo(48, doc.y + 6).lineTo(550, doc.y + 6).strokeColor("#cbd5e1").stroke();
    doc.moveDown(0.8);

    for (const item of invoice.lineItems || []) {
      const y = doc.y;
      doc.fillColor("#334155").fontSize(10).text(item.description, 48, y, { width: 260 });
      doc.text(String(item.quantity), 330, y, { width: 50, align: "right" });
      doc.text(money(item.unitPriceCents), 390, y, { width: 70, align: "right" });
      doc.text(money(item.amountCents), 470, y, { width: 80, align: "right" });
      doc.moveDown(0.7);
    }

    doc.moveDown(1);
    const totalsX = 380;
    doc.fillColor("#475569").fontSize(11).text("Subtotal", totalsX, doc.y, { width: 90, align: "right", continued: true }).text(money(invoice.subtotalCents), 470, doc.y, { width: 80, align: "right" });
    doc.text("Taxes & fees", totalsX, doc.y + 18, { width: 90, align: "right", continued: true }).text(money(invoice.taxCents), 470, doc.y, { width: 80, align: "right" });
    doc.fillColor("#0f172a").fontSize(15).text("Total", totalsX, doc.y + 24, { width: 90, align: "right", continued: true }).text(money(invoice.totalCents), 470, doc.y, { width: 80, align: "right" });

    if (invoice.status === "PAID") {
      doc.save();
      doc.rotate(-18, { origin: [300, 420] }).fillOpacity(0.2).fillColor("#16a34a").fontSize(44).text("PAID", 230, 390);
      doc.restore();
    }

    doc.end();
  });
}
