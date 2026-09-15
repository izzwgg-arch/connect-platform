/**
 * WRITING THE RECORD THAT MAKES A NEW PHONE FINISHABLE.
 *
 * ⛔⛔ THE WALL. The standing PnP responder answers a phone only when that phone's
 * hardware address is already in `provisioning.devices`. Setting a phone up is the
 * whole job — so until this existed the wizard could RE-POINT a phone the PBX already
 * knew and could never FINISH a new one. Izzy's factory-reset Yealink multicast its
 * `ua-profile` SUBSCRIBE exactly as designed, `80:5e:c0:b3:b2:d0` had no row on any
 * tenant, and we deliberately said nothing back.
 *
 * ⛔ The DECISION is pure and lives in `@connect/shared` (`planProvisioningRecord`).
 * This module is the two things that cannot be pure: reading the PBX, and calling
 * `save_phone` — which has been proven on production since the console work.
 *
 * ⛔⛔ IT IS BEST-EFFORT AND MUST STAY THAT WAY. Assigning a phone to a colleague is a
 * thing a person did; it must not fail because the PBX is unreachable, because the
 * model is not in the catalogue, or because nobody has made a settings profile for it
 * yet. Every one of those comes back as a REASON the caller records on the row, so the
 * screen can say what is missing instead of a spinner saying nothing.
 */

// ⛔ ROOT IMPORT, never `@connect/shared/deskPhoneSetup`. apps/api typechecks under a
// moduleResolution that cannot resolve that subpath — it works in the portal only, and
// using it here is a build error that reads like a missing export.
import {
  decideRehome,
  normalizeMac,
  planProvisioningRecord,
  type PbxPhoneRecord,
  type PbxTemplate,
  type RecordPlan,
  type RehomeRegistration,
} from "@connect/shared";

/** The narrowest thing a query source has to be, so tests need no database. */
export type RecordQuery = (sql: string, params?: any[]) => Promise<any[]>;

export type RecordContext = {
  existing: PbxPhoneRecord | null;
  templates: PbxTemplate[];
  /** `ombu_devices.device_id` of `T<tenant>_<ext>` — the DESK endpoint. */
  deskDeviceId: number | null;
  /** Every `ombu_devices.device_id` this customer has. */
  liveDeviceIds: number[];
};

/**
 * Read everything the decision needs, in four queries, all SELECTs.
 *
 * ⛔⛔ THE DEVICE LOOKUP IS BY MAC ACROSS EVERY TENANT, not within this customer's.
 * That is the point: three of the four phones on Izzy's desk are recorded under A plus
 * center and Create A Box, and scoping the lookup to his own tenant would report them
 * as having no record at all — then a second INSERT would hit `mac_already_used` and
 * the wizard would stall with a message about a clash it could not explain.
 */
