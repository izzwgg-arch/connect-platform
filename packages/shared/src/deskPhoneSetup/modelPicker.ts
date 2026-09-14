/**
 * THE TWO DROPDOWNS: who makes this phone, and which one is it.
 *
 * ⛔⛔ WHY THIS EXISTS, AND IT IS THE CRITICAL PATH. `planProvisioningRecord` refuses a
 * phone whose model it cannot name — `model_unknown`, whose customer message has read
 * "Tell us the make and model on the back of this phone and we can set it up" since the
 * day it shipped, while there was NO WAY FOR ANYONE TO TELL US. A phone the fingerprint
 * could not read was therefore permanently unfinishable: no model, no catalogue row, no
 * `provisioning.devices` write, no PnP answer, and a handset asking into silence. These
 * two pickers are the answer to that sentence.
 *
 * ⛔ FED BY THE PBX'S OWN CATALOGUE, never a list typed here. A make or model we cannot
 * provision must not be offered, and one the PBX gains later must appear by itself. The
 * catalogue is generated from the phone system (`vendorCatalog.generated.ts`, 20 brands /
 * 427 models) and regenerating it is what updates these lists.
 *
 * ⛔⛔ AND THE ANSWER IS STORED AS THE CATALOGUE SPELLS IT, never as it arrived. What a
 * person picks is a label; what a phone reports is "SIP-T54W" or "sip t54w"; what the
 * record writer matches on is the catalogue's own `model`. Normalising at the boundary
 * is what stops two phones of the same kind being recorded as two different things.
 */
import {
  VENDOR_CATALOG,
  VENDOR_SLUGS,
  type VendorSlug,
  type CatalogModel,
} from "./vendorCatalog.generated";
import { findCatalogModel, vendorSlugFor, hasLocallyDrivableMechanism } from "./vendorAdapters";

/**
 * The value the pickers use for "I am not sure". ⛔ Deliberately not a brand slug and
 * deliberately not the empty string: "they have not answered yet" and "they told us they
 * do not know" are different facts, and only the second one may stop us asking again.
 */
export const PICKER_UNSURE = "unsure";

export type MakeOption = {
  /** The catalogue slug, which is what the row stores as `vendor`. */
  value: VendorSlug;
  /** The brand exactly as the phone system spells it. */
  label: string;
  /** How many models this make has, so a screen can say "20 models" rather than nothing. */
  modelCount: number;
};

export type ModelOption = {
  /** The catalogue's own spelling. ⛔ This is what gets stored, verbatim. */
  value: string;
  /** What the person reads. Carries the make when the list spans several. */
  label: string;
  make: VendorSlug;
  /**
   * False when the phone system has a catalogue row for this model and NO settings file
   * on disk for it, so a record could be written and would render nothing.
   * ⛔ Exactly one model in 427 is in this state (Gigaset P820 IP PRO). It is still
   * offered — a person must be able to find their phone in the list and be told the
   * truth about it, rather than hunt an option that is not there.
   */
  setupSupported: boolean;
  /**
   * False for the 31 models across four brands (Alcatel-Lucent, Dinstar, Nurivoice,
   * Hanyang) with no mechanism a computer on the office network can drive. The record is
   * still worth writing — it is what makes the phone system serve a config at all — but
   * nobody may be shown a progress bar for one.
   */
  drivableLocally: boolean;
};

