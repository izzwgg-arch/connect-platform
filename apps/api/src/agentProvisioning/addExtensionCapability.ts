/**
 * "I want to add an extension" — end to end: a line on the phone system, a
 * person attached to it, a welcome email, and next month's bill following.
 *
 * ⛔ This capability does NOT reimplement provisioning. It replays the two
 * routes an admin would click in the portal — `POST /pbx/extensions` and
 * `POST /admin/users` — signed as the admin who actually confirmed. So the PBX
 * work, the SIP device, the invite token, the welcome email with the APK link,
 * and the audit rows are all exactly what the portal produces, and a fix to
 * those paths reaches this one for free.
 */
import {
  refuse,
  type ConfirmCapability,
  type ConfirmDeps,
} from "../agentConfirmations";
import { defaultBillingDeps } from "./billingReconcile";

import {
  ADD_EXTENSION_CAPABILITY_ID,
  addExtensionHashInput,
  isBillableExtensionNumber,
} from "@connect/shared";

export { ADD_EXTENSION_CAPABILITY_ID };

export type AddExtensionParams = {
  extensionNumber: string;
  firstName: string;
  lastName: string;
  email: string;
};

export const addExtensionCapability: ConfirmCapability<AddExtensionParams> = {
  id: ADD_EXTENSION_CAPABILITY_ID,
  // Reaches the PBX and queues an email — cannot be rolled back.
  transactional: false,

  parseParams(raw) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const extensionNumber = String(p.extensionNumber ?? "").trim();
    const firstName = String(p.firstName ?? "").trim();
    const lastName = String(p.lastName ?? "").trim();
    const email = String(p.email ?? "").trim().toLowerCase();
    if (!extensionNumber || !firstName || !lastName || !email) return null;
    if (!isBillableExtensionNumber(extensionNumber)) return null;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
    return { extensionNumber, firstName, lastName, email };
  },

  hashInput: addExtensionHashInput,

  async authorize(deps, ctx) {
    const { extensionNumber, email } = ctx.params;

    // Still free? The draft is minutes old and someone else may have taken it.
    const clash = await deps.db.extension.findFirst({
      where: { tenantId: ctx.tenantId, extNumber: extensionNumber },
      select: { id: true },
    });
    if (clash) {
      return {
        status: 409,
        error: "extension_taken",
        message: `Extension ${extensionNumber} is already in use. Ask in the chat for a different number.`,
      };
    }

    // Emails are unique across the whole platform, so this must be checked
    // globally — not within the tenant.
    const existingUser = await deps.db.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser) {
      return {
        status: 409,
        error: "email_taken",
        message: `${email} already has an account. Ask in the chat to use a different email address.`,
      };
    }

    const link = await deps.db.tenantPbxLink.findFirst({
      where: { tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!link) {
      return {
        status: 409,
        error: "pbx_not_linked",
        message: "This account isn't connected to the phone system yet, so a new extension can't be set up from here.",
      };
    }
    return null;
  },

  async describe(deps, ctx) {
    const { extensionNumber, firstName, lastName, email } = ctx.params;
    const billing = deps.billing ?? defaultBillingDeps;
    const snapshot = await billing.snapshot(ctx.tenantId);
    const price = billing.priceOf(snapshot, "extension");
    return {
      summary: `Add extension ${extensionNumber} for ${firstName} ${lastName} (${email}). They'll get an email to set up their phone.`,
      priceLine: price.charged
        ? `${billing.format(price.unitCents)} a month, added to your next bill.`
        : "No extra charge.",
    };
  },

  async execute(deps, ctx) {
    const { extensionNumber, firstName, lastName, email } = ctx.params;
    const inject = deps.injectAsService;
    if (!inject) throw new Error("provisioning_unavailable");

    const billing = deps.billing ?? defaultBillingDeps;
    const before = await billing.snapshot(ctx.tenantId);
    const quoted = billing.priceOf(before, "extension");
    const displayName = `${firstName} ${lastName}`.trim();

    // 1 ─ The line itself, on the PBX and in Connect.
    const created = await inject("POST", "/pbx/extensions", ctx.actor.sub, {
      extensionNumber,
      displayName,
      enableWebrtc: true,
      enableMobile: true,
    });
    // 202 = the PBX was unreachable and the work is queued for retry. The
    // Connect row exists either way, so the person and the billing still get
    // set up; we just tell the truth about the phone side.
    const pbxQueued = created.statusCode === 202;
    if (created.statusCode !== 200 && !pbxQueued) {
      throw refuse(
        502,
        "extension_create_failed",
        "The phone system wouldn't create that extension just now. Nothing was charged — please try again in a few minutes.",
      );
    }
    const extensionId: string | null =
      created.body?.extension?.id ?? created.body?.extensionId ?? null;
    if (!extensionId) throw new Error("extension_id_missing_from_create_response");

    // ⛔ `POST /pbx/extensions` stamps ownerUserId with whoever created it, and
    // `POST /admin/users` refuses an extension that already has an owner
    // (409 extension_already_assigned). Hand it back before attaching the real
    // person — otherwise the line would sit registered to the admin who
    // confirmed, which is also exactly the state that makes PBX sync skip it
    // forever.
    await deps.db.extension.update({ where: { id: extensionId }, data: { ownerUserId: null } });

    // 2 ─ The person, their invite, and the welcome email.
    const user = await inject("POST", "/admin/users", ctx.actor.sub, {
      extensionId,
      role: "END_USER",
      email,
      firstName,
      lastName,
      sendInvite: true,
    });
    const welcomeSent = user.statusCode === 200 || user.statusCode === 201;
    if (!welcomeSent) {
      // The line exists and will be billed; the person did not get set up.
      // Say so plainly rather than reporting a clean success.
      const reason = String(user.body?.error || `http_${user.statusCode}`);
      throw refuse(
        502,
        "user_create_failed",
        `Extension ${extensionNumber} was created, but the welcome email couldn't be set up (${reason}). ` +
          `Someone needs to finish adding ${email} under Users.`,
      );
    }

    // 3 ─ Make sure the money actually followed.
    const reconciled = await billing.reconcile({
      tenantId: ctx.tenantId,
      kind: "extension",
      before,
      quotedUnitCents: quoted.unitCents,
      actorUserId: ctx.actor.sub,
    });

    const parts = [
      `Done — extension ${extensionNumber} is set up for ${displayName}, and a welcome email is on its way to ${email} with everything they need to get their phone working.`,
    ];
    if (pbxQueued) {
      parts.push("The phone system was busy, so the line will finish setting itself up over the next few minutes.");
    }
    parts.push(`Next month's bill goes from ${billing.format(before.monthlyTotalCents)} to ${billing.format(reconciled.monthlyTotalCents)}.`);
    if (reconciled.warning) parts.push(reconciled.warning);

    return {
      message: parts.join(" "),
      details: {
        extensionId,
        extensionNumber,
        email,
        pbxQueued,
        monthlyTotalCents: reconciled.monthlyTotalCents,
        deltaCents: reconciled.deltaCents,
        repairedManualOverride: reconciled.repairedManualOverride,
      },
    };
  },
};
