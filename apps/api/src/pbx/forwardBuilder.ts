// ── Forwarding a menu key to an outside phone number ─────────────────────────
//
// There is no API for this. It is two panel saves, REPLAYED from a capture of
// Izzy's own browser session (2026-08-06) — nothing here is guessed:
//
//   1. Custom Destination — holds the outside number and dials it.
//   2. Custom Application — an internal number (2000–2099) that answers and
//      hands the call to that destination.
//
// Verified in the generated dialplan afterwards:
//   T2_app-custom-application,2000,1
//     → Goto(T2_app-custom-destination,custom-dest-6,1)
//       → Goto(T2_cos-all,5622096644,1)
//
// Why the two-step shape rather than dialling the number straight from the IVR:
// VitalPBX reaches the outside world by Goto-ing cos-all with the number as the
// extension, and the Custom Destination is what sets the call up correctly on
// the way (answer, caller ID, class of service). It is also reusable — the same
// pair is what customer-facing call forwarding will sit on.
//
// ⛔ cid_name / cid_number are sent EMPTY, deliberately (confirmed by Izzy
//    2026-08-06). Empty means the far end sees the OUTBOUND ROUTE's caller ID —
//    the system's own number. That is the point: a customer must never be able
//    to make calls appear to come from a number they don't own. Do not "fix"
//    this by filling in the tenant's DID, and never expose a caller-ID field
//    for forwards.
//
// ⛔ This module NEVER calls Apply Changes. `generateConfigurations` regenerates
//    the whole PBX and is Izzy's click, always.

import { PanelSession, assertSaved, decodeEntities } from "../onboarding/panelClient";
import { nextForwardExtension, type UsedNumbers } from "@connect/shared";

/**
 * The destination CATEGORY that means "Custom Destinations" in the panel's
 * two-step destination picker.
 *
 * ⛔ In the recording BOTH `mod_dest` and `destination` were 6 — a coincidence
 * (category 6, custom_destination_id 6). Neither is what gets stored: the panel
 * resolves the pair into an `ombu_destinations` row and stores THAT id. So this
 * constant is never trusted blindly — `resolveDestinationId` below asks the
 * panel for the category's contents and refuses if our destination isn't in
 * them, which fails loudly instead of building a forward that goes nowhere.
 */
const CUSTOM_DESTINATION_CATEGORY = "6";

export interface ForwardSpec {
  /** Shown in the PBX panel on both rows. */
  description: string;
  /** The outside number to ring, digits only. */
  phoneNumber: string;
  /** Skip allocation and use this internal number. */
  extension?: string;
}

export interface ForwardCreateResult {
  ok: true;
  /** The internal number a menu key points at. */
  extension: string;
  phoneNumber: string;
  description: string;
  /** ombu_custom_destinations row id. */
  customDestinationId: string;
  applied: false;
  note: string;
}

const NOT_APPLIED =
  "Created on the phone system but NOT yet live — it starts working when Apply Changes is pressed on the PBX.";

function form(fields: Array<[string, string]>): FormData {
  // The global FormData, deliberately — `undici` is not a declared dependency
  // of apps/api and importing it killed the container on boot once already.
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  return fd;
}

/** Digits only. The panel stores what it is given, and a number with dashes in
 *  it lands in the dialplan verbatim and never connects. */
export function normaliseForwardNumber(raw: string): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  if (d.length === 10) return d;
  // Anything else (short codes, international) is not something we can promise
  // works on this dial plan, so refuse rather than create a dead forward.
  return null;
}

/**
 * Pull the outside number back out of a description we wrote.
 *
 * Custom Applications only carry an internal number and a description, so for
 * forwards Connect created the number is recovered from the name it chose.
 * Anything else (a Custom Application built by hand in the panel) simply has no
 * number to show, and is described by its own name instead of being guessed at.
 */
