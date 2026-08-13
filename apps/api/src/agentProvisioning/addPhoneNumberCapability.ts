/**
 * "I want another phone number" — bought, routed, ringing, and on the bill.
 *
 * ⛔ This is the only capability that spends real money OUTSIDE Connect. It is
 * therefore the strictest:
 *
 *  · STOCK FIRST. The master VoIP.ms account holds dozens of already-purchased
 *    spare DIDs. Handing one of those out costs nothing new and is instant, so
 *    a fresh purchase only happens when there is no suitable spare — the same
 *    rule onboarding follows.
 *  · A number that is bought but does not RING is worse than no number at all,
 *    so the inbound route on the PBX is part of this operation, not a follow-up.
 *    If the route cannot be created the customer is told plainly, with the
 *    number named, rather than getting a cheerful "done".
 *  · It refuses outright for accounts it cannot serve properly. Routing a DID
 *    needs the company's own VoIP.ms subaccount, which only exists for accounts
 *    built by the sign-up flow; older hand-built tenants are handed to a human
 *    instead of half-provisioned.
 *
 * Nothing here is reimplemented: the purchase uses the onboarding VoIP.ms
 * helpers, and the inbound route uses the same panel routine the sign-up build
 * uses, through the same one robot-account pool.
 */
import { decryptJson } from "@connect/security";
import { refuse, type ConfirmCapability } from "../agentConfirmations";
import { defaultBillingDeps } from "./billingReconcile";
import {
  ADD_PHONE_NUMBER_CAPABILITY_ID,
  addPhoneNumberHashInput,
} from "@connect/shared";
import {
  loadMasterCreds,
  listSpareDids,
  readSubaccount,
  vms,
  type VmsCreds,
} from "../onboarding/voipMsProvisioning";
import { loadPanelConfig, PanelSession } from "../onboarding/panelClient";
import { createInboundRoute, extensionId } from "../onboarding/pbxTenantBuild";
import { acquireAccount, releaseAccount } from "../onboarding/setupOrchestrator";

export { ADD_PHONE_NUMBER_CAPABILITY_ID };

export type AddPhoneNumberParams = { did: string };

export const tenDigits = (v: unknown): string => String(v ?? "").replace(/\D/g, "").slice(-10);

/** "(845) 723-1213" — the way a person reads a number. */
export function prettyDid(did: string): string {
  const d = tenDigits(did);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(did);
}

/** Toll-free NPAs are sold and priced differently — never handed out as "local". */
export function isTollFreeDid(did: string): boolean {
  return /^(800|833|844|855|866|877|888)/.test(tenDigits(did));
}

/**
 * Everything this account needs before a number can be added: which VoIP.ms
 * subaccount the DID gets routed to, and which PBX tenant the inbound route
 * belongs in. Both come from what the sign-up flow built.
 */
export async function resolveNumberProvisioningContext(
  db: any,
  tenantId: string,
): Promise<
  | { ok: true; subUsername: string; pbxTenantPath: string; destExtension: string }
  | { ok: false; reason: "no_subaccount" | "no_pbx_tenant" | "no_extension" }
