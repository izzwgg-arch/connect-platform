/** Small helpers for tenant billing portal pages (no API calls). */

export function dollars(cents: number | undefined | null) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return "—"; }
}

export function formatDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  try { return new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return "—"; }
}

export function invoiceStatusLabel(status: string | undefined | null): string {
  switch (String(status || "").toUpperCase()) {
    case "DRAFT": return "Draft";
    case "OPEN": return "Pending";
    case "PAID": return "Paid";
    case "FAILED": return "Payment failed";
    case "OVERDUE": return "Overdue";
    case "VOID": return "Voided";
    default: return status || "Unknown";
  }
}

export function invoiceStatusClass(status: string | undefined | null): string {
  switch (String(status || "").toUpperCase()) {
    case "PAID": return "good";
    case "FAILED": case "OVERDUE": return "bad";
    case "OPEN": case "DRAFT": return "warn";
    default: return "";
  }
}

/** Finance table chip tone (portal display only). */
export function invoiceFinanceStatusTone(status: string | undefined | null): "draft" | "pending" | "paid" | "failed" | "overdue" | "void" | "neutral" {
  switch (String(status || "").toUpperCase()) {
    case "DRAFT": return "draft";
    case "OPEN": return "pending";
    case "PAID": return "paid";
    case "FAILED": return "failed";
    case "OVERDUE": return "overdue";
    case "VOID": return "void";
    default: return "neutral";
  }
}

export function invoiceFilterStatusLabel(status: string): string {
  if (status === "ALL") return "All";
  if (status === "OPEN") return "Pending";
  return invoiceStatusLabel(status);
}

export function transactionStatusLabel(status: string | undefined | null): string {
  switch (String(status || "").toUpperCase()) {
    case "APPROVED": return "Approved";
    case "DECLINED": return "Declined";
    case "ERROR": return "Error";
    case "PENDING": return "Pending";
    case "REFUNDED": return "Refunded";
    case "VOIDED": return "Voided";
    default: return status || "—";
  }
}

export function transactionStatusClass(status: string | undefined | null): string {
  switch (String(status || "").toUpperCase()) {
    case "APPROVED": return "good";
    case "DECLINED": case "ERROR": return "bad";
    case "REFUNDED": case "VOIDED": return "";
    default: return "warn";
  }
}

/** Finance chip tone for payment transaction rows (display only). */
export function transactionFinanceStatusTone(status: string | undefined | null): "approved" | "pending" | "failed" | "refunded" | "void" | "neutral" {
  switch (String(status || "").toUpperCase()) {
    case "APPROVED": return "approved";
    case "PENDING": return "pending";
    case "DECLINED": case "ERROR": return "failed";
    case "REFUNDED": return "refunded";
    case "VOIDED": return "void";
    default: return "neutral";
  }
}

/** Human-readable title for dotted / namespaced billing audit types (display only). */
export function humanizeRawBillingEventType(type: string): string {
  const t = String(type || "").trim();
  if (!t) return "Billing activity";

  const billingPlanSub: Record<string, string> = {
    current_assigned: "Company billing plan linked",
    scheduled_set: "Future plan change scheduled",
    scheduled_cleared: "Scheduled plan change removed",
    changed: "Billing plan updated",
    unlinked: "Billing plan unlinked",
  };
  if (t.startsWith("billing_plan.")) {
    const sub = t.slice("billing_plan.".length);
    return billingPlanSub[sub] || `Billing plan: ${sub.replace(/_/g, " ")}`;
  }

  if (t.startsWith("tenant_settings.")) {
    const sub = t.slice("tenant_settings.".length);
    return `Company settings: ${sub.replace(/_/g, " ")}`;
  }

  if (t.startsWith("collections.")) {
    const sub = t.slice("collections.".length);
    const map: Record<string, string> = {
      paused: "Collections paused",
      resumed: "Collections resumed",
      do_not_charge: "Auto-charge turned off for invoice",
      skip_next_retry: "Next autopay retry skipped",
    };
    return map[sub] || `Collections: ${sub.replace(/_/g, " ")}`;
  }

  if (t.startsWith("billing.")) {
    return t
      .slice("billing.".length)
      .replace(/\./g, " — ")
      .replace(/_/g, " ");
  }

  return t.replace(/\./g, " · ").replace(/_/g, " ");
}

export function billingEventIcon(type: string | undefined | null): string {
  const t = String(type || "").toLowerCase();
  if (t.includes("void")) return "⌀";
  if (t.includes("fail") || t.includes("declin") || t.includes("error")) return "!";
  if (t.includes("success") || t.includes("paid") || t.includes("approv")) return "✓";
  if (t.includes("email") || t.includes("sms") || t.includes("link")) return "✉";
  if (t.includes("invoice_created") || t.includes("created")) return "+";
  if (t.includes("webhook")) return "↩";
  if (t.includes("billing_plan") || t.includes("plan")) return "◇";
  if (t.includes("tenant") || t.includes("settings") || t.includes("pricing")) return "⚙";
  if (t.includes("collections") || t.includes("pause") || t.includes("retry")) return "⏱";
  return "•";
}

