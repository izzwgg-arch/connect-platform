/**
 * Voicemail-to-email, Connect side.
 *
 * ⛔ THE REQUIREMENT (Izzy, 2026-08-16): a voicemail email must never silently
 * fail to go out. "People really rely on me for this." Everything here is shaped
 * by that, so read the three rules before changing any of it.
 *
 * ── Rule 1: a decision is always recorded, never implied ────────────────────
 * Every voicemail resolves to exactly one `VoicemailEmailDecision`. There is no
 * path that quietly does nothing. "We deliberately did not send" and "we failed
 * to send" are different outcomes with different reasons, and the watchdog
 * treats them differently — a deliberate skip is not an alarm, a failure is.
 * ⛔ If you add a new early return, it MUST return a decision with a reason.
 *
 * ── Rule 2: never invent a recipient, never silently have none ──────────────
 * Recipients are the mailbox's own list in Connect (`VoicemailEmailRecipient`,
 * editable in Settings) plus whatever address the PBX still carries for it
 * (`Extension.pbxUserEmail`, a MIRROR of the PBX field). ⛔ Since the 2026-08-17
 * cutover the PBX field is BLANK for every tenant except Gesheft — blanking it
 * is how the PBX's own emailing was switched off — and the sync faithfully
 * mirrors that blank into Connect. So for a cut-over tenant `pbxUserEmail` is
 * null by design and `VoicemailEmailRecipient` is the ONLY source; on
 * 2026-08-18 the 55 addresses were restored into it from the PBX backup. Never
 * "fix" a null `pbxUserEmail` by putting the address back on the PBX (that
 * resumes duplicate emails) and never make the sync keep a stale one (then the
 * mirror lies). ⛔ We do NOT fall back to the owner's login email: for 7 live
 * extensions the two differ, and Gesheft 101's voicemail goes to a shared
 * `orders@` inbox rather than to the person who signs in. Substituting the login
 * address would silently move a customer's voicemail to a different human.
 * An extension with no address at all is a REPORTED state (`no_recipient`), not
 * a skip — 66 of 154 active extensions are in it today.
 *
 * ── Rule 3: no recording, no email ─────────────────────────────────────────
 * Izzy, 2026-08-16. The audio is the point; an email promising a recording that
 * isn't attached is worse than none. ⛔ And this must be judged on audio we
 * actually HAVE, never on a stored path — `Voicemail.localAudioPath` proves
 * intent, not existence, exactly like `ConnectCdr.recordingPath` did when 44% of
 * one customer's play buttons turned out to be dead.
 */

/** Why a voicemail did not produce an email. Every value is a state we can show. */
export type VoicemailEmailSkipReason =
  /** Deliberate: the extension's voicemail email is switched off. */
  | "disabled"
  /** Deliberate: audio is proven gone, so there is nothing to attach. */
  | "no_recording"
  /**
   * ⚠ NOT deliberate and NEVER stamped: the audio has not landed in the local
   * store YET. The caller must retry, not record this. See `AUDIO_ARRIVAL_GRACE_MS`.
   */
  | "awaiting_recording"
  /** Deliberate: too short to be a real message (hang-up). */
  | "too_short"
  /** ⚠ Reported, NOT deliberate: nobody is configured to receive it. */
  | "no_recipient"
  /** Deliberate: already handed to the outbox; never send twice. */
  | "already_queued";

export type VoicemailEmailDecision =
  | { send: true; recipients: string[] }
  | {
      send: false;
      reason: VoicemailEmailSkipReason;
      needsAttention: boolean;
      /**
       * ⛔ TRUE means "ask again later" — the caller must NOT stamp the voicemail.
       * Only `awaiting_recording` ever sets it, and only inside a bounded window,
       * because an unstamped row stays permanently eligible and permanently the
       * OLDEST, which is the 2026-08-18 head-of-line outage.
       */
      retry?: boolean;
    };

export type VoicemailEmailInput = {
  /** Address(es) an admin explicitly added for this extension. */
  extraRecipients?: Array<string | null | undefined>;
  /** The address the PBX already sends this mailbox's voicemail to. */
  pbxUserEmail?: string | null;
  /** Per-extension switch. */
  vmEmailEnabled?: boolean | null;
  /** Seconds. Hang-ups are not messages. */
  durationSec?: number | null;
  /** True only when audio actually exists and can be attached. */
  hasAudio: boolean;
  /** Set once the voicemail has been handed to the outbox. */
  emailedAt?: Date | null;
  /** When the voicemail arrived. Decides whether missing audio is still in flight. */
  receivedAt?: Date | null;
  /** Injectable clock, so the grace window is testable. */
  now?: Date;
};

/** Hang-up floor. 20% of voicemails are <= 1s; those are not messages. */
export const MIN_VOICEMAIL_SECONDS_FOR_EMAIL = 2;

