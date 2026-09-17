/**
 * The OFFICE WIZARD's own entry into Yealink RPS (Izzy, 2026-09-17, verbatim:
 * "integrated with both databases").
 *
 * ⛔⛔ THE PROBLEM THIS CLOSES, proven live. A Yealink set up through the OFFICE
 * WIZARD (LAN scan → tick → assign extension → serial on file → reset-first → PnP
 * hand-off from the office PC) never registered into Yealink's RPS cloud — only the
 * separate "Prepare a Yealink for delivery" managed panel (`ManagedPhoneService.
 * provision`) did. So zero-touch after a factory reset depended entirely on LAN
 * multicast PnP reaching the office PC, exactly like a Grandstream before GDMS
 * redirection existed for it.
 *
 * ⛔⛔ ONE RPS WRITER, TWO FRONT DOORS. This module never talks to Yealink's cloud
 * itself. It calls `ManagedPhoneService.claimForOfficeWizard` — the SAME service the
 * managed panel uses — pointed at the TENANT'S EXISTING `/phoneprov/<16 hex>/`
 * folder rather than this service's own `/api/phone-provisioning/<mac>/` route, so
 * the SIP credentials a factory-booting phone downloads are the ones the office
 * wizard's own PBX record already produced. Never a second, divergent source of
 * truth for the same phone's SIP account.
 *
 * ⛔ Best-effort, always, and this NEVER throws into its caller. `recordLabel` and
 * `ensureRecord` already have their own, more important jobs — saving a label,
 * writing the PBX record — and neither may fail because Yealink's cloud is slow,
 * unreachable, or the phone belongs to somebody else there.
 */
import { db as defaultDb } from "@connect/db";
import { DeviceError } from "./yealinkRps";
import { managedModel } from "./yealinkConfig";
import { ManagedPhoneService } from "./managedPhoneService";

// ⛔⛔ NEVER import from `./deskPhoneRoutes` here, even though that file has its own
// `defaultProvisioningUrlFor`/`requesterIpOf`. `deskPhoneRoutes.ts` imports THIS
// file to call `ensureYealinkRedirect` — importing back from it would be a runtime
// circular value-import (deskPhoneRoutes → yealinkRedirectClaim → deskPhoneRoutes).
// Both are REQUIRED deps instead; every caller already has its own copy in scope
// (deskPhoneRoutes.ts's own functions, or DeskPhoneDeps.provisioningUrlFor on the
// device-cloud routes' ctx).

