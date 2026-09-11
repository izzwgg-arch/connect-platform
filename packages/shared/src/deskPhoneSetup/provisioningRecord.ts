/**
 * THE CHICKEN AND EGG, AND THE ONE DECISION THAT BREAKS IT.
 *
 * ⛔⛔ THE WALL THIS EXISTS TO REMOVE. The standing PnP responder answers a phone
 * only when that phone's hardware address is already recorded on the PBX. Setting a
 * phone up is the entire job — so until 2026-09-11 the wizard could RE-POINT a phone
 * the PBX already knew and could never FINISH a new one. Proven on Izzy's own rig:
 * he power-cycled a factory-reset Yealink, it multicast its `ua-profile` SUBSCRIBE
 * exactly as designed, `80:5e:c0:b3:b2:d0` had no `provisioning.devices` row on any
 * tenant, and we deliberately said nothing back. The phone did everything right and
 * we ignored it.
 *
 * The fix is not a new protocol. It is writing the record at the moment the person
 * says which colleague this phone belongs to — because that is the first instant at
 * which every input exists: the hardware address (from our own scan), the model
 * (from the phone, or from the person's own dropdown pick) and the extension.
 *
 * ⛔ Everything here is PURE. It decides what row should exist; it writes nothing.
 * The write is `save_phone` on the PBX helper, which has been proven on production
 * since the console work — this module is the missing decision, not a missing
 * mechanism.
 */

import { findCatalogModel, vendorSlugFor } from "./vendorAdapters";
import { VENDOR_CATALOG, type VendorSlug } from "./vendorCatalog.generated";
import { normalizeMac } from "./deviceIdentity";

/** A `provisioning.devices` row as the PBX currently has it, or null when there is none. */
export type PbxPhoneRecord = {
  /** `provisioning.devices.id` — what `save_phone` needs to UPDATE rather than INSERT. */
  phoneId: number;
  /** Normalised, no separators, lower case. */
  mac: string;
  /** `provisioning.devices.tenant` — the PBX tenant NUMBER, not a Connect tenant id. */
  pbxTenantNumber: number;
  /** `provisioning.phone_models.id`. */
  modelId: number;
  templateId: number | null;
  /**
   * The `ombu_devices.device_id` values bound to this handset's line keys, in order,
   * with null for an empty key.
   *
   * ⛔ THE COLUMN NAMES INVERT AND IT HAS ALREADY COST ONE WRONG DIAGNOSIS.
   * `provisioning.accounts.device_id` is the PROVISIONING row's id, and
   * `provisioning.accounts.phone_device_id` is the `ombu_devices` id. Joining the
   * obvious way round returns nothing and reads exactly like "this phone is bound
   * to no extension".
   */
  boundDeviceIds: Array<number | null>;
};

/** Everything known about the phone the person just assigned. */
export type RecordTarget = {
  /** As discovered. Normalised here, so callers may pass any separator style. */
  mac: string;
  /** Brand slug or free text; used only when the model alone cannot name the brand. */
  vendor: string | null;
  /**
   * The model. From the phone's own banner where we could read one, otherwise from
   * the person picking it out of the two dropdowns — which is the whole reason those
   * dropdowns exist rather than the free-text box that was sent to the server by
   * nothing.
   */
  model: string | null;
  /** The PBX tenant NUMBER this customer's phones live under. */
  pbxTenantNumber: number;
  /** The extension the person chose. Blank means they have not chosen yet. */
  extNumber: string;
  /**
   * The `ombu_devices.device_id` of the extension's DESK endpoint (`T<n>_<ext>`).
   *
   * ⛔⛔ NEVER THE SOFTPHONE (`T<n>_<ext>_1`). Binding a handset to the softphone
   * device would render a config carrying the softphone's credentials, so the desk
   * phone and the app would fight over one registration.
   */
  deskDeviceId: number | null;
  /**
   * Every `ombu_devices.device_id` that currently exists for this customer. Used for
   * one purpose: telling a binding that points at a DELETED device apart from one
   * that is simply different.
   *
   * ⛔ This is not hypothetical. Izzy's HT801 is recorded on the right tenant and
   * bound to `ombu_devices` id 149, which does not exist — Landau Home has 130 and
   * 191 and nothing else. Its rendered config therefore carries no account at all,
   * so the one phone whose record looked correct could never have registered either.
   */
  liveDeviceIds: number[];
  /**
   * How many line keys this model has, when the PBX has told us. Only used to pad the
   * account list so the row keeps the shape the panel renders. Defaults to one.
   */
  lineKeys?: number;
};

export type RecordRefusal =
  | "bad_mac"
  | "not_assigned"
  | "no_desk_device"
  | "model_unknown"
  | "model_not_in_catalogue"
  | "no_template_on_disk";

