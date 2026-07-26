/**
 * Voicemail-to-email sender (agent poller).
 *
 * Mirrors the transcription job: it polls the DB for NEW voicemails and emails a
 * copy — recording attached — to the address on the mailbox's extension, when
 * that extension has "Email my voicemails" turned on.
 *
 * HARD BACKLOG GUARD — this can never blast the ~19k historical voicemails:
 *   • only rows with emailedAt == null are considered (each is stamped once), and
 *   • only rows whose receivedAt is inside a short fresh window (default 30 min).
 * The entire existing backlog has old receivedAt values, so it is out of scope
 * the moment this ships, regardless of the per-mailbox default being ON.
 *
 * Read-only toward the PBX (a GET of the recording via the portal stream
 * endpoint). Additive toward the DB (stamps emailedAt / emailError).
 */
import { createHmac } from "node:crypto";
import type { AuditLog } from "../audit/audit";
import type { Notifier } from "./notifier";
import { buildVoicemailEmail } from "./voicemailEmail";
import { vmSplitRingGroupPrefix } from "@connect/shared";

export interface VoicemailEmailJobDeps {
  prisma: any;
  audit: AuditLog;
  notifier: Notifier;
  /** Internal portal API base (docker net), e.g. http://api:3001. */
  apiBaseUrl: () => string | null;
  /** Same JWT_SECRET the portal API uses, to mint an internal token. */
  jwtSecret: () => string | null;
  /** Public portal base, e.g. https://app.connectcomunications.com — for the CTA. */
  portalUrl?: () => string | null;
  brandName?: string;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");

const MAX_BATCH = 6;
const FRESH_WINDOW_MIN = Number(process.env.VOICEMAIL_EMAIL_FRESH_WINDOW_MIN || 30) || 30;
// Give the transcription job a moment to finish before we send (so the typed-out
// message can ride along) — but never wait longer than this.
const TRANSCRIBE_GRACE_MIN = Number(process.env.VOICEMAIL_EMAIL_TRANSCRIBE_GRACE_MIN || 3) || 3;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

export class VoicemailEmailJob {
  private running = false;
  constructor(private deps: VoicemailEmailJobDeps) {}

  /** One polling pass. Returns how many voicemails were emailed. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = Date.now();
      const since = new Date(now - FRESH_WINDOW_MIN * 60_000);
      const rows = await this.deps.prisma.voicemail.findMany({
        where: {
          emailedAt: null,
          deletedAt: null,
          folder: { in: ["inbox", "urgent"] },
          receivedAt: { gte: since },
        },
        orderBy: { receivedAt: "asc" },
        take: MAX_BATCH,
        select: {
          id: true, tenantId: true, extension: true, callerName: true, callerNumber: true,
          durationSec: true, receivedAt: true, pbxRecfile: true,
          transcript: true, transcriptError: true,
        },
      });

      let sent = 0;
      for (const vm of rows) {
        try {
          const did = await this.processOne(vm, now);
          if (did) sent++;
        } catch (err) {
          // Transient error — leave emailedAt null so it retries next cycle while
          // still inside the fresh window, then naturally drops out of scope.
          await this.deps.audit.record({
            actor: "system",
            event: "voicemail.email_failed",
            payload: { id: vm.id, error: String(err).slice(0, 200) },
          });
        }
      }
      return sent;
    } finally {
      this.running = false;
    }
  }

  /** Stamp a voicemail as processed so it is never emailed again. */
  private async stamp(id: string, error: string | null): Promise<void> {
    await this.deps.prisma.voicemail
      .update({ where: { id }, data: { emailedAt: new Date(), emailError: error } })
      .catch(() => {});
  }

