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
  const [snapshot, extensions, users, smsNumber, settings] = await Promise.all([
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
  ]);

  const extensionsInUse = extensions.map((e: any) => String(e.extNumber || "").trim()).filter(Boolean).sort();
  return {
    monthlyTotal: formatCents(snapshot.monthlyTotalCents),
    extensionPrice: formatCents(priceOfAddition(snapshot, "extension").unitCents),
    smsPrice: formatCents(priceOfAddition(snapshot, "sms").unitCents),
    additionalNumberPrice: formatCents(priceOfAddition(snapshot, "local_number").unitCents),
    firstNumberFree: snapshot.unitPrices.firstPhoneNumberFree,
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
  };
}

export function registerAccountSetupInfoRoute(app: FastifyInstance) {
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
