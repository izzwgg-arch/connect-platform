import type { Db } from "../db.js";
import { notify } from "../lib/notify.js";
import { audit } from "../lib/audit.js";

/**
 * "moderation.lift" scheduler job (every 10 min): a SUSPENDED person whose
 * SUSPENSION restriction has expired goes back to ACTIVE automatically. A ban
 * never expires — this job only ever touches SUSPENDED accounts.
 */
export async function liftExpiredSuspensions(db: Db): Promise<void> {
  const expired = await db.restriction.findMany({ where: { kind: "SUSPENSION", expiresAt: { lte: new Date() } }, select: { personId: true } });
  const personIds = [...new Set(expired.map((r) => r.personId))];
  for (const personId of personIds) {
    const person = await db.person.findUnique({ where: { id: personId }, select: { status: true } });
    if (person?.status !== "SUSPENDED") continue;
    await db.person.update({ where: { id: personId }, data: { status: "ACTIVE" } });
    await notify(db, { personId, kind: "moderation.action", title: "Your suspension has ended", body: "Your account is active again.", href: "/settings/notices" });
    await audit(db, { action: "moderation.suspension_lifted", targetType: "Person", targetId: personId, source: "scheduler" });
  }
}
