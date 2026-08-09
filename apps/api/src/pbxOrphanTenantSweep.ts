/**
 * Tenants deleted on the PBX.
 *
 * Deleting a tenant in VitalPBX used to do exactly one thing in Connect: the
 * PbxTenantDirectory row disappeared on the next sync. The Connect tenant
 * survived — with its users, extensions, numbers, call history, voicemail,
 * contacts, billing settings and invoices — and its TenantPbxLink stayed marked
 * LINKED, still pointing at a PBX tenant that no longer existed. Nothing in
 * Connect ever learned the company was dead.
 *
 * The result was 22 ghosts against 28 live PBX tenants: 50 companies in the
 * billing screens, 22 user accounts that could still sign in, "Needs you"
 * showing 57 items, and every billing count inflated by roughly two thirds.
 *
 * ⛔ THE DANGEROUS PART. The trigger is a list fetched from the PBX. If that
 * list comes back short — a partial answer, a permissions hiccup, a timeout
 * part-way through — everything missing from it looks deleted. Today that only
 * costs directory rows, which return on the next sync. Wired to a real delete,
 * one bad answer destroys live paying customers permanently, and the Postgres
 * backups only reach fifteen days. So:
 *
 *   1. A tenant is only a candidate if it HAS a link whose pbxTenantId is
 *      absent from the directory. Never-linked tenants were never on the PBX,
 *      so "deleted on the PBX" never happened to them — they are left alone.
 *   2. Nothing is destroyed on the sync path. The sweep marks `pbxRemovedAt`,
 *      which takes the tenant out of every list and stops all billing. The
 *      permanent erase is a separate, explicitly confirmed call.
 *   3. Any pass proposing more than MAX_AUTO_REMOVALS does nothing at all and
 *      reports instead. A sweep that suddenly wants to remove twenty companies
 *      is a bug until a person says otherwise.
 *   4. A tenant that has ever completed a payment is never erased. Its books
 *      are kept and the rest is closed.
 */

import type { PrismaClient } from "@connect/db";

/** More than this in one pass and the sweep refuses to act on its own. */
export const MAX_AUTO_REMOVALS = 3;

export type OrphanTenant = {
  tenantId: string;
  name: string;
  /** The PBX tenant id Connect still has on file, which no longer exists. */
  pbxTenantId: string;
  hasCompletedPayment: boolean;
  users: number;
  invoices: number;
  paymentMethods: number;
};

export type OrphanSweepPlan = {
  /** False when the PBX answer was not trustworthy — the sweep does nothing. */
  healthy: boolean;
  reason?: string;
  orphans: OrphanTenant[];
  /** True when there are more orphans than the sweep will act on unattended. */
  needsConfirmation: boolean;
};

/**
 * Was the tenant list we just received from the PBX trustworthy?
 *
 * An empty list is the classic broken answer — every tenant would look deleted.
 * A list that lost most of what we knew about is the subtler one, and it is
 * exactly what a paginated or permission-filtered response looks like.
 */
export function isPbxAnswerHealthy(input: {
  seenCount: number;
  knownCount: number;
}): { healthy: boolean; reason?: string } {
  if (input.seenCount <= 0) {
    return { healthy: false, reason: "the PBX returned no tenants at all" };
  }
  // A real deletion moves this by a tenant or two. Losing half the estate in one
  // sync is a broken answer, not twenty-eight resignations.
  if (input.knownCount > 0 && input.seenCount < input.knownCount / 2) {
    return {
      healthy: false,
      reason: `the PBX returned ${input.seenCount} tenants when Connect knew of ${input.knownCount}`,
    };
  }
  return { healthy: true };
}

