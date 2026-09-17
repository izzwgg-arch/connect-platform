/**
 * Wires 10DLC texting registration into the api (2026-09-16). server.ts calls
 * `wireTextingRegistration` once — every dependency is assembled here so the
 * server.ts change stays three lines.
 */
import { canonicalPortalOrigin } from "../publicOrigins";
import { resolvePublicApiBase } from "../signalwire/signalWireRoutes";
import { resolveTelnyxCredentials } from "../telnyx/telnyxCredentials";
import { checkConnection } from "../telnyx/telnyxClient";
import { verifyTelnyxSignature } from "../loopcomMobile/mobileWebhookRoutes";
import { createOneTimeChargeInvoice } from "../billing/invoiceEngine";
import * as registry from "./registryClient";
import { advanceRegistration, REGISTRATION_CHARGE_CENTS, REGISTRATION_CHARGE_DESCRIPTION, startTextingRegistrationSweep, type EngineDeps } from "./engine";
import { startTextingSwitcher } from "./switcher";
import { configureOwnedNumber, findOwnedNumber } from "../telnyx/telnyxOnboardingClient";
import { recordTelnyxEvent } from "../telnyx/telnyxRoutes";
import { registerTextingRegistrationRoutes } from "./routes";

export function wireTextingRegistration(input: {
  app: any;
  db: any;
  requireSuperAdmin: (req: any, reply: any) => Promise<any>;
  userHasActionPermission: (user: any, key: string) => Promise<boolean>;
}): void {
  const { app, db } = input;
  const engine: EngineDeps = {
    db,
    resolveCreds: () => resolveTelnyxCredentials(db).catch(() => null),
    registry,
    now: () => new Date(),
    portalOrigin: canonicalPortalOrigin,
    publicApiBase: () => resolvePublicApiBase(),
    /**
     * ⛔ A SEPARATE one-time invoice, created OPEN with its default dates
     * (period start = end = the moment of filing) and NOT charged, emailed or
     * texted. Traced 2026-09-16: autopay only selects an invoice whose period
     * contains the payment instant, a paid "one_time_charge" never counts as
     * covering a period unless its text says "monthly service", and the
     * service cutoff only counts FAILED/OVERDUE invoices. ⛔ Never pass service
     * dates here and never put "monthly service" in the description.
     */
    addRegistrationCharge: async (tenantId, registrationId, actorUserId) => {
      const invoice = await createOneTimeChargeInvoice({
        tenantId,
        description: REGISTRATION_CHARGE_DESCRIPTION,
        amountCents: REGISTRATION_CHARGE_CENTS,
        operatorNote: `10DLC registration filed (${registrationId})`,
        adminUserId: actorUserId,
      });
      return String(invoice?.invoiceNumber || invoice?.id || "invoice");
    },
    queueEmail: async (m) => {
      if (m.type === "ADMIN_ALERT") throw new Error("customer_email_must_not_be_admin_alert");
      await db.emailJob.create({ data: { tenantId: m.tenantId, type: m.type, toEmail: m.to, subject: m.subject, htmlBody: m.html, textBody: m.text } });
    },
    log: app.log,
  };

  registerTextingRegistrationRoutes({
    app,
    engine: () => engine,
    requireStaff: input.requireSuperAdmin,
    hasKey: input.userHasActionPermission,
    telnyxHealth: async () => {
      const creds = await resolveTelnyxCredentials(db).catch(() => null);
      if (!creds) return { connected: false, publicKeySet: false, balance: null };
      const probe = await checkConnection(creds).catch(() => null);
      return { connected: !!probe?.ok, publicKeySet: !!creds.publicKey, balance: probe?.balance ?? null };
    },
    verifySignature: verifyTelnyxSignature,
    resolvePublicKey: async () => (await resolveTelnyxCredentials(db).catch(() => null))?.publicKey ?? null,
  });

  startTextingRegistrationSweep(engine);

  // The switcher: a customer's number that lands on the Telnyx account moves its
  // texting over by itself (see switcher.ts for the traced blast radius).
  startTextingSwitcher({
    db,
    now: () => new Date(),
    resolveCreds: () => resolveTelnyxCredentials(db).catch(() => null),
    findOwnedNumber,
    resolveMessagingProfileId: async (creds) => {
      // Lazy: the sign-up provisioning module is heavy and only needed on a landing.
      const p = await import("../onboarding/telnyxProvisioning");
      const { listMessagingProfilesRaw, createMessagingProfileWithWebhook } = await import("../telnyx/telnyxOnboardingClient");
      return p.resolveSignupMessagingProfileId(creds, { listMessagingProfiles: listMessagingProfilesRaw, createMessagingProfile: createMessagingProfileWithWebhook });
    },
    setMessagingProfile: (creds, numberId, profileId) => configureOwnedNumber(creds, numberId, { messagingProfileId: profileId }),
    advanceRegistration: (id) => advanceRegistration(engine, id),
    audit: (event, payload) => recordTelnyxEvent(db, event, payload, "system"),
    log: app.log,
  });
}