/** Group audit events by calendar day label (display only, preserves order within each day). */
export function groupBillingEventsByDay<T extends { createdAt: string }>(
  events: T[],
): { label: string; items: T[] }[] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const ev of events) {
    const d = new Date(ev.createdAt);
    const label = Number.isNaN(d.getTime())
      ? "Unknown date"
      : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    if (!map.has(label)) {
      map.set(label, []);
      order.push(label);
    }
    map.get(label)!.push(ev);
  }
  return order.map((label) => ({ label, items: map.get(label)! }));
}

export function billingEventLabel(type: string | undefined | null): string {
  switch (String(type || "")) {
    case "invoice_created": return "Invoice created";
    case "invoice_emailed": return "Invoice emailed";
    case "payment_succeeded": return "Payment succeeded";
    case "payment_failed": return "Payment failed";
    case "payment_link_emailed": return "Payment link emailed";
    case "invoice_marked_paid": return "Marked as paid";
    case "invoice_voided": return "Invoice voided";
    case "webhook.received": return "Webhook received";
    case "webhook.deduped": return "Webhook duplicate (skipped)";
    case "receipt_emailed": return "Receipt emailed";
    case "payment_failed_emailed": return "Failure notice emailed";
    case "billing.sms_payment_link_sent": return "SMS payment link sent";
    case "billing.sms_payment_link_failed": return "SMS payment link failed";
    default: {
      const raw = String(type || "").trim();
      if (!raw) return "Billing activity";
      return humanizeRawBillingEventType(raw);
    }
  }
}

/** Operator-facing label for stored `billingPricingMode` (portal copy only). */
export function humanizeStoredPricingMode(mode: "legacy" | "catalog" | "custom" | null | undefined): string {
  switch (mode) {
    case "catalog":
      return "Follow company billing plan";
    case "custom":
      return "Custom company pricing";
    case "legacy":
    default:
      return "Standard pricing";
  }
}

/** Maps API / diagnostics `mode` strings to short operator labels. */
export function humanizePricingStateMode(mode: string | undefined | null): string {
  const m = String(mode || "").toLowerCase();
  if (m === "catalog") return "Plan-based";
  if (m === "custom") return "Custom pricing";
  if (m === "legacy") return "Standard";
  return mode || "—";
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

/** Worst status among invoices that are not settled (admin / cockpit summaries). */
export function worstNonTerminalInvoiceStatus(invoices: any[] | undefined | null): string {
  const list = invoices || [];
  const active = list.filter((i) => !["PAID", "VOID"].includes(String(i.status)));
  if (!active.length) return "—";
  if (active.some((i) => i.status === "FAILED")) return "FAILED";
  if (active.some((i) => i.status === "OVERDUE")) return "OVERDUE";
  if (active.some((i) => i.status === "OPEN" || i.status === "DRAFT")) return "OPEN";
  return "—";
}

/** Short operator-facing headline for `worstNonTerminalInvoiceStatus` codes. */
export function adminTenantStandingHeadline(status: string): string {
  if (status === "—") return "In good standing";
  if (status === "FAILED") return "Payment issue";
  if (status === "OVERDUE") return "Overdue balance";
  if (status === "OPEN" || status === "DRAFT") return "Open invoices";
  return "In good standing";
}

/** Mirrors `TenantBillingSettings.metadata.billingFlatRate` (portal display + estimate). */
export type BillingFlatRateConfig = {
  enabled: boolean;
  amountCents: number;
  label?: string;
  appliesTo: "extensions";
};

export function parseBillingFlatRateFromMetadata(metadata: unknown): BillingFlatRateConfig | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).billingFlatRate;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const amountCents = Math.round(Number(o.amountCents));
  const label = typeof o.label === "string" ? o.label.trim().slice(0, 120) : undefined;
  return {
    enabled: o.enabled === true,
    amountCents: Number.isFinite(amountCents) ? Math.max(0, amountCents) : 0,
    ...(label ? { label } : {}),
    appliesTo: "extensions",
  };
}

export function activeExtensionsFlatRateFromMetadata(metadata: unknown): BillingFlatRateConfig | null {
  const cfg = parseBillingFlatRateFromMetadata(metadata);
  if (!cfg?.enabled || cfg.appliesTo !== "extensions" || cfg.amountCents < 1) return null;
  return cfg;
}

/** Operational monthly estimate for admin pricing workspace (display only — not invoice math). */
export type TenantBillingEstimateLine = {
  key: string;
  label: string;
  quantity: number;
  unitCents: number;
  subtotalCents: number;
  /** Quantity comes from live usage, not operator-editable billing settings. */
  autoQuantity?: boolean;
  omitted?: boolean;
  note?: string;
};

