import { createHash } from "node:crypto";
import {
  getPbxVoicemailGreeting,
  resetPbxVoicemailGreeting,
  uploadPbxVoicemailGreeting,
  type PbxVoicemailGreetingResponse,
  type PbxVoicemailGreetingType,
} from "./pbxInboundRouteHelperClient";

/**
 * Connect has ONE voicemail greeting per extension, but Asterisk has two
 * (app_voicemail.c leave_voicemail): `VoiceMail(box,u)` plays unavail.wav and
 * `VoiceMail(box,b)` plays busy.wav — and when busy.wav is missing it plays the
 * stock "the person at extension N is on the phone" instead. The panel and the
 * mobile app only ever save the unavailable greeting, so any call that reached
 * voicemail because the extension was busy or declined skipped the customer's
 * recording (ticket 3GTH9M, Trust Bookkeepings ext 101, 2026-09-14).
 *
 * So saving the unavailable greeting also writes the same audio as busy.wav.
 *
 * ⛔ Never mirror to temp.wav: a temporary greeting overrides EVERY path,
 * including VitalPBX's flagless `VM-<ext>` destination ("voicemail, no
 * message"), which is a deliberate panel choice.
 * ⛔ A busy greeting that is NOT a copy of the previous unavailable one was set
 * on purpose (e.g. through the phone's voicemail menu) — it is never touched.
 */

type HelperCfg = Parameters<typeof getPbxVoicemailGreeting>[0];

export type GreetingMirrorDeps = {
  get: (
    cfg: HelperCfg,
    body: { tenantId: string; extension: string; greetingType: PbxVoicemailGreetingType; includeBytes?: boolean },
  ) => Promise<PbxVoicemailGreetingResponse>;
  upload: (
    cfg: HelperCfg,
    body: { tenantId: string; extension: string; greetingType: PbxVoicemailGreetingType; fileBaseName: string; sha256: string; bytesB64: string },
  ) => Promise<PbxVoicemailGreetingResponse>;
  reset: (
    cfg: HelperCfg,
    body: { tenantId: string; extension: string; greetingType: PbxVoicemailGreetingType },
  ) => Promise<PbxVoicemailGreetingResponse>;
};

export const pbxGreetingMirrorDeps: GreetingMirrorDeps = {
  get: getPbxVoicemailGreeting,
  upload: uploadPbxVoicemailGreeting,
  reset: resetPbxVoicemailGreeting,
};

function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
}

/** May Connect (re)write busy.wav? Only when there is none, or it is a copy of the greeting being replaced. */
export function busyGreetingIsOurs(
  busy: { active?: boolean; sha256?: string | null } | null | undefined,
  previousUnavailableSha: string | null | undefined,
): boolean {
  if (!busy?.active) return true;
  return sameSha(busy.sha256, previousUnavailableSha);
}

export async function readActiveGreetingSha(
  deps: GreetingMirrorDeps,
  cfg: HelperCfg,
  input: { tenantId: string; extension: string; greetingType: PbxVoicemailGreetingType },
): Promise<string | null> {
  try {
    const cur = await deps.get(cfg, { ...input, includeBytes: false });
    return cur?.active && cur.sha256 ? String(cur.sha256) : null;
  } catch {
    return null;
  }
}

export type BusyMirrorResult = {
  busyMirrored: boolean;
  busyMirrorReason: "created" | "replaced_previous_copy" | "already_mirrored" | "distinct_busy_greeting_kept" | "no_unavailable_greeting" | "error";
  busyMirrorError?: string;
};

/** Copy the extension's unavailable greeting to busy.wav. Never throws — the unavailable greeting is already saved. */
export async function mirrorUnavailableGreetingToBusy(
  deps: GreetingMirrorDeps,
  cfg: HelperCfg,
  input: { tenantId: string; extension: string; previousUnavailableSha: string | null; bytes?: Buffer },
): Promise<BusyMirrorResult> {
  const { tenantId, extension } = input;
  try {
    const busy = await deps.get(cfg, { tenantId, extension, greetingType: "busy", includeBytes: false });
    if (!busyGreetingIsOurs(busy, input.previousUnavailableSha)) {
      return { busyMirrored: false, busyMirrorReason: "distinct_busy_greeting_kept" };
    }
    let bytes = input.bytes;
    if (!bytes) {
      const cur = await deps.get(cfg, { tenantId, extension, greetingType: "unavailable", includeBytes: true });
      if (!cur?.active || !cur.bytesB64) return { busyMirrored: false, busyMirrorReason: "no_unavailable_greeting" };
      bytes = Buffer.from(cur.bytesB64, "base64");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (busy?.active && sameSha(busy.sha256, sha256)) {
      return { busyMirrored: false, busyMirrorReason: "already_mirrored" };
    }
    await deps.upload(cfg, { tenantId, extension, greetingType: "busy", fileBaseName: "busy", sha256, bytesB64: bytes.toString("base64") });
    return { busyMirrored: true, busyMirrorReason: busy?.active ? "replaced_previous_copy" : "created" };
  } catch (err: any) {
    return { busyMirrored: false, busyMirrorReason: "error", busyMirrorError: String(err?.message || err) };
  }
}

/**
 * Reset a greeting; for the unavailable one, also remove busy.wav when it is a
 * copy of it. The primary reset still throws exactly as before; the busy half never does.
 */
export async function resetGreetingWithBusyMirror(
  deps: GreetingMirrorDeps,
  cfg: HelperCfg,
  input: { tenantId: string; extension: string; greetingType: PbxVoicemailGreetingType },
): Promise<{ busyMirrorReset: boolean; busyMirrorError?: string }> {
  const { tenantId, extension, greetingType } = input;
  const unavailableSha = greetingType === "unavailable"
    ? await readActiveGreetingSha(deps, cfg, { tenantId, extension, greetingType })
    : null;
  await deps.reset(cfg, { tenantId, extension, greetingType });
  if (!unavailableSha) return { busyMirrorReset: false };
  try {
    const busy = await deps.get(cfg, { tenantId, extension, greetingType: "busy", includeBytes: false });
    if (!busy?.active || !sameSha(busy.sha256, unavailableSha)) return { busyMirrorReset: false };
    await deps.reset(cfg, { tenantId, extension, greetingType: "busy" });
    return { busyMirrorReset: true };
  } catch (err: any) {
    return { busyMirrorReset: false, busyMirrorError: String(err?.message || err) };
  }
}
