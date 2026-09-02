/**
 * Queueing the voicemail email.
 *
 * ⛔ THE OUTBOX IS `EmailJob`, DELIBERATELY. The pre-existing voicemail-email
 * design stamped `emailedAt` after processing a message "sent, skipped, OR
 * FAILED", and only ever looked at messages received in the last 30 minutes. So
 * one failure meant that voicemail aged out of the window and was never retried
 * — silently, forever. That is exactly the failure Izzy said must never happen,
 * so this does not reuse it.
 *
 * Instead: we hand the message to `EmailJob`, which has real retry
 * (`attempts` / `maxAttempts` / `nextRunAt`), and stamp `emailedAt` ONLY once it
 * is safely in that outbox. From then on the retry belongs to the send door, and
 * the watchdog reconciles anything the outbox gives up on.
 */
import {
  decideVoicemailEmail,
  type VoicemailEmailSkipReason,
} from "./voicemailEmail";
import { voicemailEmail } from "./voicemailEmailTemplate";

export const VOICEMAIL_EMAIL_TYPE = "VOICEMAIL_NOTIFICATION";

/** Master switch. Off by default so deploying the code changes nothing. */
export function voicemailEmailEnabled(): boolean {
  return String(process.env.VOICEMAIL_EMAIL_ENABLED || "").trim() === "1";
}

/**
 * Tenants Connect must NOT email, because the PBX is still emailing them.
 * ⛔ Both must never be on for the same tenant, or that customer gets two emails
 * per voicemail.
 *
 * ✅ EMPTY IN PRODUCTION SINCE 2026-09-02. Gesheft was the last hold-back and is
 * now cut over to Connect, so NO tenant is excluded and the PBX emails nobody.
 * ⛔⛔ Before you ever add a tenant back to this list, or take one off it, read
 * the backlog trap in buildVoicemailSweepWhere below — an excluded tenant's
 * voicemails are never stamped, so un-excluding one with a backlog emails every
 * message in the 7-day window at once (334 rows for Gesheft, which is why they
 * were stamped `predates_feature` before the switch was flipped).
 */
export function voicemailEmailExcludedTenantIds(): Set<string> {
  return new Set(
    String(process.env.VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export type PendingVoicemail = {
  id: string;
  tenantId: string | null;
  extension: string;
  callerName: string | null;
  callerNumber: string | null;
  durationSec: number | null;
  receivedAt: Date | null;
  transcript: string | null;
  transcriptLanguage: string | null;
  localAudioPath: string | null;
  audioGoneAt: Date | null;
  emailedAt: Date | null;
};

export type ExtensionEmailConfig = {
  id: string;
  displayName: string | null;
  pbxUserEmail: string | null;
  vmEmailEnabled: boolean;
  extraRecipients: string[];
  /**
   * The company that owns this mailbox — the email's footer names them.
   *
   * ⛔ It rides the EXTENSION lookup, not a second query, because that lookup is
   * already scoped to `vm.tenantId`: the name can therefore only ever be the
   * tenant the voicemail actually belongs to. A separate fetch keyed on some
   * other id is exactly how one customer's name ends up on another customer's
   * email. `null` is a legitimate answer and renders "your organization".
   */
  tenantName: string | null;
};

export type VoicemailSendOutcome =
  | { queued: true; voicemailId: string; recipients: string[] }
  | { queued: false; voicemailId: string; reason: VoicemailEmailSkipReason | "excluded_tenant" | "unknown_extension" };

export type VoicemailSenderDeps = {
  /** Extension config for a mailbox, or null when we cannot identify it. */
  loadExtension: (tenantId: string, extension: string) => Promise<ExtensionEmailConfig | null>;
  queueEmail: (params: {
    tenantId: string;
    type: string;
    toEmail: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }) => Promise<unknown>;
  /** Stamp the voicemail so it is never queued twice. */
  markProcessed: (voicemailId: string, skipReason: string | null) => Promise<unknown>;
  now?: () => Date;
};

/** "Sat, Aug 16 at 2:15 PM" — how a person would say it, not an ISO stamp. */
export function formatReceivedAt(d: Date | null | undefined, timeZone = "America/New_York"): string {
  if (!d) return "Unknown time";
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZone,
    }).format(d).replace(/,([^,]*)$/, " at$1");
  } catch {
    return d.toISOString();
  }
}