export function computeTenantMonthlyEstimate(input: {
  extensionCount: number;
  additionalPhoneNumberCount: number;
  smsEnabled: boolean;
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  /** When set, extensions bill as one flat monthly line (qty 1). */
  extensionsFlatRateCents?: number | null;
  creditsCents?: number;
  discountPercent?: number;
  /** When set, scales tax estimate proportionally to service subtotal changes. */
  previewServiceSubtotalCents?: number;
  previewTaxCents?: number;
}): {
  lines: TenantBillingEstimateLine[];
  serviceSubtotalCents: number;
  taxEstimateCents: number;
  totalCents: number;
} {
  const lines: TenantBillingEstimateLine[] = [];
  if (input.extensionCount > 0) {
    const flat = input.extensionsFlatRateCents != null && input.extensionsFlatRateCents > 0;
    const sub = flat ? input.extensionsFlatRateCents! : input.extensionCount * input.extensionPriceCents;
    lines.push({
      key: "extensions",
      label: flat ? "Extensions (flat monthly rate)" : "Extensions",
      quantity: flat ? 1 : input.extensionCount,
      unitCents: flat ? input.extensionsFlatRateCents! : input.extensionPriceCents,
      subtotalCents: sub,
      autoQuantity: true,
      note: flat ? `Covers ${input.extensionCount} active extension${input.extensionCount === 1 ? "" : "s"}` : undefined,
    });
  }
  if (input.additionalPhoneNumberCount > 0) {
    const sub = input.additionalPhoneNumberCount * input.additionalPhoneNumberPriceCents;
    lines.push({
      key: "phone_numbers",
      label: "Phone numbers",
      quantity: input.additionalPhoneNumberCount,
      unitCents: input.additionalPhoneNumberPriceCents,
      subtotalCents: sub,
      autoQuantity: true,
    });
  }
  if (input.smsEnabled) {
    lines.push({
      key: "sms",
      label: "SMS package",
      quantity: 1,
      unitCents: input.smsPriceCents,
      subtotalCents: input.smsPriceCents,
      autoQuantity: true,
      note: "Bill SMS package enabled",
    });
  } else {
    lines.push({
      key: "sms",
      label: "SMS package",
      quantity: 0,
      unitCents: input.smsPriceCents,
      subtotalCents: 0,
      autoQuantity: true,
      omitted: true,
      note: "SMS billing off",
    });
  }

  let serviceSubtotalCents = lines.filter((l) => !l.omitted).reduce((sum, l) => sum + l.subtotalCents, 0);
  const credit = Math.max(0, Number(input.creditsCents || 0));
  if (credit > 0) {
    const creditLine = -credit;
    lines.push({ key: "credit", label: "Account credit", quantity: 1, unitCents: creditLine, subtotalCents: creditLine });
    serviceSubtotalCents += creditLine;
  }
  const discount = Number(input.discountPercent || 0);
  if (discount > 0 && serviceSubtotalCents > 0) {
    const discountCents = -Math.round(serviceSubtotalCents * discount);
    lines.push({
      key: "discount",
      label: `Discount (${(discount * 100).toFixed(0)}%)`,
      quantity: 1,
      unitCents: discountCents,
      subtotalCents: discountCents,
    });
    serviceSubtotalCents += discountCents;
  }

  const previewSvc = Number(input.previewServiceSubtotalCents || 0);
  const previewTax = Number(input.previewTaxCents || 0);
  const taxEstimateCents =
    previewSvc > 0 && previewTax > 0
      ? Math.max(0, Math.round((previewTax * Math.max(0, serviceSubtotalCents)) / previewSvc))
      : 0;
  const totalCents = Math.max(0, serviceSubtotalCents + taxEstimateCents);
  return { lines, serviceSubtotalCents, taxEstimateCents, totalCents };
}

/** Sum service line types from an invoice preview payload (display helper). */
export function previewServiceSubtotalCents(preview: { lineItems?: Array<{ type?: string; amountCents?: number }> } | null | undefined): number {
  if (!preview?.lineItems?.length) return 0;
  const serviceTypes = new Set(["EXTENSION", "PHONE_NUMBER", "SMS_PACKAGE", "CREDIT", "DISCOUNT"]);
  return preview.lineItems
    .filter((item) => serviceTypes.has(String(item.type || "")))
    .reduce((sum, item) => sum + Number(item.amountCents || 0), 0);
}

/** Earliest due date among non-settled invoices (display only). */
export function nextOpenInvoiceDueSummary(invoices: any[] | undefined | null): string | null {
  const open = (invoices || []).filter((i) =>
    ["OPEN", "FAILED", "OVERDUE", "DRAFT"].includes(String(i.status)) && i.dueDate,
  );
  if (!open.length) return null;
  open.sort((a, b) => new Date(String(a.dueDate)).getTime() - new Date(String(b.dueDate)).getTime());
  const inv = open[0];
  return `Next due ${formatDate(inv.dueDate)} · ${inv.invoiceNumber || "Invoice"}`;
}