export type RecordPlan =
  | {
      kind: "refuse";
      reason: RecordRefusal;
      /** For a technician. */
      explain: string;
      /** For the customer. ⛔ Never a status code, never a table name. */
      customerMessage: string;
    }
  | {
      kind: "adopt";
      phoneId: number;
      explain: string;
    }
  | {
      kind: "write";
      /** null = INSERT a new row; a number = UPDATE that row in place. */
      phoneId: number | null;
      mac: string;
      pbxModelId: number;
      pbxTenantNumber: number;
      description: string;
      accounts: Array<number | null>;
      /**
       * Set when this write MOVES a handset off another customer's tenant.
       *
       * ⛔⛔ THE CALLER MUST AUDIT THIS LOUDLY AND STORE IT. It is the one branch
       * that changes another customer's data, it is reversible only if the previous
       * tenant is written down, and it is common: three of the four phones on Izzy's
       * own desk are recorded under A plus center and Create A Box.
       */
      rehomedFromTenant: number | null;
      /** True when the row was ours already but pointed at the wrong or a dead device. */
      rebound: boolean;
      explain: string;
    };

/** Which brand the catalogue thinks this is, from the model first and the vendor second. */
function resolveModel(target: RecordTarget):
  | { slug: VendorSlug; pbxModelId: number; hasBaseTemplate: boolean; canonical: string }
  | null {
  const text = String(target.model ?? "").trim();
  if (!text) return null;
  const direct = findCatalogModel(text);
  if (direct) {
    return {
      slug: direct.slug,
      pbxModelId: direct.model.pbxModelId,
      hasBaseTemplate: direct.model.hasBaseTemplate,
      canonical: direct.model.model,
    };
  }
  // ⛔ Second chance ONLY inside the brand the caller already believes it is. A
  // global fuzzy match across 427 models would happily turn "T53" into something
  // from another maker, and a wrong model renders a config the handset ignores.
  const slug = vendorSlugFor(target.vendor);
  if (!slug) return null;
  const key = text.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!key) return null;
  for (const m of VENDOR_CATALOG[slug].models) {
    if (m.key === key) {
      return { slug, pbxModelId: m.pbxModelId, hasBaseTemplate: m.hasBaseTemplate, canonical: m.model };
    }
  }
  return null;
}

/** The line-key list a `provisioning.accounts` write should carry. */
function accountsFor(deskDeviceId: number, lineKeys: number | undefined): Array<number | null> {
  const keys = Math.max(1, Math.min(Number(lineKeys ?? 1) || 1, 16));
  const out: Array<number | null> = [deskDeviceId];
  for (let i = 1; i < keys; i += 1) out.push(null);
  return out;
}

/**
 * Decide what `provisioning.devices` row this phone needs.
 *
 * ⛔ Order is the policy, as everywhere else in this subsystem. Refusals first, so a
 * phone we cannot describe is never written as a half row; then "already correct",
 * so the common case touches nothing; then the writes, cheapest first.
 */
