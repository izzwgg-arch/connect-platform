"use client";

/** Table-shaped loading placeholder for admin billing registers (invoices / payments). */
export function BillingTableSkeleton({
  variant = "invoice",
  rows = 8,
}: {
  variant?: "invoice" | "tx";
  rows?: number;
}) {
  return (
    <div
      className={`billing-p8-skeleton billing-p8-skeleton--${variant}`}
      aria-busy="true"
      aria-label="Loading billing data"
      role="status"
    >
      <div className="billing-p8-skeleton__head" aria-hidden />
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="billing-p8-skeleton__row" aria-hidden />
      ))}
    </div>
  );
}