export async function readRecordContext(
  query: RecordQuery,
  args: { pbxTenantNumber: number; mac: string; extNumber: string },
): Promise<RecordContext> {
  const mac = normalizeMac(args.mac);
  let existing: PbxPhoneRecord | null = null;
  if (mac) {
    const rows = await query(
      "SELECT id, mac, tenant, model_id, template_id FROM provisioning.devices WHERE REPLACE(REPLACE(LOWER(mac),':',''),'-','') = ? LIMIT 1",
      [mac],
    );
    const row = rows?.[0];
    if (row) {
      // ⛔ ORDER BY id: `provisioning.accounts` rows are the handset's line keys in
      // order, and the FIRST one is its primary line. An unordered read would rebind
      // a working phone to whichever row the database felt like returning first.
      const accts = await query(
        "SELECT phone_device_id FROM provisioning.accounts WHERE device_id = ? ORDER BY id",
        [Number(row.id)],
      );
      existing = {
        phoneId: Number(row.id),
        mac,
        pbxTenantNumber: Number(row.tenant) || 0,
        modelId: Number(row.model_id) || 0,
        templateId: row.template_id == null ? null : Number(row.template_id),
        boundDeviceIds: (accts ?? []).map((a: any) =>
          a.phone_device_id == null ? null : Number(a.phone_device_id),
        ),
      };
    }
  }

  let templates: PbxTemplate[] = [];
  try {
    const rows = await query("SELECT id, model_id, tenant, shared FROM provisioning.templates", []);
    templates = (rows ?? []).map((t: any) => ({
      id: Number(t.id),
      modelId: Number(t.model_id) || 0,
      tenant: t.tenant == null ? null : Number(t.tenant),
      // ⛔ VitalPBX writes this column as 'yes'/'no', not as a boolean. Reading it as
      // truthy would make EVERY profile look shared and hand one customer's settings
      // to another; reading it as a boolean only would make none of them shared and
      // leave every new model needing a profile nobody has made.
      shared: t.shared === 1 || t.shared === true || String(t.shared ?? "").toLowerCase() === "yes",
    }));
  } catch {
    // A missing templates read costs the profile, never the whole decision — the plan
    // then says `needsTemplate` and the caller records that as the reason.
    templates = [];
  }

  let deskDeviceId: number | null = null;
  let liveDeviceIds: number[] = [];
  try {
    const rows = await query(
      `SELECT d.device_id AS device_id, d.user AS user
         FROM ombutel.ombu_devices d
         JOIN ombutel.ombu_extensions e ON e.extension_id = d.extension_id
        WHERE e.tenant_id = ?`,
      [args.pbxTenantNumber],
    );
    liveDeviceIds = (rows ?? []).map((r: any) => Number(r.device_id)).filter((n) => Number.isFinite(n) && n > 0);
    // ⛔⛔ `ombu_devices.user` IS THE BARE EXTENSION: the desk device is `101` and the
    // softphone is `101_1`. The PBX composes the endpoint name `T<n>_101` itself; the
    // column never carries the prefix (live census 2026-09-14: 158 pjsip devices, 0
    // prefixed). This line first matched `T21_101`, copied from an invented test
    // fixture, and would have refused EVERY real write as "no desk device".
    // Matching loosely would bind the handset to the softphone's credentials, so the
    // desk phone and the app would fight over one registration. Exact string, always —
    // the tenant is already fixed by the join above.
    const want = String(args.extNumber).trim();
    const desk = (rows ?? []).find((r: any) => String(r.user ?? "").trim() === want);
    deskDeviceId = desk ? Number(desk.device_id) : null;
  } catch {
    deskDeviceId = null;
    liveDeviceIds = [];
  }

  return { existing, templates, deskDeviceId, liveDeviceIds };
}

export type RecordOutcome =
  | { kind: "written"; phoneId: number; rehomedFromTenant: number | null; rebound: boolean; explain: string }
  | { kind: "adopted"; phoneId: number; explain: string }
  | { kind: "refused"; reason: string; explain: string; customerMessage: string }
  /** The PBX could not be read or the save failed. Never fatal to the assignment. */
  | { kind: "unavailable"; detail: string };

export type RecordWriterDeps = {
  /** Read-only PBX access. Returning null means "cannot reach the phone system". */
  query: (pbxTenantNumber: number) => Promise<RecordQuery | null>;
  savePhone: (args: {
    phoneId?: number | null;
    mac: string;
    tenantId: number;
    modelId: number;
    templateId?: number | null;
    description?: string;
    accounts?: Array<number | null>;
  }) => Promise<{ phoneId: number }>;
  /**
   * ⛔⛔ CALLED WHENEVER A HANDSET IS TAKEN OFF ANOTHER CUSTOMER'S TENANT. It is the
   * one branch that changes another customer's data and it is reversible ONLY if the
   * previous tenant is written down. Three of the four phones on Izzy's own desk hit it.
   */
  auditRehome?: (info: { mac: string; fromTenant: number; toTenant: number; extNumber: string }) => Promise<void> | void;
  /**
   * The api's live registration mirror for these endpoints (`T<n>_<ext>`). Consulted
   * only when a write would MOVE a record off another account. ⛔ Absent or throwing
   * means the move is REFUSED — a move is never allowed on missing evidence.
   */
  registrations?: (endpoints: string[]) => Promise<RehomeRegistration[]>;
  log?: (line: string) => void;
};