  /**
   * Returns true when an email was actually sent. Returns false (WITHOUT
   * stamping) when we are intentionally waiting — e.g. for the transcript to
   * land — so the next cycle retries.
   */
  private async processOne(
    vm: {
      id: string; tenantId: string | null; extension: string; callerName: string | null;
      callerNumber: string | null; durationSec: number; receivedAt: Date; pbxRecfile: string | null;
      transcript: string | null; transcriptError: string | null;
    },
    now: number,
  ): Promise<boolean> {
    // Resolve the mailbox extension → name, email address, and preferences.
    const ext = vm.tenantId
      ? await this.deps.prisma.extension.findFirst({
          where: { tenantId: vm.tenantId, extNumber: vm.extension },
          select: {
            displayName: true, extNumber: true, pbxUserEmail: true,
            vmEmailEnabled: true, vmEmailIncludeTranscript: true,
            ownerUser: { select: { email: true } },
          },
        })
      : null;

    if (!ext) {
      await this.stamp(vm.id, "no_extension");
      return false;
    }
    if (!ext.vmEmailEnabled) {
      await this.stamp(vm.id, "disabled");
      return false;
    }

    const recipient = (ext.pbxUserEmail?.trim() || ext.ownerUser?.email?.trim() || "").toLowerCase();
    if (!recipient) {
      await this.stamp(vm.id, "no_address");
      return false;
    }

    const includeTranscript = ext.vmEmailIncludeTranscript !== false;
    const ageMin = (now - new Date(vm.receivedAt).getTime()) / 60_000;

    // If the person wants the typed-out message and transcription hasn't finished
    // (and hasn't errored) yet, wait — up to the grace window — then send anyway.
    if (includeTranscript && !vm.transcript && !vm.transcriptError && ageMin < TRANSCRIBE_GRACE_MIN) {
      return false; // no stamp → retried next cycle
    }

    // Fetch the recording for the attachment (best-effort).
    let audio: Buffer | null = null;
    if (vm.pbxRecfile) {
      try {
        audio = await this.fetchAudio(vm.id);
      } catch {
        audio = null;
      }
    }

    const split = vmSplitRingGroupPrefix(vm.callerName);
    const dateStamp = new Date(vm.receivedAt).toISOString().slice(0, 10);
    const attachmentName = `voicemail-${dateStamp}.wav`;
    const portal = this.deps.portalUrl?.() || null;

    const { subject, html, text } = buildVoicemailEmail({
      recipientName: ext.displayName || `Extension ${ext.extNumber}`,
      extensionNumber: ext.extNumber,
      callerName: split.name || null,
      ringGroupPrefix: split.prefix,
      callerNumber: vm.callerNumber,
      durationSec: vm.durationSec,
      receivedAt: new Date(vm.receivedAt),
      transcript: includeTranscript ? vm.transcript : null,
      attachmentName,
      recordingAttached: !!audio,
      listenUrl: portal ? `${portal.replace(/\/$/, "")}/voicemail` : null,
      brandName: this.deps.brandName,
    });

    const res = await this.deps.notifier.send({
      kind: "voicemail",
      to: [recipient],
      subject,
      text,
      html,
      attachments: audio ? [{ filename: attachmentName, content: audio, contentType: "audio/wav" }] : undefined,
    });

    if (!res.sent) {
      // SMTP down / not configured — retry next cycle within the fresh window.
      return false;
    }

    await this.stamp(vm.id, null);
    await this.deps.audit.record({
      actor: "system",
      event: "voicemail.emailed",
      payload: {
        id: vm.id, to: recipient, ringGroup: split.prefix ?? undefined,
        withTranscript: includeTranscript && !!vm.transcript, withRecording: !!audio,
      },
    });
    return true;
  }

  /** Short-lived internal JWT the portal API accepts (SUPER_ADMIN, 5 min). */
  private mintToken(): string {
    const secret = this.deps.jwtSecret();
    if (!secret) throw new Error("no_jwt_secret");
    const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const nowS = Math.floor(Date.now() / 1000);
    const payload = b64url(
      Buffer.from(JSON.stringify({ sub: "agent-vm-email", tenantId: "", email: "agent@internal.connect", role: "SUPER_ADMIN", iat: nowS, exp: nowS + 300 })),
    );
    const sig = b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${sig}`;
  }

  /** Fetch the recording through the portal API's stream endpoint (wav). */
  private async fetchAudio(vmId: string): Promise<Buffer> {
    const base = this.deps.apiBaseUrl();
    if (!base) throw new Error("no_api_base_url");
    const token = this.mintToken();
    const url = `${base.replace(/\/$/, "")}/voice/voicemail/${encodeURIComponent(vmId)}/stream?raw=1&token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`audio_fetch_${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) throw new Error("audio_empty");
    if (buf.length > MAX_AUDIO_BYTES) throw new Error(`audio_too_large_${buf.length}`);
    return buf;
  }
}