export function phoneFromDescription(description: string): string | null {
  const m = String(description ?? "").match(/\(?(\d{3})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})\b/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

/**
 * Ask the panel what sits in the Custom Destinations category and find the row
 * we just made, by name.
 *
 * This is also the check that `CUSTOM_DESTINATION_CATEGORY` is still right: if
 * the category ever moves, our description won't be in the list and we refuse
 * — rather than filing the forward against whatever category 6 has become.
 */
async function resolveDestinationId(session: PanelSession, description: string): Promise<string | null> {
  const { json } = await session.post([
    ["class", "custom_app"],
    ["method", "getDestinationChildOptions"],
    ["mode", "view"],
    ["data[parent]", "custom_app-mod_dest"],
    ["data[child]", "custom_app-destination"],
    ["data[selected]", CUSTOM_DESTINATION_CATEGORY],
  ]);
  const options: Array<{ content?: string; value?: string | number }> = json?.options ?? [];
  const want = description.trim().toLowerCase();
  const hits = options
    .filter((o) => decodeEntities(String(o.content ?? "")).trim().toLowerCase() === want)
    .map((o) => String(o.value ?? ""))
    .filter(Boolean);
  if (hits.length === 0) return null;
  // Ids increment, so the newest match is ours if a name was ever reused.
  return hits.sort((a, b) => Number(b) - Number(a))[0];
}

/**
 * Create the destination + the internal number that reaches it.
 *
 * Ordering matters: the destination must exist before the application can point
 * at it. If the second save fails the destination is left behind — harmless (it
 * routes nothing on its own) but reported, so it can be cleaned up rather than
 * silently accumulating.
 */
export async function createForward(
  session: PanelSession,
  spec: ForwardSpec,
  used: UsedNumbers,
  existingForwards: string[],
): Promise<ForwardCreateResult> {
  const number = normaliseForwardNumber(spec.phoneNumber);
  if (!number) throw new Error("bad_phone_number");

  const extension = spec.extension?.trim() || nextForwardExtension(used, existingForwards);
  if (!extension) throw new Error("no_free_forward_number");

  const description = spec.description.trim().slice(0, 60);

  // ── 1. the outside number ────────────────────────────────────────────────
  const destCsrf = await session.ensureCsrf("custom_dest");
  if (!destCsrf) throw new Error("csrf_token_unavailable");
  const destRes = await session.postForm(
    form([
      ["class", "custom_dest"],
      ["method", "put"],
      ["mode", "add"],
      ["csfr_token", destCsrf],
      ["description", description],
      ["destination", number],
      // EMPTY ON PURPOSE — see the caller-ID note at the top of this file.
      ["cid_name", ""],
      ["cid_number", ""],
      ["class_of_service_id", "2"],
    ]),
  );
  assertSaved(`create forward destination ${description}`, destRes);

  const customDestinationId = await resolveDestinationId(session, description);
  if (!customDestinationId) {
    throw new Error("destination_not_found_after_create");
  }

  // ── 2. the internal number that reaches it ───────────────────────────────
  const appCsrf = await session.ensureCsrf("custom_app");
  if (!appCsrf) throw new Error("csrf_token_unavailable");
  const appRes = await session.postForm(
    form([
      ["class", "custom_app"],
      ["method", "put"],
      ["mode", "add"],
      ["csfr_token", appCsrf],
      ["extension", extension],
      ["description", description],
      ["status", "1"],
      ["mod_dest", CUSTOM_DESTINATION_CATEGORY],
      ["destination", customDestinationId],
    ]),
  );
  try {
    assertSaved(`create forward extension ${extension}`, appRes);
  } catch (err: any) {
    const e = new Error(`${err?.message || err} (orphan_custom_destination=${customDestinationId})`);
    (e as any).orphanDestinationId = customDestinationId;
    throw e;
  }

  return {
    ok: true,
    extension,
    phoneNumber: number,
    description,
    customDestinationId,
    applied: false,
    note: NOT_APPLIED,
  };
}
