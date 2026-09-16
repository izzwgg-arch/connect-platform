/**
 * The texting SWITCHER (2026-09-16, Izzy: "build the switcher … it will
 * automatically detect when it's switched to Telnyx and kick in").
 *
 * An existing customer's number texts through VoIP.ms (`TenantSmsNumber.provider
 * = VOIPMS`). When that number is ported to Loopcom's Telnyx account, VoIP.ms can
 * no longer send from it — so the moment the number shows up ACTIVE on the
 * Telnyx account, this sweep:
 *   1. puts it on Loopcom's Telnyx texting profile if it has none;
 *   2. flips the row VOIPMS → TELNYX (one conditional write, so a second sweep or
 *      a person acting at the same moment can never flip it twice);
 *   3. kicks the customer's 10DLC registration straight away, so an approved
 *      campaign attaches the number now instead of on its next hourly look
 *      (the engine's own attach code does the attaching — nothing new here).
 *
 * Detection is a READ of the Telnyx account, never a timer guess. Traced before
 * building (the blast radius, 2026-09-16):
 *   • the worker's messaging registry picks the outbound adapter from `provider`
 *     — TELNYX is a wired, live-proven adapter;
 *   • the VoIP.ms inbox poll selects `provider: "VOIPMS"` only, so a flipped row
 *     simply stops being polled at VoIP.ms (which no longer has the number);
 *   • the VoIP.ms DID sync upserts by phoneE164 and NEVER writes `provider`, so
 *     it cannot flip the row back;
 *   • inbound ingest has no provider filter — replies keep landing in the thread;
 *   • the Telnyx sign-up landing (telnyxPortWatchdog) writes TELNYX rows itself
 *     and this sweep only ever touches VOIPMS rows, so the two never overlap.
 * ⛔ Only VOIPMS rows with a tenant are ever touched; SIGNALWIRE/TELNYX rows are
 * never read for a flip. ⛔ A number that is on Telnyx but NOT active (e.g. a
 * port still in flight) is left alone. ⛔ An existing messaging profile a person
 * chose is never overwritten — it is reported instead.
 * Kill switch: TEXTING_SWITCHER_DISABLED=1. Boot line: TEXTING_SWITCHER_ARMED.
 */

export interface OwnedTelnyxNumber {
  id: string;
  phoneNumber: string;
  status: string | null;
  messagingProfileId: string | null;
}

export interface SwitcherDeps {
  db: any;
  now: () => Date;
  resolveCreds: () => Promise<any | null>;
  findOwnedNumber: (creds: any, e164: string) => Promise<OwnedTelnyxNumber | null>;
  resolveMessagingProfileId: (creds: any) => Promise<string | null>;
  setMessagingProfile: (creds: any, numberId: string, profileId: string) => Promise<void>;
  /** Re-reads the registry for one registration now (engine.advanceRegistration). */
  advanceRegistration: (registrationId: string) => Promise<unknown>;
  audit?: (event: string, payload: Record<string, unknown>) => Promise<void>;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
}

export interface SwitcherResult {
  checked: number;
  switched: string[];
  notOnTelnyx: number;
  notActive: string[];
  errors: Array<{ e164: string; error: string }>;
}

/** Registration states in which the engine attaches numbers on a kick. */
const KICKABLE = ["campaign_review", "assigning", "live"];

async function registrationEvent(db: any, registrationId: string, kind: string, message: string): Promise<void> {
  await db.textingRegistrationEvent
    .create({ data: { registrationId, kind, message: message.slice(0, 500), actorUserId: null } })
    .catch(() => {});
}

