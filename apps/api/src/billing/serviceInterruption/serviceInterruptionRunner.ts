/**
 * The glue: real implementations of the sweep's `sendReminder`, `interrupt`
 * and `restore`, wiring the decision layer to the ARS executor and the emails.
 *
 * Both halves were proven separately — the decision logic in unit tests, the
 * ARS cutoff live on the PBX (12/12 transitions verified in Asterisk). This is
 * what joins them, and until it existed the feature could not run at all.
 */

import { buildBillingEmailJobCreateData } from "../billingAuth";
import { resolveInvoiceEmailBranding } from "../invoiceBranding";
import {
  serviceInterruptedEmail,
  serviceInterruptionReminderEmail,
  serviceRestoredEmail,
} from "../emailTemplates";
import { applyArsRegen, setMembersEnabled } from "./arsMemberToggle";
import { buildInterruptionPlan, buildRestorePlan, type ArsMemberRef } from "./serviceInterruptionPlan";
import type { SweepDeps } from "./serviceInterruptionJob";

/** Email types, so both are greppable and neither can collide with a muted one. */
export const SERVICE_INTERRUPTION_EMAIL = {
  reminder: "BILLING_SERVICE_INTERRUPTION_REMINDER",
  interrupted: "BILLING_SERVICE_INTERRUPTED",
  restored: "BILLING_SERVICE_RESTORED",
} as const;

export type RunnerContext = {
  db: any;
  /** Opens a logged-in panel session. */
  panel: () => Promise<{ session: any; mainTenantPath: string }>;
  /** Reads the tenant's outbound profiles and their members from ombutel. */
  readArsMembers: (pbxTenantId: string) => Promise<ArsMemberRef[]>;
  /** Re-bakes Connect doorways after a regen. */
  rebakeDoorways: () => Promise<void>;
  log: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void; error: (o: any, m: string) => void };
};

/**
 * mainEmail → billingEmail → oldest TENANT_ADMIN.
 * ⛔ The same chain `portCompleteEmail` proved against the live database.
 * Never an ordinary USER, and never another tenant's admin.
 */
async function recipientFor(db: any, tenantId: string): Promise<string | null> {
  const bs = await db.tenantBillingSettings
    .findUnique({ where: { tenantId }, select: { billingEmail: true } })
    .catch(() => null);
  const billing = String(bs?.billingEmail || "").trim();
  if (billing) return billing;
  const admin = await db.user
    .findFirst({
      where: { tenantId, role: "TENANT_ADMIN" },
      orderBy: { createdAt: "asc" },
      select: { email: true },
    })
    .catch(() => null);
  const email = String(admin?.email || "").trim();
  return email || null;
}

async function invoiceFor(db: any, invoiceId: string) {
  return db.billingInvoice
    .findUnique({
      where: { id: invoiceId },
      select: { invoiceNumber: true, balanceDueCents: true, totalCents: true },
    })
    .catch(() => null);
}