export function planProvisioningRecord(
  target: RecordTarget,
  existing: PbxPhoneRecord | null,
): RecordPlan {
  // 0 — a hardware address we cannot make sense of. ⛔ First, and fatal: the MAC is
  // the row's identity and the file name the handset fetches. Writing a row under a
  // half-read address produces a config no phone will ever ask for.
  const mac = normalizeMac(target.mac);
  if (!mac) {
    return {
      kind: "refuse",
      reason: "bad_mac",
      explain: `"${String(target.mac).slice(0, 40)}" is not a usable hardware address`,
      customerMessage: "We could not read this phone's hardware address. Run the search again.",
    };
  }

  // 1 — nobody has said who this phone belongs to. Nothing to write yet, and this
  // is not a fault: it is the ordinary state of a phone on the found screen.
  if (!String(target.extNumber ?? "").trim()) {
    return {
      kind: "refuse",
      reason: "not_assigned",
      explain: "no extension chosen for this phone yet",
      customerMessage: "Choose who uses this phone and we will set it up.",
    };
  }

  // 2 — the extension has no desk endpoint to bind the handset to.
  if (!target.deskDeviceId) {
    return {
      kind: "refuse",
      reason: "no_desk_device",
      explain: `extension ${target.extNumber} has no desk device (T${target.pbxTenantNumber}_${target.extNumber}) on the phone system`,
      customerMessage:
        "This extension is set up for the app but not for a desk phone yet. Loopcom Support can add that in a moment.",
    };
  }

  // 3 — we do not know what this phone IS. ⛔ This is the branch the two dropdowns
  // exist to answer, and it must NEVER be guessed: a wrong model renders a settings
  // file the handset silently ignores, which looks exactly like a dead phone.
  const resolved = resolveModel(target);
  if (!String(target.model ?? "").trim()) {
    return {
      kind: "refuse",
      reason: "model_unknown",
      explain: "no model known for this phone, from the device or from the person",
      customerMessage: "Tell us the make and model on the back of this phone and we can set it up.",
    };
  }
  if (!resolved) {
    return {
      kind: "refuse",
      reason: "model_not_in_catalogue",
      explain: `model "${String(target.model).slice(0, 40)}" is not in the phone system's catalogue`,
      customerMessage:
        "Loopcom cannot set this model up automatically yet. Support can connect it for you — your other phones keep going.",
    };
  }
  if (!resolved.hasBaseTemplate) {
    // ⛔ One model in 427 is in this state (Gigaset P820 IP PRO — a catalogue row
    // with no template on disk). Saying so plainly beats writing a row whose config
    // can never render.
    return {
      kind: "refuse",
      reason: "no_template_on_disk",
      explain: `model "${resolved.canonical}" has a catalogue row but no template on the phone system`,
      customerMessage:
        "Loopcom cannot set this model up automatically yet. Support can connect it for you — your other phones keep going.",
    };
  }

  const description = String(target.extNumber).trim();
  const accounts = accountsFor(target.deskDeviceId, target.lineKeys);

  // 4 — no row anywhere. The Yealink case: write one.
  if (!existing) {
    return {
      kind: "write",
      phoneId: null,
      mac,
      pbxModelId: resolved.pbxModelId,
      pbxTenantNumber: target.pbxTenantNumber,
      description,
      accounts,
      rehomedFromTenant: null,
      rebound: false,
      explain: `no provisioning record existed for ${mac}; creating one for ${resolved.canonical} on extension ${description}`,
    };
  }

  const boundHere = existing.boundDeviceIds.filter((d): d is number => typeof d === "number");
  const primary = boundHere.length ? boundHere[0] : null;
  const live = new Set(target.liveDeviceIds);
  const bindingIsDead = primary != null && !live.has(primary);
  const bindingIsWrong = primary !== target.deskDeviceId;
  const wrongTenant = existing.pbxTenantNumber !== target.pbxTenantNumber;
  const wrongModel = existing.modelId !== resolved.pbxModelId;

  // 5 — already exactly right. Touch nothing. ⛔ This must come before every write
  // branch: re-rendering a working phone's config for no reason is how a wizard
  // turns a healthy handset into a support call.
  if (!wrongTenant && !wrongModel && !bindingIsWrong && !bindingIsDead) {
    return {
      kind: "adopt",
      phoneId: existing.phoneId,
      explain: `${mac} is already recorded correctly for extension ${description}`,
    };
  }

  // 6 — the row belongs to another customer. We move it, and we say so.
  //
  // ⛔⛔ WHY MOVING IS THE HONEST ANSWER RATHER THAN REFUSING. A hardware address
  // identifies one physical handset in the world. If the phone is sitting on THIS
  // customer's network — which is the only way it reached this function, since the
  // row came from our own scan of their LAN — then the other customer's record is
  // stale and is ALREADY dangerous: it renders a settings file, carrying that
  // customer's SIP credentials, at a URL this handset can fetch. Leaving it is not
  // the safe option; it is the status quo that is wrong.
  //
  // ⛔ The previous tenant is returned so the caller can audit it and put it back.
  if (wrongTenant) {
    return {
      kind: "write",
      phoneId: existing.phoneId,
      mac,
      pbxModelId: resolved.pbxModelId,
      pbxTenantNumber: target.pbxTenantNumber,
      description,
      accounts,
      rehomedFromTenant: existing.pbxTenantNumber,
      rebound: true,
      explain:
        `${mac} was recorded under PBX tenant ${existing.pbxTenantNumber} and was found on this customer's own network; ` +
        `moving it to tenant ${target.pbxTenantNumber} extension ${description}`,
    };
  }

  // 7 — ours already, but pointed at the wrong extension device or at one that no
  // longer exists. The HT801 case: a record that looks right and renders no account.
  return {
    kind: "write",
    phoneId: existing.phoneId,
    mac,
    pbxModelId: resolved.pbxModelId,
    pbxTenantNumber: target.pbxTenantNumber,
    description,
    accounts,
    rehomedFromTenant: null,
    rebound: true,
    explain: bindingIsDead
      ? `${mac} was bound to device ${primary}, which no longer exists; rebinding to extension ${description}`
      : wrongModel
        ? `${mac} was recorded as model ${existing.modelId}; correcting to ${resolved.canonical} on extension ${description}`
        : `${mac} was bound to device ${primary ?? "nothing"}; rebinding to extension ${description}`,
  };
}

/**
 * The MACs the standing PnP responder should be armed with for this run.
 *
 * ⛔⛔ THIS IS THE OTHER HALF OF THE FIX AND IT IS EASY TO FORGET. Writing the record
 * makes the phone provisionable; arming the listener with that address is what makes
 * it provision. A phone whose record was created ten seconds ago is exactly the phone
 * about to be power-cycled, so it has to be in the list the desktop is holding — not
 * in the list it fetched an hour ago.
 *
 * ⛔ Only phones that are IN the setup: a person's unticked phone is never answered,
 * because answering it would point a handset they deliberately left alone at us.
 */
export function pnpArmList(
  phones: Array<{ macAddress: string; skippedAt: Date | string | null; extNumber: string | null }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of phones) {
    if (p.skippedAt) continue;
    if (!String(p.extNumber ?? "").trim()) continue;
    const mac = normalizeMac(p.macAddress);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    out.push(mac);
  }
  return out;
}
