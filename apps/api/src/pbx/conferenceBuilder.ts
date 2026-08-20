/**
 * Conference rooms on VitalPBX, by panel replay.
 *
 * There is no REST create for conferences on this PBX (the registry exposes
 * only conferences.list / conferences.get, both reads), so — exactly like ring
 * groups and queues in teamBuilder.ts — a room is made by replaying the
 * panel's own "Add Conference" save from a robot session.
 *
 * ⛔ Unlike teamBuilder, this module does NOT hardcode a captured field list:
 * no panel session for the conferences module was ever recorded (zero
 * conference rooms exist platform-wide as of 2026-08-20). Instead it loads the
 * panel's own rendered form and re-posts it with overrides applied — the
 * pbxConsole discipline, where the form the panel renders IS the contract.
 * That keeps THE CHECKBOX RULE safe automatically: an option that the form
 * renders as a checkbox is expressed by adding/removing its pair, never by
 * sending `foo=no` (which TICKS it), and an option the form renders as a
 * select carries its literal yes/no. We cannot know which is which without
 * asking the form, which is exactly why guessing is forbidden here.
 *
 * ⛔ If the panel does not return a usable add form, every write REFUSES —
 * `conference_form_unavailable` / `conference_form_mismatch` name what came
 * back so the first live run diagnoses itself. Nothing is ever posted from a
 * guessed field list.
 *
 * ⛔ This module NEVER calls Apply Changes. Whether a save is applied (and the
 * Connect doorway re-baked afterwards) is the ROUTE's decision — see
 * conferenceRoutes.ts, which reuses pbxConsole's applyAndRebake for it.
 */

import { assertSaved, PanelStepError, type PanelSession } from "../onboarding/panelClient";
import { applyOverrides, loadParsedForm, type FormOverrides, type ParsedForm } from "../pbxConsole/panelForm";
import { panelDelete } from "../pbxConsole/pbxConsoleWrites";

export type ConferenceSpec = {
  name: string;
  /** Dial-in number inside the tenant (already validated + allocated by the route). */
  extension: string;
  userPin?: string | null;
  adminPin?: string | null;
  maxMembers?: number | null;
  recordConference?: boolean;
  startMuted?: boolean;
  quiet?: boolean;
  announceUserCount?: boolean;
  announceJoinLeave?: boolean;
  musicOnHoldWhenEmpty?: boolean;
  waitForAdmin?: boolean;
  endWhenAdminLeaves?: boolean;
};

export type ConferenceEditSpec = Partial<Omit<ConferenceSpec, "extension">>;

export type ConferenceWriteResult = {
  ok: true;
  extension: string;
  /**
   * Option fields the rendered form did not offer, so they were left at the
   * panel's defaults. Surfaced (and logged by the route) rather than silently
   * dropped — a "start muted" switch that never reaches the PBX must not look
   * like it worked.
   */
  skippedFields: string[];
  /** Deliberately literal: nothing here fires Apply Changes. */
  applied: false;
};

/**
 * The panel field each spec option targets. These names mirror the
 * `ombu_conferences` columns (read from the live PBX 2026-08-20); the form is
 * still the authority — a name absent from the rendered form lands in
 * `skippedFields`, never in a blind post.
 */
const OPTION_FIELDS: Array<{ field: string; get: (s: ConferenceSpec | ConferenceEditSpec) => boolean | undefined }> = [
  { field: "record_conference", get: (s) => s.recordConference },
  { field: "startmuted", get: (s) => s.startMuted },
  { field: "quiet", get: (s) => s.quiet },
  { field: "announce_user_count", get: (s) => s.announceUserCount },
  { field: "announce_join_leave", get: (s) => s.announceJoinLeave },
  { field: "music_on_hold_when_empty", get: (s) => s.musicOnHoldWhenEmpty },
  { field: "wait_marked", get: (s) => s.waitForAdmin },
  { field: "end_marked", get: (s) => s.endWhenAdminLeaves },
];

const hasField = (form: ParsedForm, name: string): boolean =>
  name in form.values || name in form.checks || name in form.multi;

/**
 * Build the overrides for one spec against one parsed form, routing every
 * yes/no option through the control type the form actually renders.
 */
