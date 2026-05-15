import { db } from "@connect/db";
import { crmCampaignMemberActionableNonTerminalWhere } from "./crmMemberQueryFragments";

/**
 * Non-blocking: if no **live-contact** non-terminal members remain, mark campaign COMPLETED.
 * Terminal = CONVERTED | SKIPPED | DO_NOT_CALL | CONTACTED
 * Non-terminal (actionable when contact is live) = PENDING | IN_PROGRESS | CALLBACK
 *
 * Phase 16D: archived/inactive contacts do not keep a campaign open — historical member rows unchanged.
 */
export async function checkAndAutoCompleteCampaign(campaignId: string, tenantId: string): Promise<void> {
  try {
    const nonTerminalActionableCount = await db.crmCampaignMember.count({
      where: {
        campaignId,
        tenantId,
        ...crmCampaignMemberActionableNonTerminalWhere,
      },
    });
    if (nonTerminalActionableCount === 0) {
      const totalCount = await db.crmCampaignMember.count({ where: { campaignId, tenantId } });
      if (totalCount > 0) {
        await db.crmCampaign.updateMany({
          where: { id: campaignId, tenantId, status: { in: ["ACTIVE", "PAUSED"] } },
          data: { status: "COMPLETED" },
        });
      }
    }
  } catch {
    // Non-blocking: swallow errors
  }
}