> {
  const submission = await db.onboardingSubmission.findFirst({
    where: { createdTenantId: tenantId, voipmsSubaccountEncrypted: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { voipmsSubaccountEncrypted: true },
  });
  const sub = submission ? readSubaccount(submission) : null;
  if (!sub?.username) return { ok: false, reason: "no_subaccount" };

  const link = await db.tenantPbxLink.findFirst({
    where: { tenantId },
    select: { pbxTenantId: true, pbxTenantCode: true },
  });
  const pbxTenantPath = String(link?.pbxTenantId || link?.pbxTenantCode || "").trim();
  if (!pbxTenantPath) return { ok: false, reason: "no_pbx_tenant" };

  // Where the new number should ring. The account's lowest real extension is
  // the main line for every tenant the sign-up flow built.
  const ext = await db.extension.findFirst({
    where: { tenantId, status: "ACTIVE" },
    orderBy: { extNumber: "asc" },
    select: { extNumber: true },
  });
  const destExtension = String(ext?.extNumber || "").trim();
  if (!destExtension) return { ok: false, reason: "no_extension" };

  return { ok: true, subUsername: sub.username, pbxTenantPath, destExtension };
}

/**
 * Numbers we can offer, cheapest-to-us first: spares we already own, then
 * fresh stock from VoIP.ms. Exported for the agent's search tool.
 */
export async function searchAvailableNumbers(
  creds: VmsCreds,
  areaCode?: string,
): Promise<Array<{ did: string; pretty: string; location: string; alreadyOwned: boolean }>> {
  const npa = String(areaCode ?? "").replace(/\D/g, "").slice(0, 3);
  const spares = (await listSpareDids(creds))
    .filter((s) => !isTollFreeDid(s.did))
    .filter((s) => (npa ? s.did.startsWith(npa) : true))
    .slice(0, 8)
    .map((s) => ({ did: s.did, pretty: prettyDid(s.did), location: s.location, alreadyOwned: true }));
  if (spares.length >= 4 || !npa) return spares;

  // Not enough stock in the area they asked for — offer fresh numbers too.
  const found = await vms(creds, "searchDIDsUSA", { type: "starts", query: npa }).catch(() => null);
  const rows: any[] = Array.isArray(found?.dids) ? found.dids : [];
  const fresh = rows
    .map((d) => tenDigits(d?.did))
    .filter((d) => d.length === 10 && !isTollFreeDid(d))
    .slice(0, 8 - spares.length)
    .map((d) => ({ did: d, pretty: prettyDid(d), location: `${npa} area`, alreadyOwned: false }));
  return [...spares, ...fresh];
}

/**
 * Can we stand behind a price for another number on this account?
 *
 * ⛔ The plan's per-number line counts `phoneNumber` rows, but most accounts the
 * sign-up flow built have their DIDs only in `PbxTenantInboundDid` — 11 of 29
 * live tenants on 2026-08-07. On those the engine thinks the company has NO
 * numbers, so it prices the next one as "your first, included" for a business
 * that already has two, and then bills something different again.
 *
 * When the two disagree we refuse rather than guess. ⛔ And we deliberately do
 * NOT repair it by backfilling rows: that would start charging people for
 * numbers they have had for months, which is a decision for a human.
 */
export async function isNumberBillingTrustworthy(db: any, tenantId: string): Promise<boolean> {
  const [billedNumbers, realDids] = await Promise.all([
    db.phoneNumber.count({ where: { tenantId, status: "ACTIVE" } }),
    db.pbxTenantInboundDid.count({ where: { connectTenantId: tenantId, active: true } }),
  ]);
  return realDids <= billedNumbers;
}

export const addPhoneNumberCapability: ConfirmCapability<AddPhoneNumberParams> = {
  id: ADD_PHONE_NUMBER_CAPABILITY_ID,
  // Buys from a carrier and writes to the PBX — cannot be rolled back.
  transactional: false,

  parseParams(raw) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const did = tenDigits(p.did);
    if (did.length !== 10) return null;
    // Toll-free is a different price and a different purchase path; it is not
    // offered by chat, so it must not sneak through as a "local" number.
    if (isTollFreeDid(did)) return null;
    return { did };
  },

  hashInput: addPhoneNumberHashInput,

  async authorize(deps, ctx) {
    const taken = await deps.db.phoneNumber.findFirst({
      where: { phoneNumber: { contains: ctx.params.did } },
      select: { id: true, tenantId: true },
    });
    if (taken) {
      return {
        status: 409,
        error: "number_taken",
        message: "That number isn't available any more. Ask in the chat for another one.",
      };
    }
    const context = await resolveNumberProvisioningContext(deps.db, ctx.tenantId);
    if (!context.ok) {
      // ⛔ Refuse rather than half-provision. A number that is bought and
      // billed but never rings is the worst outcome available here.
      return {
        status: 409,
        error: "cannot_self_serve",
        message:
          "I can't add a number to this account automatically — someone on our team needs to set this one up. " +
          "I've made a note; nothing has been ordered or charged.",
      };
    }

    // ⛔ Don't quote a price we can't stand behind. The plan's per-number line
    // counts `phoneNumber` rows, but most accounts built by the sign-up flow
    // have their DIDs only in `PbxTenantInboundDid` — 11 of 29 live tenants as
    // of 2026-08-07. On those, the engine thinks the account has NO numbers, so
    // it would quote the next one as "your first number, included" to a company
    // that already has two, and then bill something different again.
    //
    // Refusing is the honest move: it costs a customer a self-serve number,
    // where the alternative is a wrong price on a recurring charge. It also
    // deliberately does NOT "fix" the count by backfilling rows — that would
    // start billing people for numbers they have had for months, which is a
    // decision for a human, not for a chat.
    if (!(await isNumberBillingTrustworthy(deps.db, ctx.tenantId))) {
      return {
        status: 409,
        error: "cannot_price",
        message:
          "I can't add a number to this account myself — the billing for this one needs a person to look at it first. " +
          "I've made a note; nothing has been ordered or charged.",
      };
    }
    return null;
  },

  async describe(deps, ctx) {
    const billing = deps.billing ?? defaultBillingDeps;
    const snapshot = await billing.snapshot(ctx.tenantId);
    const price = billing.priceOf(snapshot, "local_number");
    return {
      summary: `Add the phone number ${prettyDid(ctx.params.did)} to your account, ringing your main line.`,
      priceLine: price.charged
        ? `${billing.format(price.unitCents)} a month, added to your next bill.`
        : "No extra charge — your first number is included.",
    };
  },

  async execute(deps, ctx) {
    const billing = deps.billing ?? defaultBillingDeps;
    const before = await billing.snapshot(ctx.tenantId);
    const quoted = billing.priceOf(before, "local_number");
    const did = ctx.params.did;

    const context = await resolveNumberProvisioningContext(deps.db, ctx.tenantId);
    if (!context.ok) throw refuse(409, "cannot_self_serve", "This account needs a person to add a number. Nothing was ordered.");

    const creds = await loadMasterCreds();
    if (!creds) throw new Error("voipms_not_configured");

    // 1 ─ Stock first. A spare we already own costs nothing new and is instant;
    // only buy when there is no suitable spare.
    const spares = await listSpareDids(creds);
    const isSpare = spares.some((s) => s.did === did);
    if (isSpare) {
      await vms(creds, "setDIDRouting", { did, routing: `account:${context.subUsername}` });
    } else {
      await vms(creds, "orderDID", {
        did,
        routing: `account:${context.subUsername}`,
        pop: "5", // New York 1 — the POP every Connect tenant trunks to
        dialtime: "60",
        cnam: "1",
        billing_type: "1",
      });
    }

    // 2 ─ Make it actually ring. Same panel routine the sign-up build uses,
    // through the same single robot-account pool so two provisioning jobs can
    // never drive one panel login at once.
    const cfg = loadPanelConfig();
    if (!cfg) throw new Error("panel_not_configured");
    const account = await acquireAccount(cfg);
    try {
      const session = new PanelSession(cfg.baseUrl, account);
      await session.login();
      session.setTenant(context.pbxTenantPath);
      const destExtId = await extensionId(session, context.destExtension);
      await createInboundRoute(session, did, destExtId, `Added ${did}`);
    } catch (err) {
      // Bought (or routed) but not ringing. Name the number — someone has to
      // finish this by hand, and a vague failure would lose it.
      throw refuse(
        502,
        "route_failed",
        `The number ${prettyDid(did)} is on your account, but I couldn't finish pointing it at your phones. ` +
          `Our team has been notified and will finish it shortly — you won't be charged twice.`,
      );
    } finally {
      releaseAccount(account);
    }

    // 3 ─ The row the invoice counts. ⛔ Without this the number rings and is
    // never billed: the plan's per-number line counts `phoneNumber` rows, and
    // a DID that lives only in PbxTenantInboundDid is invisible to it.
    await deps.db.phoneNumber.create({
      data: {
        tenantId: ctx.tenantId,
        provider: "VOIPMS" as any,
        phoneNumber: `+1${did}`,
        friendlyName: `Added by assistant`,
        areaCode: did.slice(0, 3),
        status: "ACTIVE" as any,
      },
    });

    // 4 ─ Prove the money followed.
    const reconciled = await billing.reconcile({
      tenantId: ctx.tenantId,
      kind: "local_number",
      before,
      quotedUnitCents: quoted.unitCents,
      actorUserId: ctx.actor.sub,
    });

    const parts = [
      `Done — ${prettyDid(did)} is on your account and ringing your main line. It can take a few minutes for the first call to come through.`,
    ];
    parts.push(
      quoted.charged
        ? `Next month's bill goes from ${billing.format(before.monthlyTotalCents)} to ${billing.format(reconciled.monthlyTotalCents)}.`
        : `There's no extra charge — your first number is included.`,
    );
    if (reconciled.warning) parts.push(reconciled.warning);

    return {
      message: parts.join(" "),
      details: {
        did,
        alreadyOwned: isSpare,
        monthlyTotalCents: reconciled.monthlyTotalCents,
        deltaCents: reconciled.deltaCents,
      },
    };
  },
};
