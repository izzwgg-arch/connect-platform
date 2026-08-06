/**
 * The approval hash for a chat-prepared permission grant. Node-only (uses
 * `node:crypto`), so it is a SUBPATH import — never re-exported from the
 * package root, which the portal bundles for the browser.
 *
 * Written by `apps/agent` when it drafts the grant, recomputed by `apps/api`
 * from the STORED params before applying. If the two ever disagree the grant is
 * refused — which is exactly what stops an approval for one grant being spent
 * on a different one.
 */
import { createHash } from "node:crypto";
import { grantParamsHashInput } from "./chatPermissionGrants";

export function permissionParamsHash(
  tenantId: string,
  targetUserId: string,
  permissionKey: string,
): string {
  return createHash("sha256")
    .update(grantParamsHashInput(tenantId, targetUserId, permissionKey))
    .digest("hex");
}
