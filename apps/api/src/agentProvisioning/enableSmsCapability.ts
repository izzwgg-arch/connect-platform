/**
 * "I want to activate SMS" — turn texting on, decide whose inbox it lands in,
 * and put it on next month's bill.
 *
 * ⛔ What actually switches texting on is Connect-side, not VoIP.ms-side: the
 * DID needs `sms_enabled=1` AND a `TenantSmsNumber` row pointing it at the
 * tenant. Inbound delivery is configured account-wide, so nothing per-number
 * has to be armed — and the `webhook_enabled` flag that looks like the switch
 * is a proven red herring (the platform's busiest SMS number has it set to 0).
 *
 * The inbox choice maps onto what the schema already models:
 *   · one person   → `assignedUserId`
 *   · some people  → `TenantSmsNumberUser` rows
 *   · everybody    → no assignment at all, which is the shared-inbox default
 */
import {
  refuse,
  type ConfirmCapability,
} from "../agentConfirmations";
import { defaultBillingDeps } from "./billingReconcile";

import {
  ENABLE_SMS_CAPABILITY_ID,
  enableSmsHashInput,
  SMS_INBOX_SCOPES,
  type SmsInboxScope,
} from "@connect/shared";

export { ENABLE_SMS_CAPABILITY_ID };

export type EnableSmsParams = {
  scope: SmsInboxScope;
  /** Empty for "everyone"; one id for "one_person"; several for "shared_with". */
  userIds: string[];
};

/**
 * The `TenantSmsNumber` row texting will run on.
 *
 * ⛔ Every DID on the VoIP.ms account is synced into `TenantSmsNumber` and sits
 * there with `tenantId: null` until someone CLAIMS it — most rows on the
 * platform are unclaimed. So a company that has never texted usually has no row
 * of its own, and looking only for `tenantId = ours` wrongly reports "this
 * account has no number for texting".
 *
 * We therefore fall back to the company's own DIDs and match an UNCLAIMED row.
 * ⛔ Only `tenantId: null` rows are ever eligible — claiming a row that belongs
 * to another company would hand them someone else's texts.
 */
