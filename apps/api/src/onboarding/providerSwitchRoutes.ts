/**
 * The wizard-carrier switch (Izzy, 2026-09-15: "I should have a switch in
 * Loopcom where I can select which provider should be in the wizard").
 *
 * Two tiny owner-only routes over `resolveOnboardingNumberProvider`'s stored
 * override (signalWireNumbers.ts — the ONE place every new-signup surface
 * asks). The card that drives them lives on /apps/telnyx beside the other
 * carrier panels, but the module lives HERE because the switch is an
 * ONBOARDING control spanning all carriers — and because the Telnyx bench
 * module carries a source-guarded promise never to touch onboarding.
 *
 * ⛔ "telnyx" is refused, with the reason, until the wizard actually has a
 * Telnyx search/provisioning path — a stored value the wizard cannot honour
 * is a lying toggle (the /admin/roles honesty rule, applied to carriers).
 *
 * ⛔ Flipping the switch changes which carrier NEW sign-ups search and buy
 * from. Existing customers and stamped drafts are untouched (the per-
 * submission `answers.phone.provider` pin, see the SignalWire onboarding
 * handoff).
 */

import { createHash } from "node:crypto";
import {
  onboardingNumberProvider,
  resolveOnboardingNumberProvider,
  storeOnboardingNumberProvider,
  clearOnboardingProviderCache,
  type OnboardingNumberProviderName,
} from "./signalWireNumbers";

export interface ProviderSwitchRouteDeps {
  app: any;
  db: any;
  /** Resolves the caller and enforces platform-owner access, or replies. */
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
}

async function recordSwitchEvent(db: any, event: string, payload: Record<string, unknown>, actor: string): Promise<void> {
  const body = { actor, event: `carrier.${event}`, ts: new Date().toISOString(), payload };
  try {
    await db.agentAuditLog.create({
      data: {
        actor: body.actor,
        event: body.event,
        payload: body.payload,
        hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
    });
  } catch {
    // The record must never fail the action it records.
  }
}

export function registerProviderSwitchRoutes(deps: ProviderSwitchRouteDeps): void {
  const { app, db, requireOwner } = deps;

  app.get("/admin/carrier-switch", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    clearOnboardingProviderCache();
    const effective = await resolveOnboardingNumberProvider(db);
    const env = onboardingNumberProvider();
    let stored: string | null = null;
    try {
      const sec = await import("@connect/security");
      if (sec.hasCredentialsMasterKey()) {
        const row = await db.agentSecret.findUnique({ where: { key: "onboarding_number_provider_override" } });
        if (row?.valueEnc) stored = String(sec.decryptJson<{ provider?: string }>(row.valueEnc)?.provider ?? "") || null;
      }
    } catch {
      stored = null;
    }
    return reply.send({
      effective,
      env,
      stored,
      options: [
        { value: "voipms", label: "VoIP.ms", selectable: true },
        { value: "signalwire", label: "SignalWire", selectable: true },
        {
          value: "telnyx",
          label: "Telnyx",
          selectable: false,
          reason: "The wizard has no Telnyx search/provisioning path yet — the switch will offer it the day that path exists.",
        },
      ],
    });
  });

  app.put("/admin/carrier-switch", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const raw = String(req.body?.provider ?? "").trim().toLowerCase();
    if (raw === "telnyx") {
      return reply.code(409).send({
        error: "not_wired",
        message: "Telnyx isn't wired into the sign-up wizard yet — numbers can't be searched or provisioned there. The switch will offer Telnyx the day that path is built.",
      });
    }
    if (raw && raw !== "voipms" && raw !== "signalwire") {
      return reply.code(400).send({ error: "invalid_provider", message: "Pick voipms or signalwire (or blank to clear the override and follow the server environment)." });
    }
    const value = (raw || null) as OnboardingNumberProviderName | null;
    try {
      await storeOnboardingNumberProvider(db, value, `user:${user.sub}`);
    } catch (err: any) {
      const missing = String(err?.message || "").includes("credentials_master_key_missing");
      return reply.code(500).send({
        error: "store_failed",
        message: missing
          ? "The settings store isn't available (CREDENTIALS_MASTER_KEY is not set on the api). Nothing was changed."
          : "Couldn't save the carrier choice. Try again.",
      });
    }
    const effective = await resolveOnboardingNumberProvider(db);
    await recordSwitchEvent(db, "wizard_provider_set", { stored: value, effective }, `user:${user.sub}`);
    return reply.send({ ok: true, stored: value, effective });
  });
}