export async function sweepTextingSwitcher(deps: SwitcherDeps, opts: { batch?: number } = {}): Promise<SwitcherResult> {
  const { db } = deps;
  const result: SwitcherResult = { checked: 0, switched: [], notOnTelnyx: 0, notActive: [], errors: [] };
  const rows: any[] = await db.tenantSmsNumber.findMany({
    where: { provider: "VOIPMS", active: true, tenantId: { not: null } },
    select: { id: true, tenantId: true, phoneE164: true },
    orderBy: { phoneE164: "asc" },
    take: opts.batch ?? 500,
  });
  if (!rows.length) return result;
  const creds = await deps.resolveCreds();
  if (!creds) return result;

  let profileId: string | null | undefined;
  for (const row of rows) {
    const e164 = String(row.phoneE164 || "");
    if (!/^\+1\d{10}$/.test(e164)) continue;
    result.checked++;
    try {
      const owned = await deps.findOwnedNumber(creds, e164);
      if (!owned) {
        result.notOnTelnyx++;
        continue;
      }
      if (String(owned.status || "").toLowerCase() !== "active") {
        result.notActive.push(e164);
        continue;
      }

      const reg = await db.textingRegistration.findFirst({
        where: { tenantId: row.tenantId, status: { not: "deactivated" } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true },
      });

      // 1. Texting profile — only when the number has none.
      let profileNote = "";
      if (!owned.messagingProfileId) {
        if (profileId === undefined) profileId = await deps.resolveMessagingProfileId(creds).catch(() => null);
        if (profileId) {
          await deps.setMessagingProfile(creds, owned.id, profileId);
          profileNote = " and put on Loopcom's texting profile";
        } else {
          profileNote = " (⛔ no texting profile could be prepared — incoming texts need a person)";
        }
      }

      // 2. The flip — conditional, so it happens exactly once.
      const flip = await db.tenantSmsNumber.updateMany({
        where: { id: row.id, provider: "VOIPMS" },
        data: { provider: "TELNYX", lastSyncedAt: deps.now() },
      });
      if (!flip.count) continue;
      result.switched.push(e164);
      deps.log?.warn({ e164, tenantId: row.tenantId, registrationId: reg?.id ?? null }, "texting_switcher_switched");
      await deps.audit?.("texting_switched", { e164, tenantId: row.tenantId, registrationId: reg?.id ?? null, registrationStatus: reg?.status ?? null });

      // 3. Tell the registration, and kick it.
      if (reg) {
        const waiting = KICKABLE.includes(reg.status)
          ? reg.status === "campaign_review"
            ? " It attaches as soon as the carriers approve the registration."
            : " Attaching it to the approved registration now."
          : " ⛔ The registration is not approved yet, so texts from this number will not send until it is filed and approved.";
        await registrationEvent(db, reg.id, "number_switched", `${e164} moved to the new carrier — texting switched over automatically${profileNote}.${waiting}`);
        if (KICKABLE.includes(reg.status)) await deps.advanceRegistration(reg.id).catch(() => null);
      } else {
        deps.log?.warn({ e164, tenantId: row.tenantId }, "texting_switcher_switched_without_registration");
      }
    } catch (err: any) {
      result.errors.push({ e164, error: String(err?.message || err).slice(0, 200) });
    }
  }
  return result;
}

export const SWITCHER_INTERVAL_MS = 5 * 60_000;
export const SWITCHER_BOOT_DELAY_MS = 3 * 60_000;
export const switcherState = {
  lastRunAt: null as Date | null,
  lastResult: null as SwitcherResult | null,
  lastError: null as string | null,
  running: false,
};

export function startTextingSwitcher(deps: SwitcherDeps): { stop: () => void } | null {
  if (String(process.env.TEXTING_SWITCHER_DISABLED || "") === "1") {
    deps.log?.warn({}, "TEXTING_SWITCHER_DISABLED");
    return null;
  }
  const run = async () => {
    if (switcherState.running) return;
    switcherState.running = true;
    try {
      const r = await sweepTextingSwitcher(deps);
      switcherState.lastResult = r;
      switcherState.lastError = null;
      if (r.switched.length || r.errors.length) deps.log?.warn({ textingSwitcher: r }, "texting switcher took action");
    } catch (err: any) {
      switcherState.lastError = String(err?.message || err).slice(0, 300);
      deps.log?.error({ err: switcherState.lastError }, "texting_switcher_failed");
    } finally {
      switcherState.lastRunAt = new Date();
      switcherState.running = false;
    }
  };
  const boot = setTimeout(run, SWITCHER_BOOT_DELAY_MS);
  const interval = setInterval(run, SWITCHER_INTERVAL_MS);
  (boot as any).unref?.();
  (interval as any).unref?.();
  deps.log?.info({ intervalMs: SWITCHER_INTERVAL_MS, bootDelayMs: SWITCHER_BOOT_DELAY_MS }, "TEXTING_SWITCHER_ARMED");
  return { stop: () => { clearTimeout(boot); clearInterval(interval); } };
}
