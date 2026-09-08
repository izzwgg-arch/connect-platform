-- Orders page date-range filter + paging (2026-09-08): GET /delivery/orders now
-- filters and paginates on createdAt per tenant, so the newest-first scan needs
-- a matching index. Additive only — no table, column or row is touched.
CREATE INDEX "DeliveryOrder_tenantId_createdAt_idx" ON "DeliveryOrder"("tenantId", "createdAt");
