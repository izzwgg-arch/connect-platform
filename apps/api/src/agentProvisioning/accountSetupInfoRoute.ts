/**
 * The internal door the assistant reads prices and account state from.
 *
 * ⛔ THE POINT: the agent must never invent or hard-code a price. The figure it
 * says out loud in the chat has to be the figure the invoice engine will
 * actually bill — which means it has to come from the engine. The sign-up
 * constants ($30 an extension, $10 texting) are what a NEW customer is quoted;
 * an existing account may be on a different plan or a negotiated rate, and
 * quoting a number their invoice then contradicts is the one billing mistake
 * customers never forget.
 *
 * Server-to-server, shared-secret, same shape as the other `/internal/agent/*`
 * doors. It is READ-ONLY.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { snapshotBilling, priceOfAddition, formatCents } from "./billingReconcile";
import { searchAvailableNumbers } from "./addPhoneNumberCapability";
import { loadMasterCreds } from "../onboarding/voipMsProvisioning";

export type AccountSetupInfo = {
  monthlyTotal: string;
  extensionPrice: string;
  smsPrice: string;
  additionalNumberPrice: string;
  firstNumberFree: boolean;
  smsAlreadyOn: boolean;
  extensionsInUse: string[];
  suggestedExtensionNumber: string | null;
  people: Array<{ id: string; name: string; email: string }>;
  hasTextableNumber: boolean;
  /** The company's own phone numbers, main line first ("845-723-1213"). */
  companyNumbers: string[];
};

/**
 * The lowest free three-digit extension at or above 101.
 *
 * ⛔ Three digits is a BILLING rule, not just a dialplan one — usage counts
 * billable extensions with /^\d{3}$/, so anything else is provisioned and never
 * charged for. Suggesting from this range is what keeps the agent out of that
 * hole by default.
 */
export function suggestFreeExtensionNumber(taken: string[]): string | null {
  const used = new Set(taken.map((t) => String(t).trim()));
  for (let n = 101; n <= 999; n++) {
    const candidate = String(n);
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

export async function loadAccountSetupInfo(tenantId: string): Promise<AccountSetupInfo> {
  const [snapshot, extensions, users, smsNumber, settings, inboundDids] = await Promise.all([
    snapshotBilling(tenantId),
    db.extension.findMany({ where: { tenantId }, select: { extNumber: true } }),
    db.user.findMany({
      where: { tenantId, status: { not: "DISABLED" } },
      select: { id: true, email: true, firstName: true, lastName: true, displayName: true },
      take: 200,
    }),
    (db as any).tenantSmsNumber.findFirst({ where: { tenantId, active: true }, select: { id: true } }),
    db.tenantBillingSettings.findUnique({
      where: { tenantId },
      select: { smsBillingEnabled: true },
    }),
    // The company's own phone numbers. ⛔ These live in PbxTenantInboundDid,
    // synced from the PBX — NOT the Connect phoneNumber table, which onboarding
    // tenants have zero rows in. Without this the assistant answered "I don't
    // have your company's phone number" to every customer who asked — a
    // question the trainer marked red twice, because the number was sitting in
    // the database the whole time.
    (db as any).pbxTenantInboundDid.findMany({
      where: { connectTenantId: tenantId, active: true },
      select: { e164: true },
      orderBy: { createdAt: "asc" },
      take: 20,
    }).catch(() => []),
  ]);

  const extensionsInUse = extensions.map((e: any) => String(e.extNumber || "").trim()).filter(Boolean).sort();
  // ⛔ "Your first number is included" must be judged against the numbers the
  // company ACTUALLY has, not the `phoneNumber` rows. Most accounts the sign-up
  // flow built have none of those rows — their DIDs live in PbxTenantInboundDid
  // — so the pricing engine reports first-number-free to companies that already
  // have two, and the assistant would quote $0.00 for a number that is not free.
  // Reporting reality here keeps the assistant from saying it; adding a number
  // on such an account is refused outright in addPhoneNumberCapability.
  const realNumberCount = (inboundDids as Array<unknown>).length;
  const nextNumberIsFree = snapshot.unitPrices.firstPhoneNumberFree && realNumberCount === 0;
  return {
    monthlyTotal: formatCents(snapshot.monthlyTotalCents),
    extensionPrice: formatCents(priceOfAddition(snapshot, "extension").unitCents),
    smsPrice: formatCents(priceOfAddition(snapshot, "sms").unitCents),
    additionalNumberPrice: formatCents(
      nextNumberIsFree ? 0 : snapshot.unitPrices.additionalPhoneNumberCents,
    ),
    firstNumberFree: nextNumberIsFree,
    smsAlreadyOn: !!settings?.smsBillingEnabled,
    extensionsInUse,
    suggestedExtensionNumber: suggestFreeExtensionNumber(extensionsInUse),
    people: users.map((u: any) => ({
      id: u.id,
      name:
        String(u.displayName || "").trim() ||
        [u.firstName, u.lastName].filter(Boolean).join(" ") ||
        String(u.email || "").split("@")[0],
      email: u.email,
    })),
    hasTextableNumber: !!smsNumber,
    // "845-723-1213" — the way a person reads a number out loud. The first one
    // listed is the oldest DID on the account, which is the main line for
    // every onboarded tenant (the first number is the one signup bought).
    companyNumbers: (inboundDids as Array<{ e164: string }>).map((d) => {
      const digits = String(d.e164 || "").replace(/\D/g, "");
      const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
      return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : String(d.e164 || "");
    }).filter(Boolean),
  };
}

export function registerAccountSetupInfoRoute(app: FastifyInstance) {
  /**
   * Numbers this account could add, stock we already own first. Read-only —
   * it looks, it never buys. The purchase happens only after the customer's
   * password, in `addPhoneNumberCapability`.
   */
  app.post("/internal/agent/search-phone-numbers", async (req, reply) => {
    const secret = (process.env.AGENT_INTERNAL_SECRET || "").trim();
    if (!secret || req.headers["x-agent-internal-secret"] !== secret) {
      return reply.code(403).send({ ok: false, error: "forbidden" });
    }
    const body = z
      .object({ tenantId: z.string().min(1), areaCode: z.string().max(3).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "bad_request" });
    try {
      const creds = await loadMasterCreds();
      if (!creds) return { ok: true, numbers: [] };
      const numbers = await searchAvailableNumbers(creds, body.data.areaCode);
      return { ok: true, numbers: numbers.map(({ did, pretty, location }) => ({ did, pretty, location })) };
    } catch (err) {
      req.log?.error({ err }, "search_phone_numbers_failed");
      return reply.code(500).send({ ok: false, error: "lookup_failed" });
    }
  });

  app.post("/internal/agent/account-setup-info", async (req, reply) => {
    const secret = (process.env.AGENT_INTERNAL_SECRET || "").trim();
    // Fail closed: an unset secret must not become an open door.
    if (!secret || req.headers["x-agent-internal-secret"] !== secret) {
      return reply.code(403).send({ ok: false, error: "forbidden" });
    }
    const body = z.object({ tenantId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "bad_request" });
    try {
      return { ok: true, info: await loadAccountSetupInfo(body.data.tenantId) };
    } catch (err) {
      req.log?.error({ err, tenantId: body.data.tenantId }, "account_setup_info_failed");
      return reply.code(500).send({ ok: false, error: "lookup_failed" });
    }
  });
}