/** Which Connect tenants point at a PBX tenant that no longer exists. */
export async function findOrphanTenants(db: PrismaClient, pbxInstanceId: string): Promise<OrphanTenant[]> {
  const [links, directory] = await Promise.all([
    (db as any).tenantPbxLink.findMany({
      where: { pbxInstanceId, pbxTenantId: { not: null } },
      select: { tenantId: true, pbxTenantId: true },
    }),
    (db as any).pbxTenantDirectory.findMany({
      where: { pbxInstanceId },
      select: { vitalTenantId: true },
    }),
  ]);

  const live = new Set<string>(directory.map((d: any) => String(d.vitalTenantId)));
  const deadLinks = links.filter((l: any) => !live.has(String(l.pbxTenantId)));
  if (deadLinks.length === 0) return [];

  const tenantIds = deadLinks.map((l: any) => l.tenantId);
  const [tenants, paidInvoices, approvedTx] = await Promise.all([
    (db as any).tenant.findMany({
      where: { id: { in: tenantIds }, pbxRemovedAt: null },
      select: {
        id: true,
        name: true,
        _count: { select: { users: true, billingInvoices: true, paymentMethods: true } },
      },
    }),
    (db as any).billingInvoice.groupBy({
      by: ["tenantId"],
      where: { tenantId: { in: tenantIds }, status: "PAID" },
      _count: { _all: true },
    }),
    (db as any).paymentTransaction
      .groupBy({
        by: ["tenantId"],
        where: { tenantId: { in: tenantIds }, status: "APPROVED" },
        _count: { _all: true },
      })
      .catch(() => [] as any[]),
  ]);

  // "Real money moved" is a paid invoice OR an approved card charge. Both,
  // because a tenant can be paid off-card and a charge can precede its invoice.
  const withMoney = new Set<string>([
    ...paidInvoices.map((r: any) => r.tenantId),
    ...approvedTx.map((r: any) => r.tenantId),
  ]);
  const pbxIdByTenant = new Map<string, string>(deadLinks.map((l: any) => [l.tenantId, String(l.pbxTenantId)]));

  return tenants.map((t: any) => ({
    tenantId: t.id,
    name: t.name,
    pbxTenantId: pbxIdByTenant.get(t.id) || "",
    hasCompletedPayment: withMoney.has(t.id),
    users: t._count.users,
    invoices: t._count.billingInvoices,
    paymentMethods: t._count.paymentMethods,
  }));
}

/** What the sweep would do, without doing any of it. */
export async function planOrphanSweep(
  db: PrismaClient,
  pbxInstanceId: string,
  answer: { seenCount: number; knownCount: number },
): Promise<OrphanSweepPlan> {
  const health = isPbxAnswerHealthy(answer);
  if (!health.healthy) {
    return { healthy: false, reason: health.reason, orphans: [], needsConfirmation: false };
  }
  const orphans = await findOrphanTenants(db, pbxInstanceId);
  return {
    healthy: true,
    orphans,
    needsConfirmation: orphans.length > MAX_AUTO_REMOVALS,
  };
}

export type RemovalOutcome = {
  tenantId: string;
  name: string;
  action: "archived" | "removed";
  reason: string;
};

/**
 * Take a tenant out of Connect because its PBX tenant is gone.
 *
 * This never destroys anything. It stamps `pbxRemovedAt`, which drops the
 * tenant from every list and stops billing, and marks the PBX link UNLINKED so
 * nothing keeps chasing a tenant id that does not exist. Tenants holding
 * completed payments are additionally stamped `archivedAt` so the permanent
 * erase will skip them and keep the books.
 */
export async function markTenantRemoved(
  db: PrismaClient,
  orphan: OrphanTenant,
): Promise<RemovalOutcome> {
  const now = new Date();
  await (db as any).tenant.update({
    where: { id: orphan.tenantId },
    data: {
      pbxRemovedAt: now,
      // Both are what every other screen already filters on, so the tenant
      // disappears from the sidebar and the admin pickers immediately.
      isApproved: false,
      ...(orphan.hasCompletedPayment ? { archivedAt: now } : {}),
    },
  });
  await (db as any).tenantPbxLink
    .updateMany({
      where: { tenantId: orphan.tenantId },
      data: { status: "UNLINKED", lastError: "PBX tenant no longer exists", lastSyncAt: now },
    })
    .catch(() => undefined);
  // Stop automatic charging immediately — a removed tenant must never be billed
  // again, whatever happens to the rest of the clean-up.
  await (db as any).tenantBillingSettings
    .updateMany({ where: { tenantId: orphan.tenantId }, data: { autoBillingEnabled: false } })
    .catch(() => undefined);

  return {
    tenantId: orphan.tenantId,
    name: orphan.name,
    action: orphan.hasCompletedPayment ? "archived" : "removed",
    reason: orphan.hasCompletedPayment
      ? "has completed payments — books kept, everything else closed"
      : "no completed payment — queued for permanent removal",
  };
}

