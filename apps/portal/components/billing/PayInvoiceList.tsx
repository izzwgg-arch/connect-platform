"use client";

import { ChevronDown, Download, ExternalLink } from "lucide-react";

/**
 * The invoice breakdown on a public pay page.
 *
 * One component for all three pay surfaces — the single-invoice token, the
 * combined token and the short pay-link code — so a customer who opens two
 * different links for the same invoice is shown the same thing.
 *
 * ⛔ Built on native <details>/<summary>. It really collapses (Izzy,
 * 2026-08-31: "make sure the breakdown is really collapsible"), it is operable
 * from the keyboard and by a screen reader without a line of JavaScript, and it
 * keeps no state that could disagree with what is on screen.
 */

export type PayInvoiceLine = {
  type?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
};

export type PayInvoiceRow = {
  invoiceId?: string | null;
  invoiceNumber: string;
  dueDate?: string | null;
  issueDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  totalCents?: number | null;
  balanceDueCents: number;
  payable: boolean;
  lineItems?: PayInvoiceLine[] | null;
};

export function payDollars(cents: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents || 0) / 100);
}

/**
 * ⛔ UTC, always. Invoice dates are stored as UTC midnight standing for a
 * calendar day, so formatting them in the reader's local zone shows the day
 * BEFORE for everyone west of UTC — "Due Jul 9" on an invoice that says Jul 10.
 * The invoice PDF formats with `timeZone: "UTC"` (billing/pdf.ts), and the page
 * a customer opens the PDF from must not disagree with it.
 */
export function payDate(iso: string | null | undefined) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return String(iso);
  }
}

/** "Jul 1 – Jul 31, 2026" */
function periodWords(start?: string | null, end?: string | null) {
  if (!start || !end) return "";
  try {
    const a = new Date(start);
    const b = new Date(end);
    const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
    const fmtA = a.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC", ...(sameYear ? {} : { year: "numeric" }) });
    const fmtB = b.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    return `${fmtA} – ${fmtB}`;
  } catch {
    return "";
  }
}

export function PayInvoiceList({
  rows,
  heading = "Invoices",
  pdfHref,
  openFirst = true,
}: {
  rows: PayInvoiceRow[];
  heading?: string;
  /** Where "Open full invoice" points, or null when this surface has no link. */
  pdfHref?: (row: PayInvoiceRow) => string | null;
  openFirst?: boolean;
}) {
  if (!rows.length) return null;

  return (
    <section className="billing-pay-invoices" aria-label={heading}>
      <p className="billing-pay-invoices-label">{heading}</p>

      {rows.map((row, index) => {
        const lines = row.lineItems || [];
        const href = pdfHref?.(row) || null;
        const period = periodWords(row.periodStart, row.periodEnd);
        const total = typeof row.totalCents === "number" ? row.totalCents : row.balanceDueCents;

        return (
          <details
            key={row.invoiceId || row.invoiceNumber}
            className="billing-pay-invoice"
            open={openFirst && index === 0}
          >
            <summary>
              <span className="billing-pay-invoice-id">
                <b>{row.invoiceNumber}</b>
                <span>
                  {row.dueDate ? <>Due {payDate(row.dueDate)}</> : null}
                  {row.dueDate && period ? " · " : null}
                  {period}
                  {!row.payable ? " · already settled" : null}
                </span>
              </span>
              <span className={`billing-pay-invoice-amt${row.payable ? "" : " is-settled"}`}>
                {payDollars(row.balanceDueCents)}
              </span>
              <span className="billing-pay-chev" aria-hidden="true">
                <ChevronDown size={14} />
              </span>
            </summary>

            <div className="billing-pay-invoice-body">
              {lines.length ? (
                <table className="billing-pay-lines">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col" className="billing-pay-line-qty">Qty</th>
                      <th scope="col">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, i) => (
                      <tr key={`${row.invoiceNumber}-${i}`}>
                        <td>
                          {line.description}
                          {line.quantity > 1 && line.unitPriceCents > 0 ? (
                            <span className="billing-pay-line-unit">
                              {line.quantity} × {payDollars(line.unitPriceCents)}
                            </span>
                          ) : null}
                        </td>
                        <td className="billing-pay-line-qty">{line.quantity}</td>
                        <td>{payDollars(line.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Invoice total</td>
                      <td className="billing-pay-line-qty" />
                      <td>{payDollars(total)}</td>
                    </tr>
                  </tfoot>
                </table>
              ) : (
                <p className="billing-pay-invoice-period">
                  The itemised breakdown for this invoice isn&rsquo;t available here — open the invoice to see it.
                </p>
              )}

              {row.issueDate ? (
                <p className="billing-pay-invoice-period">
                  Issued {payDate(row.issueDate)}
                  {period ? <> · billing period {period}</> : null}
                </p>
              ) : null}

              {href ? (
                <div className="billing-pay-invoice-actions">
                  <a className="billing-pay-ghost-btn" href={href} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} aria-hidden="true" /> Open full invoice
                  </a>
                  <a className="billing-pay-ghost-btn" href={`${href}${href.includes("?") ? "&" : "?"}download=1`}>
                    <Download size={13} aria-hidden="true" /> Download PDF
                  </a>
                </div>
              ) : null}
            </div>
          </details>
        );
      })}
    </section>
  );
}