export function buildConferenceOverrides(
  form: ParsedForm,
  spec: ConferenceSpec | ConferenceEditSpec,
  opts: { includeExtension: boolean },
): { overrides: FormOverrides; skippedFields: string[] } {
  const set: Record<string, string> = {};
  const checks: Record<string, boolean> = {};
  const skippedFields: string[] = [];

  const setScalar = (field: string, value: string | undefined | null) => {
    if (value == null) return;
    if (!hasField(form, field)) {
      skippedFields.push(field);
      return;
    }
    set[field] = value;
  };

  if (opts.includeExtension && "extension" in spec && (spec as ConferenceSpec).extension != null) {
    // `extension` must exist on the form — a save that silently drops the room
    // number would create a room nobody can dial. Checked by the caller.
    set["extension"] = String((spec as ConferenceSpec).extension);
  }
  setScalar("description", spec.name != null ? String(spec.name) : undefined);
  // A cleared PIN is an EMPTY string, not an omitted field — omitting keeps
  // the old PIN on edit, which is right for "I didn't touch it" (undefined)
  // and wrong for "remove the PIN" (null).
  if (spec.userPin !== undefined) setScalar("userpin", spec.userPin == null ? "" : String(spec.userPin));
  if (spec.adminPin !== undefined) setScalar("adminpin", spec.adminPin == null ? "" : String(spec.adminPin));
  if (spec.maxMembers !== undefined) {
    // Blank = unlimited; the panel's numeric fields take "" for unset, never "0"
    // forced in (the teamBuilder numField rule).
    setScalar("max_members", spec.maxMembers == null ? "" : String(spec.maxMembers));
  }

  for (const opt of OPTION_FIELDS) {
    const want = opt.get(spec);
    if (want === undefined) continue; // not touched — keep whatever the form has
    if (opt.field in form.checks) {
      checks[opt.field] = want; // checkbox: off = pair REMOVED (applyOverrides enforces it)
    } else if (opt.field in form.values) {
      set[opt.field] = want ? "yes" : "no"; // select/radio: carries a literal value
    } else {
      skippedFields.push(opt.field);
    }
  }

  return { overrides: { set, checks }, skippedFields };
}

function ensureEnvelope(pairs: Array<[string, string]>, mode: "add" | "edit", csrf: string | null): Array<[string, string]> {
  const out: Array<[string, string]> = pairs.map(([k, v]) => [k, v]);
  const upsert = (k: string, v: string) => {
    const i = out.findIndex(([n]) => n === k);
    if (i >= 0) out[i] = [k, v];
    else out.push([k, v]);
  };
  upsert("class", "conferences");
  upsert("method", "put");
  upsert("mode", mode);
  if (csrf) upsert("csfr_token", csrf);
  return out;
}

function assertUsableForm(step: string, form: ParsedForm, raw: string): void {
  if (form.order.length === 0) {
    throw new PanelStepError(step, `conference_form_unavailable: the panel returned no form (${raw.slice(0, 160)})`);
  }
  for (const essential of ["extension", "description"]) {
    if (!hasField(form, essential)) {
      throw new PanelStepError(
        step,
        `conference_form_mismatch: the panel's conference form has no "${essential}" field — fields offered: ${form.order.slice(0, 40).join(", ")}`,
      );
    }
  }
}

/** Create a conference room in the session's CURRENT tenant context. */
export async function createConference(session: PanelSession, spec: ConferenceSpec): Promise<ConferenceWriteResult> {
  const step = `create conference ${spec.extension}`;
  const csrf = await session.ensureCsrf("conferences");
  if (!csrf) throw new PanelStepError(step, "csrf_token_unavailable");
  const { html, form } = await loadParsedForm(session, "conferences", "add");
  assertUsableForm(step, form, html);

  const { overrides, skippedFields } = buildConferenceOverrides(form, spec, { includeExtension: true });
  const pairs = ensureEnvelope(applyOverrides(form, overrides), "add", csrf);
  assertSaved(step, await session.post(pairs));
  return { ok: true, extension: spec.extension, skippedFields, applied: false };
}

/** Edit an existing room by its panel row id (resolved server-side by the route). */
export async function updateConference(
  session: PanelSession,
  panelRowId: string,
  extension: string,
  spec: ConferenceEditSpec,
): Promise<ConferenceWriteResult> {
  const step = `update conference ${extension}`;
  const csrf = await session.ensureCsrf("conferences");
  if (!csrf) throw new PanelStepError(step, "csrf_token_unavailable");
  const { html, form } = await loadParsedForm(session, "conferences", "edit", panelRowId);
  assertUsableForm(step, form, html);

  const { overrides, skippedFields } = buildConferenceOverrides(form, spec, { includeExtension: false });
  const pairs = ensureEnvelope(applyOverrides(form, overrides), "edit", csrf);
  assertSaved(step, await session.post(pairs));
  return { ok: true, extension, skippedFields, applied: false };
}

/**
 * Delete a room. The panel's two-step confirmation (a single-step delete
 * answers "success" and deletes NOTHING) — reuses pbxConsole's generic
 * panelDelete. The route verifies GONE by re-reading ombu_conferences.
 */
export async function deleteConference(session: PanelSession, panelRowId: string, label: string): Promise<void> {
  await panelDelete(session, "conferences", panelRowId, label);
}