/**
 * Decide and queue one voicemail. Always resolves to an outcome, and always
 * stamps the voicemail — there is no path that leaves a message in limbo.
 */
export async function processVoicemailForEmail(
  vm: PendingVoicemail,
  deps: VoicemailSenderDeps,
): Promise<VoicemailSendOutcome> {
  const excluded = voicemailEmailExcludedTenantIds();

  if (!vm.tenantId || excluded.has(vm.tenantId)) {
    // ⛔ Do NOT stamp. An excluded tenant must remain eligible the moment it is
    // un-excluded; stamping here would permanently skip every message sent
    // during the hold-back.
    return { queued: false, voicemailId: vm.id, reason: "excluded_tenant" };
  }

  const ext = await deps.loadExtension(vm.tenantId, vm.extension);
  if (!ext) {
    // Same reasoning: an unmatched mailbox is a data gap, not a decision.
    return { queued: false, voicemailId: vm.id, reason: "unknown_extension" };
  }

  const decision = decideVoicemailEmail({
    pbxUserEmail: ext.pbxUserEmail,
    extraRecipients: ext.extraRecipients,
    vmEmailEnabled: ext.vmEmailEnabled,
    durationSec: vm.durationSec,
    // ⛔ Audio must be present AND not proven gone.
    hasAudio: Boolean(vm.localAudioPath) && !vm.audioGoneAt,
    emailedAt: vm.emailedAt,
    // ⛔ Load-bearing: without it every missing-audio voicemail ages as
    // "unknown" and is stamped `no_recording` on the spot — the exact race
    // this guards against.
    receivedAt: vm.receivedAt,
  });

  if (!decision.send) {
    // ⛔ A retry decision is NOT stamped: the audio copy is still in flight and
    // the next sweep must be allowed to judge it again. Same reasoning as
    // `excluded_tenant` above — a stamp here is permanent and would be wrong.
    // The window is bounded (AUDIO_ARRIVAL_GRACE_MS), so the row cannot sit
    // unstamped and block the sweep's ascending batch.
    if (decision.retry) {
      return { queued: false, voicemailId: vm.id, reason: decision.reason };
    }
    await deps.markProcessed(vm.id, decision.reason);
    return { queued: false, voicemailId: vm.id, reason: decision.reason };
  }

  const built = voicemailEmail({
    voicemailId: vm.id,
    callerName: vm.callerName,
    callerNumber: vm.callerNumber,
    extension: vm.extension,
    extensionName: ext.displayName,
    durationSec: vm.durationSec,
    receivedAtLabel: formatReceivedAt(vm.receivedAt),
    transcript: vm.transcript,
    transcriptLanguage: vm.transcriptLanguage,
    // Named for the message, so a mailbox full of these is still navigable.
    attachmentName: `voicemail-${(vm.receivedAt || new Date()).toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2")}.mp3`,
    organizationName: ext.tenantName,
  });

  // The send door splits `toEmail` on commas, so several recipients ride one job
  // and therefore one retry ladder — nobody gets it twice on a retry.
  await deps.queueEmail({
    tenantId: vm.tenantId,
    type: VOICEMAIL_EMAIL_TYPE,
    toEmail: decision.recipients.join(","),
    subject: built.subject,
    htmlBody: built.html,
    textBody: built.text,
  });

  // ⛔ Stamped only AFTER the job exists. If queueEmail throws, the voicemail is
  // untouched and the next sweep tries again.
  await deps.markProcessed(vm.id, null);
  return { queued: true, voicemailId: vm.id, recipients: decision.recipients };
}