/**
 * Run after a directory sync. Marks removed only what it is safe to mark
 * unattended; anything larger is reported and left for a person.
 */
export async function runOrphanSweepAfterSync(
  db: PrismaClient,
  pbxInstanceId: string,
  sync: { seenCount: number; knownCount: number },
  log?: { warn: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void },
): Promise<{
  healthy: boolean;
  reason?: string;
  found: number;
  marked: RemovalOutcome[];
  awaitingConfirmation: OrphanTenant[];
}> {
  const plan = await planOrphanSweep(db, pbxInstanceId, sync);
  if (!plan.healthy) {
    // Loud on purpose: a PBX answer we refused to trust is the exact condition
    // that would otherwise have deleted live customers.
    log?.warn({ event: "pbx_orphan_sweep_skipped", reason: plan.reason }, "pbx_orphan_sweep_skipped");
    return { healthy: false, reason: plan.reason, found: 0, marked: [], awaitingConfirmation: [] };
  }
  if (plan.orphans.length === 0) {
    return { healthy: true, found: 0, marked: [], awaitingConfirmation: [] };
  }
  if (plan.needsConfirmation) {
    log?.warn(
      {
        event: "pbx_orphan_sweep_needs_confirmation",
        found: plan.orphans.length,
        cap: MAX_AUTO_REMOVALS,
        names: plan.orphans.map((o) => o.name),
      },
      "pbx_orphan_sweep_needs_confirmation",
    );
    return { healthy: true, found: plan.orphans.length, marked: [], awaitingConfirmation: plan.orphans };
  }

  const marked: RemovalOutcome[] = [];
  for (const orphan of plan.orphans) {
    marked.push(await markTenantRemoved(db, orphan));
  }
  log?.info({ event: "pbx_orphan_sweep_marked", marked }, "pbx_orphan_sweep_marked");
  return { healthy: true, found: plan.orphans.length, marked, awaitingConfirmation: [] };
}

/**
 * The permanent erase. Only ever reached from an explicit, confirmed admin
 * call — never from the sync path.
 *
 * ⛔ Refuses any tenant that has completed a payment, and any tenant that has
 * not first been marked removed. The tenant row cascades to everything beneath
 * it: users, extensions, numbers, call history, voicemail, contacts, chats.
 */
export async function eraseRemovedTenant(
  db: PrismaClient,
  tenantId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await (db as any).tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, pbxRemovedAt: true, archivedAt: true },
  });
  if (!tenant) return { ok: false, error: "tenant_not_found" };
  if (!tenant.pbxRemovedAt) return { ok: false, error: "tenant_not_marked_removed" };
  if (tenant.archivedAt) return { ok: false, error: "tenant_has_completed_payments" };

  // Re-check the money at the moment of deletion rather than trusting the flag
  // — this is irreversible and the flag was written by an earlier pass.
  const [paid, approved] = await Promise.all([
    (db as any).billingInvoice.count({ where: { tenantId, status: "PAID" } }),
    (db as any).paymentTransaction.count({ where: { tenantId, status: "APPROVED" } }).catch(() => 0),
  ]);
  if (paid > 0 || approved > 0) return { ok: false, error: "tenant_has_completed_payments" };

  await (db as any).tenant.delete({ where: { id: tenantId } });
  return { ok: true };
}