export async function findTextableNumber(
  db: any,
  tenantId: string,
): Promise<{ id: string; phoneE164: string; voipmsDid: string | null; needsClaim: boolean } | null> {
  const claimed = await db.tenantSmsNumber.findFirst({
    where: { tenantId, active: true },
    orderBy: [{ isTenantDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, phoneE164: true, voipmsDid: true },
  });
  if (claimed) return { ...claimed, needsClaim: false };

  const dids = await db.pbxTenantInboundDid.findMany({
    where: { connectTenantId: tenantId, active: true },
    select: { e164: true },
    take: 25,
  });
  const candidates = dids.map((d: any) => String(d.e164 || "").trim()).filter(Boolean);
  if (!candidates.length) return null;

  const unclaimed = await db.tenantSmsNumber.findFirst({
    where: { tenantId: null, active: true, phoneE164: { in: candidates } },
    select: { id: true, phoneE164: true, voipmsDid: true },
  });
  return unclaimed ? { ...unclaimed, needsClaim: true } : null;
}

export const enableSmsCapability: ConfirmCapability<EnableSmsParams> = {
  id: ENABLE_SMS_CAPABILITY_ID,
  // Reaches VoIP.ms — cannot be rolled back.
  transactional: false,

  parseParams(raw) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const scope = String(p.scope ?? "") as SmsInboxScope;
    if (!SMS_INBOX_SCOPES.includes(scope)) return null;
    const userIds = Array.isArray(p.userIds) ? p.userIds.map((x) => String(x)).filter(Boolean) : [];
    if (scope === "one_person" && userIds.length !== 1) return null;
    if (scope === "shared_with" && userIds.length === 0) return null;
    if (scope === "everyone" && userIds.length !== 0) return null;
    return { scope, userIds };
  },

  hashInput: enableSmsHashInput,

  async authorize(deps, ctx) {
    const settings = await deps.db.tenantBillingSettings.findUnique({
      where: { tenantId: ctx.tenantId },
      select: { smsBillingEnabled: true },
    });
    if (settings?.smsBillingEnabled) {
      return {
        status: 409,
        error: "sms_already_on",
        message: "Text messaging is already switched on for this account.",
      };
    }

    // Texting rides a phone number — without one there is nothing to enable.
    const number = await findTextableNumber(deps.db, ctx.tenantId);
    if (!number) {
      return {
        status: 409,
        error: "no_sms_number",
        message:
          "This account doesn't have a number set up for texting yet. Ask in the chat to add a phone number first.",
      };
    }

    // Everyone named must still be on this account.
    if (ctx.params.userIds.length) {
      const found = await deps.db.user.findMany({
        where: { id: { in: ctx.params.userIds }, tenantId: ctx.tenantId, status: { not: "DISABLED" } },
        select: { id: true },
      });
      if (found.length !== ctx.params.userIds.length) {
        return {
          status: 409,
          error: "user_unavailable",
          message: "One of those people is no longer on this account. Ask again in the chat.",
        };
      }
    }
    return null;
  },

  async describe(deps, ctx) {
    const billing = deps.billing ?? defaultBillingDeps;
    const snapshot = await billing.snapshot(ctx.tenantId);
    const price = billing.priceOf(snapshot, "sms");
    let who = "shared with everyone on the account";
    if (ctx.params.userIds.length) {
      const users = await deps.db.user.findMany({
        where: { id: { in: ctx.params.userIds } },
        select: { email: true, firstName: true, lastName: true },
      });
      const names = users.map(
        (u: any) => [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email,
      );
      who =
        ctx.params.scope === "one_person"
          ? `going to ${names[0]} only`
          : `shared between ${names.join(", ")}`;
    }
    return {
      summary: `Turn on text messaging, with the inbox ${who}.`,
      priceLine: `${billing.format(price.unitCents)} a month, added to your next bill.`,
    };
  },

  async execute(deps, ctx) {
    const billing = deps.billing ?? defaultBillingDeps;
    const before = await billing.snapshot(ctx.tenantId);
    const quoted = billing.priceOf(before, "sms");

    const number = await findTextableNumber(deps.db, ctx.tenantId);
    if (!number) throw refuse(409, "no_sms_number", "This account doesn't have a number set up for texting.");

    // Claim the inventory row for this company and make it the number they text
    // FROM. `isTenantDefault` is the real "text from this number" setting —
    // `tenant.defaultSmsFromNumberId` is null on every working tenant.
    if (number.needsClaim) {
      await deps.db.tenantSmsNumber.updateMany({
        where: { tenantId: ctx.tenantId, isTenantDefault: true },
        data: { isTenantDefault: false },
      });
      await deps.db.tenantSmsNumber.update({
        where: { id: number.id },
        data: { tenantId: ctx.tenantId, isTenantDefault: true, active: true },
      });
    }

    // 1 ─ Billing. `smsBillingEnabled` is what the invoice engine reads, and it
    // is the whole billing switch — proven live on inii mini, whose next
    // invoice moved $35 → $45 with a single SMS_PACKAGE line.
    //
    // ⛔ `tenant.smsSendMode` is deliberately NOT touched. It stays TEST on
    // every working tenant: LIVE belongs to the old SMS-campaign path, which
    // reads the `phoneNumber` table and 10DLC approval. Onboarding tenants have
    // no `phoneNumber` rows at all, so flipping LIVE would demand a sender
    // number that does not exist and would break campaign sends without doing
    // anything for texting. Same for `defaultSmsFromNumberId` (null everywhere
    // — `isTenantDefault` on the number row is the real setting) and
    // `smsPrimaryProvider` (reads TWILIO on every working tenant; the texting
    // path goes through VoIP.ms regardless).
    await deps.db.tenantBillingSettings.update({
      where: { tenantId: ctx.tenantId },
      data: { smsBillingEnabled: true },
    });

    // 2 ─ Whose inbox. Setting multi-user assignments clears the single-user
    // field, exactly as the portal's own assignment route does.
    if (ctx.params.scope === "one_person") {
      await deps.db.tenantSmsNumberUser.deleteMany({ where: { tenantSmsNumberId: number.id } });
      await deps.db.tenantSmsNumber.update({
        where: { id: number.id },
        data: { assignedUserId: ctx.params.userIds[0], assignedExtensionId: null },
      });
    } else if (ctx.params.scope === "shared_with") {
      await deps.db.tenantSmsNumber.update({
        where: { id: number.id },
        data: { assignedUserId: null, assignedExtensionId: null },
      });
      await deps.db.tenantSmsNumberUser.deleteMany({ where: { tenantSmsNumberId: number.id } });
      await deps.db.tenantSmsNumberUser.createMany({
        data: ctx.params.userIds.map((userId) => ({
          tenantSmsNumberId: number.id,
          userId,
          inboxMode: "SHARED",
        })),
        skipDuplicates: true,
      });
    } else {
      // Everybody: no assignment rows at all is the shared-inbox default.
      await deps.db.tenantSmsNumberUser.deleteMany({ where: { tenantSmsNumberId: number.id } });
      await deps.db.tenantSmsNumber.update({
        where: { id: number.id },
        data: { assignedUserId: null, assignedExtensionId: null },
      });
    }

    // 3 ─ The carrier side. Best-effort and never fatal: the Connect rows are
    // what decide routing, and a DID that is already SMS-enabled answers an
    // unhelpful wait message rather than an error.
    let carrierNote = "";
    const did = String(number.voipmsDid || number.phoneE164 || "").replace(/^\+?1/, "");
    if (did && deps.enableSmsOnDid) {
      const r = await deps.enableSmsOnDid(did).catch((e: any) => ({ ok: false, detail: String(e) }));
      if (!r.ok) {
        carrierNote =
          " Texting is on in Connect; the carrier didn't confirm the change, so if messages don't arrive within a few minutes someone should check the number at VoIP.ms.";
      }
    }

    // 4 ─ Make sure the money followed.
    const reconciled = await billing.reconcile({
      tenantId: ctx.tenantId,
      kind: "sms",
      before,
      quotedUnitCents: quoted.unitCents,
      actorUserId: ctx.actor.sub,
    });

    const parts = [`Done — text messaging is on for ${number.phoneE164}.`];
    if (carrierNote) parts.push(carrierNote.trim());
    parts.push(
      `Next month's bill goes from ${billing.format(before.monthlyTotalCents)} to ${billing.format(reconciled.monthlyTotalCents)}.`,
    );
    if (reconciled.warning) parts.push(reconciled.warning);

    return {
      message: parts.join(" "),
      details: {
        phoneE164: number.phoneE164,
        scope: ctx.params.scope,
        assignedUserIds: ctx.params.userIds,
        monthlyTotalCents: reconciled.monthlyTotalCents,
        deltaCents: reconciled.deltaCents,
      },
    };
  },
};
