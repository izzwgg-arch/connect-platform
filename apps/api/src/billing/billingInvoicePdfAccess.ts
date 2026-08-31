import type { FastifyReply } from "fastify";
import { db } from "@connect/db";
import { canAccessPlatformAdminBillingRoutes } from "./billingAuth";
import { renderBillingInvoicePdf } from "./pdf";

export type BillingInvoicePdfUser = {
  tenantId: string;
  role?: string;
};

function safePdfFilename(invoice: { invoiceNumber?: string | null; id: string }): string {
  const base = String(invoice.invoiceNumber || invoice.id).replace(/[^\w.-]+/g, "_");
  return `${base}.pdf`;
}

/** Load invoice for PDF when caller is tenant-scoped or platform SUPER_ADMIN. */
export async function findBillingInvoiceForPdf(
  invoiceId: string,
  user: BillingInvoicePdfUser,
  tenantScopeId?: string,
) {
  const where = tenantScopeId
    ? { id: invoiceId, tenantId: tenantScopeId }
    : canAccessPlatformAdminBillingRoutes(user.role)
      ? { id: invoiceId }
      : { id: invoiceId, tenantId: user.tenantId };
  return (db as any).billingInvoice.findFirst({
    where,
    include: { lineItems: true, tenant: { include: { billingSettings: true } } },
  });
}

export async function sendBillingInvoicePdf(
  reply: FastifyReply,
  invoice: { invoiceNumber?: string | null; id: string },
  /** `download` switches the disposition so "Download PDF" saves the file while
   *  "Open full invoice" still opens it in a tab. Default stays `inline`, which
   *  is what every existing caller relied on. */
  options?: { download?: boolean },
) {
  const pdf = await renderBillingInvoicePdf(invoice);
  reply.header("content-type", "application/pdf");
  reply.header(
    "content-disposition",
    `${options?.download ? "attachment" : "inline"}; filename="${safePdfFilename(invoice)}"`,
  );
  return reply.send(pdf);
}
