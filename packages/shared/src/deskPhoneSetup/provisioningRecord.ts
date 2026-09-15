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
  /**
   * Every `provisioning.templates` row the PBX has, as the console reads them.
   *
   * ⛔⛔ A DEVICE ROW WITH NO SETTINGS PROFILE RENDERS A CONFIG THE HANDSET CANNOT
   * USE, and it fails SILENTLY — `save_phone` accepts a null `template_id`, the
   * INSERT lands, the generator runs, and the phone fetches a file with nothing in
   * it. All 55 devices that exist on this PBX today carry a non-null `template_id`,
   * so a null one is a shape nothing here has ever produced and nothing has ever
   * been proven against. Deciding the profile is therefore part of deciding the row,
   * not a detail the caller fills in afterwards.
   */
  templates: PbxTemplate[];
};

/** A `provisioning.templates` row, reduced to the columns that decide anything. */
export type PbxTemplate = {
  id: number;
  /** `provisioning.templates.model_id`. A profile only fits the model it was made for. */
  modelId: number;
  /** The PBX tenant NUMBER that owns it, or null for a profile every tenant may use. */
  tenant: number | null;
  /** VitalPBX's own "this one is shared" flag. */
  shared: boolean;
  /**
   * A CLEAN model-default profile Loopcom seeded from VitalPBX's stock base — placeholder
   * server, no customer's hand-hardcoded overrides. Identified by the `loopcom_clean_` unique_name
   * marker. Preferred over an arbitrary shared profile so a moved/new phone can never inherit
   * another customer's baked-in server (the Create A Box VPN poisoning, 2026-09-15).
   */
  generic?: boolean;
};

/**
 * Which settings profile this handset should use.
 *
 * ⛔ ORDER IS THE POLICY. The customer's OWN profile for this model wins, because it
 * carries whatever they have already had set up — timezone, keys, the lot. Then the CLEAN
 * generic profile (placeholder server, no baked-in overrides) — this is what keeps a moved
 * or brand-new phone from inheriting ANOTHER customer's hardcoded server (the Create A Box
 * VPN poisoning, 2026-09-15). An arbitrary shared profile is the last resort. Nothing else is
 * ever substituted: a profile built for a DIFFERENT model writes settings this handset does
 * not have, which is worse than no profile at all because it looks like it worked.
 */
export function chooseTemplate(
  pbxModelId: number,
  pbxTenantNumber: number,
  templates: PbxTemplate[],
): number | null {
  const forModel = (templates ?? []).filter((t) => t && Number(t.modelId) === pbxModelId);
  const own = forModel.find((t) => Number(t.tenant) === pbxTenantNumber);
  if (own) return own.id;
  const generic = forModel.find((t) => t.generic && (t.shared || t.tenant == null));
  if (generic) return generic.id;
  const shared = forModel.find((t) => t.shared || t.tenant == null);
  return shared ? shared.id : null;
}

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
      /**
       * The settings profile to write, or null when the phone system has none that
       * fits this model.
       *
       * ⛔⛔ NULL IS NOT "leave it blank and carry on" — it is a hole the CALLER has
       * to close, by creating a profile for this model before writing the row. The
       * plan says so rather than deciding it, because creating one is a write to the
       * phone system and this module writes nothing.
       */
      templateId: number | null;
      /** True exactly when `templateId` is null. Named so a caller cannot miss it. */
      needsTemplate: boolean;
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

  // ⛔ Decided ONCE, here, so every write branch below carries the same answer. An
  // existing row's own profile is kept when it already fits the model we are writing
  // — a customer's profile holds their own settings and re-picking would discard them.
  const keepExisting =
    existing && existing.templateId != null && existing.modelId === resolved.pbxModelId
      ? existing.templateId
      : null;
  const templateId = keepExisting ?? chooseTemplate(resolved.pbxModelId, target.pbxTenantNumber, target.templates ?? []);
  const templateFields = { templateId, needsTemplate: templateId == null };

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
      ...templateFields,
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
      ...templateFields,
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
    ...templateFields,
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

/* ── moving a record off another customer ─────────────────────────────────── */

/** How recently a registration still counts as somebody USING that extension. */
export const REHOME_LIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** One row of the api's live registration mirror, reduced to what decides a move. */
export type RehomeRegistration = {
  /** `T<tenant>_<ext>` as the PBX names the endpoint. */
  endpoint: string;
  status: string | null;
  lastRegisteredAt: Date | string | null;
  /** e.g. `sip:T7_106@50.48.58.53:36493;x-ast-orig-host=192.168.6.171:5060`. */
  contactUri: string | null;
};

export type RehomeEvidence = {
  /** The endpoints the OTHER account's record is bound to that still exist. */
  boundEndpoints: string[];
  /** null = the registration state could not be read. */
  registrations: RehomeRegistration[] | null;
  /** Where our own scan saw this handset on the customer's LAN. */
  discoveredIp: string | null;
  /** The public address the customer's own computer reached us from. */
  requesterIp: string | null;
  now: Date;
  windowMs?: number;
};

export type RehomeDecision = {
  allow: boolean;
  why: string;
  /** Endpoints whose live registrations were deliberately left standing while the record was
   *  released — other devices, untouched by a MAC-record release. Audit material. */
  releasedOverLive?: string[];
};