/** Every make the phone system can provision, by name. */
export function makeOptions(): MakeOption[] {
  return VENDOR_SLUGS
    .map((slug) => ({
      value: slug,
      label: VENDOR_CATALOG[slug].displayName,
      modelCount: VENDOR_CATALOG[slug].models.length,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "en"));
}

function toOption(slug: VendorSlug, m: CatalogModel, withMake: boolean): ModelOption {
  return {
    value: m.model,
    label: withMake ? `${VENDOR_CATALOG[slug].displayName} ${m.model}` : m.model,
    make: slug,
    setupSupported: m.hasBaseTemplate,
    drivableLocally: hasLocallyDrivableMechanism(slug),
  };
}

/**
 * The models to offer.
 *
 * ⛔ A make that is chosen narrows the list to that make. A make that is NOT chosen — or
 * "I am not sure" — returns EVERY model, each carrying its brand in the label. That case
 * is real and it is the one the sticker drawing serves: a person who cannot find a brand
 * name on the front can almost always read a model off the label on the back, and the
 * model tells us the make by itself. Refusing to help them until they name a brand first
 * would be asking for the harder fact.
 *
 * ⛔ Sorted with `numeric` so T9 comes before T10 rather than after it — the catalogue is
 * full of numbered families and a plain string sort scatters them.
 */
export function modelOptionsFor(make: string | null | undefined): ModelOption[] {
  const slug = normaliseMake(make);
  const cmp = (a: ModelOption, b: ModelOption) =>
    a.label.localeCompare(b.label, "en", { numeric: true, sensitivity: "base" });

  if (slug) return VENDOR_CATALOG[slug].models.map((m) => toOption(slug, m, false)).sort(cmp);

  const all: ModelOption[] = [];
  for (const s of VENDOR_SLUGS) for (const m of VENDOR_CATALOG[s].models) all.push(toOption(s, m, true));
  return all.sort(cmp);
}

/** A make as a slug, or null for absent / unsure / anything we do not recognise. */
export function normaliseMake(make: string | null | undefined): VendorSlug | null {
  const raw = String(make ?? "").trim();
  if (!raw || raw.toLowerCase() === PICKER_UNSURE) return null;
  return vendorSlugFor(raw);
}

export type IdentifyRefusal =
  /** Nothing was picked. */
  | "model_missing"
  /** Picked something that is in no brand's catalogue. */
  | "model_not_in_catalogue"
  /** The model belongs to a different make than the one supplied. */
  | "make_disagrees";

export type IdentifyResult =
  | {
      ok: true;
      /** The catalogue slug. ⛔ Derived from the MODEL, which is the more specific fact. */
      vendor: VendorSlug;
      /** The catalogue's own spelling, which is what gets stored. */
      model: string;
      pbxModelId: number;
      setupSupported: boolean;
      drivableLocally: boolean;
    }
  | { ok: false; reason: IdentifyRefusal; message: string };

/**
 * Turn what somebody picked into something the record writer can use.
 *
 * ⛔⛔ THE MODEL DECIDES THE MAKE, NOT THE OTHER WAY ROUND. A model name is unique across
 * the whole catalogue and a brand name is not a fact about the handset in front of them —
 * so a person who gets the make wrong but the model right is still right, and we take the
 * model's word for it.
 *
 * ⛔ BUT A DISAGREEMENT IS REFUSED, NOT SILENTLY CORRECTED. Through the screen it cannot
 * happen (the model list is filtered by the make), so a disagreement arriving here is a
 * broken client or a forged request, and quietly re-homing a phone onto another brand is
 * the wrong way to find that out.
 *
 * ⛔ A model the catalogue does not hold is refused outright. A guessed model renders a
 * settings file the handset silently ignores, which on a desk looks exactly like a dead
 * phone — the single most expensive failure this whole feature can produce.
 */
export function identifyPhone(input: { make?: string | null; model?: string | null }): IdentifyResult {
  const text = String(input.model ?? "").trim();
  if (!text || text.toLowerCase() === PICKER_UNSURE) {
    return {
      ok: false,
      reason: "model_missing",
      message: "Pick the model printed on the label, and we will take it from there.",
    };
  }

  const found = findCatalogModel(text);
  if (!found) {
    return {
      ok: false,
      reason: "model_not_in_catalogue",
      message:
        "Loopcom does not know that model yet. Pick the closest one from the list, or leave it and " +
        "Loopcom Support will connect this phone for you.",
    };
  }

  const wanted = normaliseMake(input.make);
  if (wanted && wanted !== found.slug) {
    return {
      ok: false,
      reason: "make_disagrees",
      message: `That model is made by ${VENDOR_CATALOG[found.slug].displayName}, not ${VENDOR_CATALOG[wanted].displayName}. Pick the make first and the list will match it.`,
    };
  }

  return {
    ok: true,
    vendor: found.slug,
    model: found.model.model,
    pbxModelId: found.model.pbxModelId,
    setupSupported: found.model.hasBaseTemplate,
    drivableLocally: hasLocallyDrivableMechanism(found.slug),
  };
}

/**
 * Does this phone still need a person to say what it is?
 *
 * ⛔ True only when we genuinely cannot name it. A phone whose model came off its own
 * banner is already answered and must not be asked about — being asked to confirm
 * something the system plainly already knows reads as the wizard not paying attention.
 */
export function needsIdentifying(phone: { model?: string | null }): boolean {
  const text = String(phone.model ?? "").trim();
  if (!text) return true;
  return findCatalogModel(text) == null;
}
