// Delivery reporting routes (Phase 11). Permission-gated (can_view_tracking_reports via the
// delivery VIEW_REPORTS key). Read-only.

import { requireDeliveryPermission } from "./guard";
import { DELIVERY_PERMISSIONS } from "./permissions";
import { buildTenantReport } from "./reportService";

export async function registerDeliveryReportRoutes(app: any): Promise<void> {
  app.get("/delivery/reports/summary", async (req: any, reply: any) => {
    const user = await requireDeliveryPermission(req, reply, DELIVERY_PERMISSIONS.VIEW_REPORTS);
    if (!user) return;
    const days = Math.max(1, Math.min(90, Number(req.query?.days) || 7));
    return reply.send(await buildTenantReport(user.tenantId, days));
  });
}