const cleanHost = (h: string | null | undefined): string | null => {
  const v = String(h ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  return v || null;
};

/**
 * The two addresses Asterisk records for a registered contact: the public one the
 * REGISTER arrived from, and the phone's own LAN address, which `rewrite_contact`
 * preserves as `x-ast-orig-host`.
 */
export function contactAddresses(contactUri: string | null | undefined): {
  publicHost: string | null;
  lanHost: string | null;
} {
  const uri = String(contactUri ?? "");
  const pub = /@(\[[^\]]+\]|[^:;>\s]+)/.exec(uri);
  const lan = /x-ast-orig-host=(\[[^\]]+\]|[^:;>\s]+)/i.exec(uri);
  return { publicHost: cleanHost(pub?.[1]), lanHost: cleanHost(lan?.[1]) };
}

/**
 * May a phone's record be taken off the account it is recorded under?
 *
 * ⛔⛔ THE HOLE THIS CLOSES, found 2026-09-14 before the record writer ever shipped.
 * "This phone is on my network" is reported by the customer's OWN computer and the
 * server cannot verify it. Moving a record on that word alone would let any customer
 * with the desk-phone permission name another company's working handset and silently
 * re-point it — the victim's desk phone would fetch the claimant's settings at its next
 * boot and stop ringing for its owner.
 *
 * ⛔ So a move is allowed only when it is PROVABLY stale:
 *   - the other record is bound to no extension that still exists, or
 *   - nothing has registered on its extension inside the window, or
 *   - the ONLY live registration there is this very handset: its LAN address matches
 *     our scan AND its public address matches the customer's own computer. A forger
 *     would have to be sitting inside that office to satisfy both.
 * Everything else — including anything we could not read — refuses. A stale row left
 * for Support costs a phone call; a live phone taken costs another customer their line.
 *
 * Measured on Izzy's rig the same day, which is why the third branch exists: his
 * GXP2170 at 192.168.6.171 is live as Create A Box ext 106 from his own public address,
 * while Create A Box's REAL ext 102 is their office phone behind their tunnel.
 */
export function decideRehome(e: RehomeEvidence): RehomeDecision {
  const bound = [...new Set((e.boundEndpoints ?? []).map((s) => String(s).trim()).filter(Boolean))];
  if (!bound.length) {
    return { allow: true, why: "the other account's record is bound to no extension that still exists" };
  }
  if (!e.registrations) {
    return { allow: false, why: "the registration state of the other account's extension could not be read" };
  }
  const windowMs = e.windowMs ?? REHOME_LIVE_WINDOW_MS;
  const nowMs = e.now.getTime();
  const live = e.registrations.filter((r) => {
    if (!r || !bound.includes(String(r.endpoint))) return false;
    if (String(r.status ?? "").toUpperCase() === "REGISTERED") return true;
    const t = r.lastRegisteredAt == null ? NaN : new Date(r.lastRegisteredAt).getTime();
    return Number.isFinite(t) && nowMs - t <= windowMs;
  });
  if (!live.length) {
    return {
      allow: true,
      why: `nothing has registered on ${bound.join(", ")} in the last ${Math.round(windowMs / 86_400_000)} days`,
    };
  }
  const discovered = cleanHost(e.discoveredIp);
  const requester = cleanHost(e.requesterIp);
  const strangers = live.filter((r) => {
    const { publicHost, lanHost } = contactAddresses(r.contactUri);
    return !(discovered && requester && lanHost === discovered && publicHost === requester);
  });
  if (!strangers.length) {
    return {
      allow: true,
      why: `the only live registration on ${live.map((r) => r.endpoint).join(", ")} is this handset (${discovered}) on this customer's own network (${requester})`,
    };
  }
  // ⛔⛔ THE WIZARD OWNS A PHONE STANDING ON ITS OWN NETWORK (Izzy, 2026-09-15, verbatim:
  // "They run the desktop wizard, the desktop wizard gets priority, and anything else is
  // deleted. That phone belongs to the wizard."). A live registration by a DIFFERENT device
  // stops blocking the release: removing a MAC's record never touches another device's
  // registration, and the halt it used to cause stranded a run on "Support needs to finish"
  // over a provably stale record (lived 2026-09-15: a GXP2170 standing factory-reset in the
  // requesting customer's house, refused because the OTHER tenant's real phone was registered
  // at the extension the stale record named). Two fences survive, both proof-of-presence:
  //   1. the office machine must have SEEN the handset on the customer's LAN — the presence
  //      pair (discoveredIp AND requesterIp). Without both, nothing distinguishes the wizard
  //      from a forged report naming another company's hardware address.
  //   2. no live registration may look like THIS handset alive ELSEWHERE: its LAN address in
  //      a contact registered from a different public address is the forger shape and refuses.
  if (!discovered || !requester) {
    return {
      allow: false,
      why: `${strangers[0].endpoint} has live registrations and the handset's presence on the requesting network is unproven`,
    };
  }
  const imposter = live.find((r) => {
    const { publicHost, lanHost } = contactAddresses(r.contactUri);
    return lanHost !== null && lanHost === discovered && publicHost !== requester;
  });
  if (imposter) {
    return {
      allow: false,
      why: `${imposter.endpoint} shows this handset's own address live from another network (${imposter.contactUri ?? "no contact address"}) — a claim from elsewhere never takes it`,
    };
  }
  const kept = strangers.map((r) => String(r.endpoint));
  return {
    allow: true,
    why: `released while ${kept.join(", ")} stays live: those registrations are other devices and are untouched, and this handset is standing on the requesting customer's own network (${discovered} behind ${requester})`,
    releasedOverLive: kept,
  };
}