/** The bit of a DeskPhoneSetupPhone row this hook needs — never the whole Prisma shape. */
export type YealinkRedirectPhone = {
  id: string;
  macAddress: string;
  vendor?: string | null;
  model?: string | null;
  extensionId?: string | null;
  serialNumber?: string | null;
  ipAddress?: string | null;
  skippedAt?: Date | null;
  state?: string | null;
  customerNote?: string | null;
  vendorCloudState?: string | null;
  vendorCloudCheckedAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type AuditFn = (p: {
  tenantId: string; action: string; entityType: string; entityId: string;
  actorUserId?: string; metadata?: Record<string, unknown> | null;
}) => Promise<void>;

/** The one method this module calls. Structural, never the concrete class, so a
 * test's spy object (or `DeskPhoneDeps.managedPhoneService`, which is loosely typed
 * for the same reason) satisfies it without needing `ManagedPhoneService`'s private
 * members. A real `ManagedPhoneService` instance satisfies this too. */
export type OfficeWizardClaimer = {
  claimForOfficeWizard: (
    actor: { tenantId: string; sub: string },
    input: {
      mac: string; serialNumber: string; model: string; extensionId: string; displayName?: string;
      redirectUrl: string; presence?: { discoveredIp: string | null; requesterIp: string | null };
    },
    requestId: string,
  ) => Promise<{ id: string; rpsState: string; lastError: string | null; conflict: boolean }>;
};

export type YealinkRedirectDeps = {
  /** The tenant's `/phoneprov/<16 hex>/` folder — callers pass their own resolved
   * function (`deps.provisioningUrlFor ?? defaultProvisioningUrlFor` in
   * deskPhoneRoutes.ts) so this module never imports that file back. */
  provisioningUrlFor: (tenantId: string) => Promise<string | null>;
  /** The last X-Forwarded-For entry — `requesterIpOf` in deskPhoneRoutes.ts. */
  requesterIp: (req: any) => string | null;
  audit: AuditFn;
  db?: any;
  managedPhoneService?: OfficeWizardClaimer;
  now?: () => Date;
  /** Bounds the whole best-effort RPS round trip. */
  timeoutMs?: number;
};

export type YealinkRedirectOutcome =
  | { skipped: string }
  | { ok: true; state: "managed" | "conflict" | "unavailable" };

/** Never re-ask the cloud more often than this for a phone whose inputs did not change. */
const COOLDOWN_MS = 60_000;

const CONFLICT_NOTE =
  "Yealink's cloud still lists this phone under its previous provider, so it can't be set up from anywhere yet. "
  + "Loopcom will ask Yealink to release it. Restarting the phone on your office network still sets it up.";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeviceError("office_wizard_rps_timeout", 503)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Best-effort: claim a Yealink into Loopcom's RPS account at the moments the office
 * wizard already writes the PBX record. Returns `{skipped}` when a precondition (or
 * the cooldown) means nothing was even attempted, else the outcome that was recorded.
 * ⛔ NEVER throws — every failure path returns a value instead.
 */
export async function ensureYealinkRedirect(
  phone: YealinkRedirectPhone,
  user: { tenantId: string; sub: string },
  req: any,
  deps: YealinkRedirectDeps,
): Promise<YealinkRedirectOutcome> {
  try {
    return await run(phone, user, req, deps);
  } catch {
    // ⛔ Defense in depth: `run()` is written to handle every failure itself, but a
    // caller of this hook must never be the one to discover a bug in it.
    return { skipped: "internal_error" };
  }
}

async function run(
  phone: YealinkRedirectPhone,
  user: { tenantId: string; sub: string },
  req: any,
  deps: YealinkRedirectDeps,
): Promise<YealinkRedirectOutcome> {
  const db = deps.db ?? defaultDb;
  const service = deps.managedPhoneService ?? new ManagedPhoneService();
  const provisioningUrlFor = deps.provisioningUrlFor;
  const getRequesterIp = deps.requesterIp;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 12_000;

  // ⛔ Case-insensitive: `vendor` is stored exactly as the phone's own banner or a
  // person's typed answer spelled it ("Yealink", "YEALINK", …), never normalised at
  // rest (see /discovered in deskPhoneRoutes.ts). A case-sensitive compare here would
  // silently skip every real phone whose banner capitalises its own name.
  if (String(phone.vendor || "").toLowerCase() !== "yealink") return { skipped: "not_yealink" };
  if (phone.skippedAt) return { skipped: "phone_skipped" };
  if (!phone.extensionId) return { skipped: "no_extension" };
  const serialNumber = String(phone.serialNumber || "").trim();
  if (!serialNumber) return { skipped: "no_serial" };
  const model = String(phone.model || "").trim();
  if (!model) return { skipped: "no_model" };
  try { managedModel(model); } catch { return { skipped: "model_not_managed" }; }

  // ⛔ Cooldown: do not re-ask Yealink's cloud for this phone more often than every
  // 60s. `updatedAt` moving past the last check is read as "something about this
  // phone changed" (a new serial, a new extension, a fresh identification) and
  // bypasses the throttle; a `managed` state with nothing changed is never
  // re-claimed at all, cooldown or not.
  const checkedAtMs = phone.vendorCloudCheckedAt ? new Date(phone.vendorCloudCheckedAt).getTime() : 0;
  const updatedAtMs = phone.updatedAt ? new Date(phone.updatedAt).getTime() : 0;
  const changedSinceLastCheck = !checkedAtMs || (updatedAtMs > 0 && updatedAtMs > checkedAtMs);
  if (!changedSinceLastCheck) {
    if (phone.vendorCloudState === "managed") return { skipped: "already_managed" };
    if (Date.now() - checkedAtMs < COOLDOWN_MS) return { skipped: "cooldown" };
  }

  let redirectUrl: string | null;
  try { redirectUrl = await provisioningUrlFor(user.tenantId); } catch { redirectUrl = null; }
  if (!redirectUrl) return { skipped: "no_provisioning_folder" };

  const presence = { discoveredIp: phone.ipAddress ?? null, requesterIp: getRequesterIp(req) };

  let result: { id: string; rpsState: string; lastError: string | null; conflict: boolean };
  try {
    result = await withTimeout(
      service.claimForOfficeWizard(
        { tenantId: user.tenantId, sub: user.sub },
        { mac: phone.macAddress, serialNumber, model, extensionId: phone.extensionId, redirectUrl, presence },
        `office-wizard-${phone.id}`,
      ),
      timeoutMs,
    );
  } catch (e) {
    const code = e instanceof DeviceError ? e.code : "office_wizard_rps_failed";
    await writeOutcome(db, phone, "unavailable", now());
    await auditSafe(deps, user, phone, "DESK_PHONE_VENDOR_REDIRECT_FAILED", { mac: phone.macAddress, serialTail: serialTailOf(serialNumber), code });
    return { ok: true, state: "unavailable" };
  }

  const state: "managed" | "conflict" | "unavailable" =
    result.rpsState === "assigned" ? "managed" : result.conflict ? "conflict" : "unavailable";

  await writeOutcome(db, phone, state, now());
  await auditSafe(
    deps, user, phone,
    state === "managed" ? "DESK_PHONE_VENDOR_REDIRECT_CLAIMED"
      : state === "conflict" ? "DESK_PHONE_VENDOR_REDIRECT_CONFLICT" : "DESK_PHONE_VENDOR_REDIRECT_FAILED",
    { mac: phone.macAddress, serialTail: serialTailOf(serialNumber), rpsState: result.rpsState, code: result.lastError ?? null },
  );
  return { ok: true, state };
}

function serialTailOf(serial: string): string {
  return serial ? `…${serial.slice(-4)}` : "";
}

/** Audits are a nicety here — the claim itself already happened either way. */
async function auditSafe(
  deps: YealinkRedirectDeps, user: { tenantId: string; sub: string }, phone: YealinkRedirectPhone,
  action: string, metadata: Record<string, unknown>,
) {
  try {
    await deps.audit({ tenantId: user.tenantId, action, entityType: "DeskPhoneSetupPhone", entityId: phone.id, actorUserId: user.sub, metadata });
  } catch { /* the claim already happened; a lost audit line must not undo it */ }
}

async function writeOutcome(
  db: any, phone: YealinkRedirectPhone, state: "managed" | "conflict" | "unavailable", at: Date,
) {
  const vendorCloudState = state; // "managed" | "conflict" | "unavailable" are all valid DeskPhoneSetupPhone.vendorCloudState values.
  const data: Record<string, unknown> = { vendorCloudState, vendorCloudCheckedAt: at };
  // ⛔⛔ RE-READ THE ROW NOW, never trust the snapshot the caller passed in. Found live
  // 2026-09-17: `/retry` fired this claim fire-and-forget on an ASSIGNED row, the ladder
  // halted the phone ("hold OK ~10 s") a few hundred ms later, and this write — a full RPS
  // round trip later — landed with the STALE "ASSIGNED" snapshot and replaced the one
  // instruction the person needed with the cloud-conflict sentence. The halt's note is the
  // more specific one and always wins; the cloud word rides `vendorCloudState` regardless.
  let current: { state?: string | null; haltedReason?: string | null; customerNote?: string | null } = phone;
  try {
    const fresh = await db.deskPhoneSetupPhone.findUnique?.({
      where: { id: phone.id }, select: { state: true, haltedReason: true, customerNote: true },
    });
    if (fresh) current = fresh;
  } catch { /* the snapshot is the best we have */ }
  const halted = current.state === "NEEDS_ATTENTION" || Boolean(current.haltedReason);
  const noteIsOursOrEmpty = !current.customerNote || String(current.customerNote) === CONFLICT_NOTE;
  if (state === "conflict") {
    // ⛔ Only onto an EMPTY row or our own earlier sentence, and never onto a halted phone.
    if (!halted && noteIsOursOrEmpty) {
      data.customerNote = CONFLICT_NOTE;
      data.technicalNote = `yealink_rps_conflict mac=${phone.macAddress} serial=${serialTailOf(String(phone.serialNumber || ""))} `
        + `— release via https://ticket.yealink.com/page/mac-removal.html (MAC + serial + photo)`;
    }
  } else if (state === "managed" && String(current.customerNote || "") === CONFLICT_NOTE) {
    // ⛔ Clear a previous conflict note of OUR OWN once the cloud confirms we hold it —
    // matched on the exact sentence we wrote, never a note the halt ladder set.
    data.customerNote = null;
    data.technicalNote = null;
  }
  try { await db.deskPhoneSetupPhone.update({ where: { id: phone.id }, data }); } catch { /* best-effort */ }
}
