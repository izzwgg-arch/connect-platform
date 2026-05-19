export type BillingInvoiceDeleteInput = {
  status: string;
  transactions?: { status: string }[];
};

export type BillingInvoiceDeleteBlockReason = "invoice_paid" | "invoice_has_approved_payment";

export function assertBillingInvoiceDeletable(
  invoice: BillingInvoiceDeleteInput,
): { ok: true } | { ok: false; error: BillingInvoiceDeleteBlockReason; message: string } {
  if (String(invoice.status || "").toUpperCase() === "PAID") {
    return {
      ok: false,
      error: "invoice_paid",
      message: "Paid invoices cannot be deleted. Void the invoice or issue a credit instead.",
    };
  }
  const hasApproved = (invoice.transactions || []).some(
    (t) => String(t.status || "").toUpperCase() === "APPROVED",
  );
  if (hasApproved) {
    return {
      ok: false,
      error: "invoice_has_approved_payment",
      message: "Invoices with approved card payments cannot be deleted.",
    };
  }
  return { ok: true };
}