/**
 * Make the PBX hold the record this phone needs.
 *
 * ⛔ Nothing here throws. Every failure is a named outcome the caller stores on the
 * phone's row, because the person has already done their part — chosen whose phone it
 * is — and telling them it failed is a job for the screen, not an exception.
 */
export async function ensureProvisioningRecord(
  deps: RecordWriterDeps,
  args: {
    pbxTenantNumber: number;
    mac: string;
    vendor: string | null;
    model: string | null;
    extNumber: string;
    lineKeys?: number;
    /** Where our own scan saw the handset on the customer's LAN. */
    discoveredIp?: string | null;
    /** The public address the customer's own computer reached us from. */
    requesterIp?: string | null;
  },
): Promise<RecordOutcome> {
  const log = deps.log ?? (() => {});
  let query: RecordQuery | null = null;
  try {
    query = await deps.query(args.pbxTenantNumber);
  } catch (e: any) {
    return { kind: "unavailable", detail: e?.message || String(e) };
  }
  if (!query) return { kind: "unavailable", detail: "phone system unreachable" };

  let ctx: RecordContext;
  try {
    ctx = await readRecordContext(query, {
      pbxTenantNumber: args.pbxTenantNumber,
      mac: args.mac,
      extNumber: args.extNumber,
    });
  } catch (e: any) {
    return { kind: "unavailable", detail: e?.message || String(e) };
  }

  const plan: RecordPlan = planProvisioningRecord(
    {
      mac: args.mac,
      vendor: args.vendor,
      model: args.model,
      pbxTenantNumber: args.pbxTenantNumber,
      extNumber: args.extNumber,
      deskDeviceId: ctx.deskDeviceId,
      liveDeviceIds: ctx.liveDeviceIds,
      templates: ctx.templates,
      ...(args.lineKeys ? { lineKeys: args.lineKeys } : {}),
    },
    ctx.existing,
  );

  if (plan.kind === "refuse") {
    log(`record refused: ${plan.reason} — ${plan.explain}`);
    return { kind: "refused", reason: plan.reason, explain: plan.explain, customerMessage: plan.customerMessage };
  }
  if (plan.kind === "adopt") {
    log(`record adopted: ${plan.explain}`);
    return { kind: "adopted", phoneId: plan.phoneId, explain: plan.explain };
  }

  // ⛔⛔ A ROW WITH NO SETTINGS PROFILE RENDERS A CONFIG THE HANDSET CANNOT USE, and
  // `save_phone` accepts it without complaint — so this is refused rather than written.
  // Writing it would leave the customer with a phone that fetches an empty file and a
  // wizard that believes it succeeded, which is the worst of both.
  if (plan.needsTemplate) {
    log(`record refused: no settings profile for model ${plan.pbxModelId}`);
    return {
      kind: "refused",
      reason: "no_settings_profile",
      explain: `the phone system has no settings profile for model id ${plan.pbxModelId} on tenant ${args.pbxTenantNumber}`,
      customerMessage:
        "Loopcom needs to add a settings profile for this model of phone before it can be set up. " +
        "We can see it on your network and we will finish it for you.",
    };
  }

  // ⛔⛔ MOVING A RECORD OFF ANOTHER CUSTOMER NEEDS PROOF IT IS STALE (2026-09-14).
  // "This phone is on my network" is reported by the customer's OWN computer and the
  // server cannot verify it beyond the presence pair, so the rule lives in `decideRehome`.
  // Since 2026-09-15 (Izzy: "the desktop wizard gets priority ... that phone belongs to the
  // wizard") a live registration by a DIFFERENT device no longer blocks the release —
  // removing a MAC's record never touches another device's registration. What still
  // refuses: unreadable registration state, a missing presence pair, and the forger shape
  // (this handset's own LAN address live from another public address). Every release over
  // a live extension is audited via auditRehome and logged with the endpoints left standing.
  if (plan.rehomedFromTenant != null) {
    const bound = (ctx.existing?.boundDeviceIds ?? []).filter(
      (d): d is number => typeof d === "number" && d > 0,
    );
    let boundEndpoints: string[] = [];
    if (bound.length) {
      try {
        const rows = await query(
          `SELECT od.device_id AS device_id, od.user AS user, e.tenant_id AS tenant_id
             FROM ombutel.ombu_devices od
             JOIN ombutel.ombu_extensions e ON e.extension_id = od.extension_id
            WHERE od.device_id IN (${bound.map(() => "?").join(", ")})`,
          bound,
        );
        // ⛔ `user` is the bare extension (`106`); the PBX names the endpoint `T7_106`.
        boundEndpoints = (rows ?? [])
          .map((r: any) => `T${Number(r.tenant_id)}_${String(r.user ?? "").trim()}`)
          .filter((ep: string) => /^T\d+_\S+$/.test(ep));
      } catch (e: any) {
        return { kind: "unavailable", detail: `could not read the other account's extension: ${e?.message || String(e)}` };
      }
    }
    let registrations: RehomeRegistration[] | null = null;
    if (boundEndpoints.length && deps.registrations) {
      try {
        registrations = await deps.registrations(boundEndpoints);
      } catch {
        registrations = null;
      }
    }
    const decision = decideRehome({
      boundEndpoints,
      registrations,
      discoveredIp: args.discoveredIp ?? null,
      requesterIp: args.requesterIp ?? null,
      now: new Date(),
    });
    if (!decision.allow) {
      log(`record move refused: held by tenant ${plan.rehomedFromTenant} — ${decision.why}`);
      return {
        kind: "refused",
        reason: "held_by_another_account",
        explain: `${plan.mac} is recorded under PBX tenant ${plan.rehomedFromTenant} and was NOT moved: ${decision.why}`,
        // ⛔ Never tells the customer another company holds this phone — that is an
        // audit fact for us, not something their screen should learn.
        customerMessage:
          "Loopcom Support needs to finish setting up this phone for you. Your other phones keep going.",
      };
    }
    log(`record move allowed: ${decision.why}`);
  }

  // ⛔ AUDIT BEFORE THE WRITE. If the save lands and the audit then fails, the record
  // of where the phone came from is lost and the move cannot be undone. Auditing first
  // can at worst record a move that did not happen, which is recoverable by reading.
  if (plan.rehomedFromTenant != null && deps.auditRehome) {
    try {
      await deps.auditRehome({
        mac: plan.mac,
        fromTenant: plan.rehomedFromTenant,
        toTenant: plan.pbxTenantNumber,
        extNumber: plan.description,
      });
    } catch (e: any) {
      return { kind: "unavailable", detail: `could not record the move: ${e?.message || String(e)}` };
    }
  }

  try {
    const saved = await deps.savePhone({
      phoneId: plan.phoneId,
      mac: plan.mac,
      tenantId: plan.pbxTenantNumber,
      modelId: plan.pbxModelId,
      templateId: plan.templateId,
      description: plan.description,
      accounts: plan.accounts,
    });
    log(`record written: ${plan.explain}`);
    return {
      kind: "written",
      phoneId: saved.phoneId,
      rehomedFromTenant: plan.rehomedFromTenant,
      rebound: plan.rebound,
      explain: plan.explain,
    };
  } catch (e: any) {
    const detail = e?.message || String(e);
    // ⛔ `mac_already_used` is the one failure with a specific meaning: a row for this
    // hardware address exists that our read did not see. Say so rather than reporting
    // a generic phone-system failure, or the next person re-reads the whole PBX.
    if (/mac_already_used/i.test(detail)) {
      return {
        kind: "refused",
        reason: "mac_already_used",
        explain: `the phone system already holds a different record for ${plan.mac}`,
        customerMessage:
          "Another record already exists for this phone. Loopcom Support will clear it and finish this one with you.",
      };
    }
    return { kind: "unavailable", detail };
  }
}