/**
 * ⛔⛔ How long a just-arrived voicemail may still be missing its audio before
 * that becomes a FINAL `no_recording`.
 *
 * The arrival audio copy is fire-and-forget (`copyFreshVoicemailAudioToStore`,
 * an ~2 s HTTP fetch to the PBX helper) and the email sweep is an independent
 * 60-second timer. Nothing sequences them, so before this existed a sweep tick
 * landing inside that ~2 s window judged a perfectly good voicemail as having no
 * recording and stamped it FINAL. Measured over the week to 2026-08-27: the three
 * casualties were decided 0.2 s / 0.3 s / 0.7 s after their row was created,
 * where every other outcome averaged ~30 s — the decision ran before its input
 * existed. ~2 a week, and unrecoverable.
 *
 * ⛔ The value is bounded from BOTH ends and neither bound is arbitrary:
 *  - It must be comfortably ABOVE the ~2 s copy (5 minutes is ~150x headroom and
 *    survives a briefly wedged helper).
 *  - It MUST stay BELOW `NEVER_PROCESSED_GRACE_MS` (10 min, the watchdog's
 *    "the sender never reached this" threshold), or a voicemail legitimately
 *    waiting for its audio starts being reported as stranded.
 *  - It must be FINITE at all, or the row is never stamped, stays permanently
 *    eligible, is permanently the oldest, and fills the sweep's ascending batch
 *    of 50 forever — the 2026-08-18 outage, exactly.
 */
export const AUDIO_ARRIVAL_GRACE_MS = 5 * 60_000;

function normaliseEmail(value: unknown): string | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v || !v.includes("@") || v.startsWith("@") || v.endsWith("@")) return null;
  if (/\s/.test(v)) return null;
  return v;
}

/**
 * Every address that should receive this voicemail, de-duplicated, in a stable
 * order: the PBX address first (that is who gets it today), then admin additions.
 */
export function resolveVoicemailRecipients(input: {
  pbxUserEmail?: string | null;
  extraRecipients?: Array<string | null | undefined>;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const e = normaliseEmail(raw);
    if (!e || seen.has(e)) return;
    seen.add(e);
    out.push(e);
  };
  push(input.pbxUserEmail);
  for (const extra of input.extraRecipients || []) push(extra);
  return out;
}

/**
 * The single decision point. ⛔ Order matters and is deliberate: the cheap,
 * certain reasons are checked before the ones that need attention, so an
 * extension that is switched off never shows up as a missing-recipient alarm.
 */
export function decideVoicemailEmail(input: VoicemailEmailInput): VoicemailEmailDecision {
  if (input.emailedAt) return { send: false, reason: "already_queued", needsAttention: false };
  if (input.vmEmailEnabled === false) return { send: false, reason: "disabled", needsAttention: false };
  if (!input.hasAudio) {
    // ⛔ Missing audio on a JUST-ARRIVED voicemail is almost always the arrival
    // copy still in flight, not a missing recording. Ask again shortly rather
    // than writing a stamp that can never be taken back. Bounded — see
    // AUDIO_ARRIVAL_GRACE_MS for why it must be finite and under 10 minutes.
    // ⛔ A row with no `receivedAt` cannot be aged, so it takes the FINAL branch:
    // an unknown age must never buy an unbounded retry.
    const ageMs = input.receivedAt
      ? (input.now ?? new Date()).getTime() - input.receivedAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (ageMs >= 0 && ageMs < AUDIO_ARRIVAL_GRACE_MS) {
      return { send: false, reason: "awaiting_recording", needsAttention: false, retry: true };
    }
    return { send: false, reason: "no_recording", needsAttention: false };
  }

  const seconds = Number(input.durationSec ?? 0);
  if (seconds < MIN_VOICEMAIL_SECONDS_FOR_EMAIL) {
    return { send: false, reason: "too_short", needsAttention: false };
  }

  const recipients = resolveVoicemailRecipients(input);
  if (recipients.length === 0) {
    // ⚠ The only skip that is a problem. Surfaced, never swallowed.
    return { send: false, reason: "no_recipient", needsAttention: true };
  }
  return { send: true, recipients };
}

/**
 * Hebrew script reads right to left, and 72% of our transcripts are Yiddish.
 * ⛔ Judge by the stored `transcriptLanguage` ("yi" | "en" | "yi-en"), not by
 * sniffing characters — the field is populated by the engine that produced it.
 */
export function transcriptIsRtl(transcriptLanguage?: string | null): boolean {
  return String(transcriptLanguage || "").trim().toLowerCase().startsWith("yi");
}

/** Marker the send door reads to attach the recording. Mirrors the billing PDF pattern. */
export function voicemailEmailMarker(voicemailId: string): string {
  return `<!-- connect-voicemail:${voicemailId} -->`;
}

/** Recover the voicemail id from a queued job body, for attaching audio at send time. */
export function extractVoicemailIdFromEmailBody(body: string | null | undefined): string | null {
  const m = String(body || "").match(/connect-voicemail:([A-Za-z0-9_-]+)/);
  return m?.[1] || null;
}
