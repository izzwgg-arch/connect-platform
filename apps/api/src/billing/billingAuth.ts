/**
 * Tenant-scoped billing API auth (apps/api/src/billing/routes.ts).
 * Kept aligned with server.ts canManageBilling() so portal operators and API agree.
 */
const TENANT_BILLING_JWT_ROLES = ["SUPER_ADMIN", "TENANT_ADMIN", "ADMIN", "BILLING_ADMIN", "BILLING"] as const;

export function canAccessTenantBillingRoutes(role: string | undefined): boolean {
  const r = String(role || "USER");
  return (TENANT_BILLING_JWT_ROLES as readonly string[]).includes(r);
}

/** Platform /admin/billing/* handlers require JWT SUPER_ADMIN (see requirePlatformBilling in routes.ts). */
export function canAccessPlatformAdminBillingRoutes(role: string | undefined): boolean {
  return String(role || "") === "SUPER_ADMIN";
}

export type QueueBillingEmailInput = {
  tenantId: string;
  to: string;
  type: string;
  subject: string;
  html: string;
  text: string;
  invoiceId?: string | null;
};

/** Shape passed to Prisma emailJob.create — single place so tests lock invoiceId wiring. */
export function buildBillingEmailJobCreateData(input: QueueBillingEmailInput) {
  return {
    tenantId: input.tenantId,
    invoiceId: input.invoiceId ?? null,
    type: input.type,
    toEmail: input.to,
    subject: input.subject,
    htmlBody: input.html,
    textBody: input.text,
  };
}
