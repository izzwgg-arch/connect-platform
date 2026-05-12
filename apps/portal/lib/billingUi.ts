/** Small helpers for tenant billing portal pages (no API calls). */

export function dollars(cents: number | undefined | null) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export function nextBillingSummary(billingDayOfMonth: number | undefined | null, autoBillingEnabled: boolean): string | null {
  if (!autoBillingEnabled) return null;
  const day = Number(billingDayOfMonth);
  if (!Number.isFinite(day) || day < 1 || day > 28) return null;
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const clamped = Math.min(day, 28);
  let candidate = new Date(y, m, clamped);
  if (candidate.getTime() <= now.getTime()) candidate = new Date(y, m + 1, clamped);
  return `Next auto-bill target: ${candidate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} (billing day ${day})`;
}

export function lastPaidSummary(invoices: any[] | undefined | null): string | null {
  if (!invoices?.length) return null;
  const paid = invoices.filter((i) => i.status === "PAID" && i.paidAt);
  if (!paid.length) return null;
  paid.sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());
  const inv = paid[0];
  const when = new Date(inv.paidAt).toLocaleString();
  return `${dollars(inv.totalCents)} paid on ${when} (${inv.invoiceNumber || inv.id})`;
}

export function worstOpenInvoice(invoices: any[] | undefined | null): any | null {
  if (!invoices?.length) return null;
  const openish = invoices.filter((i) => ["OPEN", "FAILED", "OVERDUE", "DRAFT"].includes(String(i.status)));
  if (!openish.length) return null;
  const rank: Record<string, number> = { FAILED: 4, OVERDUE: 3, OPEN: 2, DRAFT: 1 };
  openish.sort((a, b) => (rank[String(b.status)] || 0) - (rank[String(a.status)] || 0));
  return openish[0];
}

export function dunningHintFromInvoice(inv: any | null): string | null {
  if (!inv) return null;
  const meta = inv.metadata && typeof inv.metadata === "object" ? inv.metadata : null;
  const d = meta && typeof (meta as any).dunning === "object" ? (meta as any).dunning : null;
  if (!d) {
    if (inv.status === "FAILED" || inv.status === "OVERDUE") return "Payment failed or overdue — update the card or pay manually.";
    return null;
  }
  const next = d.nextRetryAt ? new Date(d.nextRetryAt).toLocaleString() : null;
  const attempts = typeof d.attempts === "number" ? d.attempts : null;
  const parts = ["Autopay retry scheduled."];
  if (attempts != null) parts.push(`Attempts: ${attempts}.`);
  if (next) parts.push(`Next try: ${next}.`);
  return parts.join(" ");
}