/** The public pay link for this invoice. */
function payUrl(invoiceId: string): string {
  const base = (process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com").replace(/\/$/, "");
  return `${base}/pay/invoice/${invoiceId}`;
}

/** Which PBX tenant this Connect tenant is, or null. */
async function pbxTenantIdFor(db: any, tenantId: string): Promise<string | null> {
  const link = await db.tenantPbxLink
    .findFirst({
      where: { tenantId, OR: [{ status: "LINKED" }, { status: "ERROR", pbxTenantId: { not: null } }] },
      select: { pbxTenantId: true },
    })
    .catch(() => null);
  const id = String(link?.pbxTenantId || "").trim();
  return id || null;
}

/** Build the sweep's dependencies from a live context. */
export function buildSweepDeps(ctx: RunnerContext): Omit<SweepDeps, "now"> {
  const { db, log } = ctx;

  const queue = async (tenantId: string, type: string, tpl: { subject: string; html: string; text: string }) => {
    const to = await recipientFor(db, tenantId);
    if (!to) {
      // ⛔ Recorded, not swallowed. A customer we cannot reach is exactly the
      // customer who will be surprised when their phones stop.
      log.warn({ tenantId, type }, "[SERVICE_INTERRUPTION] no email address — nothing sent");
      return;
    }
    await db.emailJob.create({
      data: buildBillingEmailJobCreateData({
        tenantId,
        to,
        type,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      }),
    });
  };

  return {
    db,
    log,

    async sendReminder({ tenantId, invoiceId, daysLeft, interruptAt }) {
      const inv = await invoiceFor(db, invoiceId);
      const tpl = serviceInterruptionReminderEmail({
        daysLeft,
        invoiceNumber: inv?.invoiceNumber || invoiceId,
        balanceDueCents: Number(inv?.balanceDueCents ?? inv?.totalCents ?? 0),
        interruptAt,
        payUrl: payUrl(invoiceId),
        brand: resolveInvoiceEmailBranding({}, null),
      });
      await queue(tenantId, SERVICE_INTERRUPTION_EMAIL.reminder, tpl);
    },

    async interrupt({ tenantId, invoiceId }) {
      const pbxTenantId = await pbxTenantIdFor(db, tenantId);
      if (!pbxTenantId) throw new Error(`tenant ${tenantId} has no PBX link — refusing to interrupt`);

      const members = await ctx.readArsMembers(pbxTenantId);
      // Throws NothingToInterruptError when there is nothing enabled, which is
      // better than recording an empty interruption and "restoring" it later.
      const plan = buildInterruptionPlan({ members, inboundRoutes: [] });

      const { session, mainTenantPath } = await ctx.panel();
      const disabled: Array<{ arsId: string; outboundRouteId: string }> = [];
      for (const arsId of plan.arsIds) {
        const ids = plan.disable.filter((m) => m.arsId === arsId).map((m) => m.outboundRouteId);
        const changed = await setMembersEnabled(session, {
          mainTenantPath,
          arsId,
          outboundRouteIds: ids,
          enabled: false,
        });
        for (const c of changed) disabled.push({ arsId, outboundRouteId: c.outboundRouteId });
      }

      // ⛔ Without this the database says "disabled" and the customer keeps
      // dialling out — proven live 2026-08-18. MAIN tenant, then re-bake.
      await applyArsRegen(session, { mainTenantPath });
      await ctx.rebakeDoorways();

      const inv = await invoiceFor(db, invoiceId);
      await queue(
        tenantId,
        SERVICE_INTERRUPTION_EMAIL.interrupted,
        serviceInterruptedEmail({
          invoiceNumber: inv?.invoiceNumber || invoiceId,
          balanceDueCents: Number(inv?.balanceDueCents ?? inv?.totalCents ?? 0),
          payUrl: payUrl(invoiceId),
          brand: resolveInvoiceEmailBranding({}, null),
        }),
      );
      return disabled;
    },

    async restore({ tenantId, members }) {
      if (members.length === 0) {
        // ⛔ Refuse rather than report a restore that restored nothing.
        throw new Error(`tenant ${tenantId} is marked interrupted but no disabled routes were recorded`);
      }
      const plan = buildRestorePlan({ disabledMembers: members, repointedInbound: [] });
      const { session, mainTenantPath } = await ctx.panel();
      for (const arsId of plan.arsIds) {
        await setMembersEnabled(session, {
          mainTenantPath,
          arsId,
          outboundRouteIds: plan.enable.filter((m) => m.arsId === arsId).map((m) => m.outboundRouteId),
          enabled: true,
        });
      }
      await applyArsRegen(session, { mainTenantPath });
      await ctx.rebakeDoorways();

      await queue(
        tenantId,
        SERVICE_INTERRUPTION_EMAIL.restored,
        serviceRestoredEmail({
          invoiceNumber: "—",
          amountPaidCents: 0,
          restoredAt: new Date(),
          brand: resolveInvoiceEmailBranding({}, null),
        }),
      );
    },
  };
}
