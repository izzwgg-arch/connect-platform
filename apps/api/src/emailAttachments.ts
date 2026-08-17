/**
 * emailAttachments.ts — general file attachments for `EmailJob`.
 *
 * The send pipeline could already attach things, but only ones it derives for
 * itself: `loadBillingPdfAttachmentsForEmailJob` renders the invoice PDF and
 * `loadVoicemailAudioAttachment` fetches the recording. There was no way to say
 * "send this email with this file on it", which is why handing a customer a
 * WireGuard config meant sending it from a personal mailbox.
 *
 * ⛔ THE BYTES LIVE IN THE ROW, NOT ON DISK — deliberately.
 * A path-on-disk attachment would need a mounted volume in BOTH api compose
 * blocks, and getting that wrong is silent data loss that only shows up at the
 * next deploy (see AGENT_HANDOFF_ONBOARDING_UPLOADS_VOLUME). An `EmailJob` row
 * is also kept forever as the audit trail, so the attachment stays with the
 * evidence of the send. The cost is row size, which is what the caps below are
 * for: this slot is for configs, QR codes and small documents — never bulk
 * media.
 *
 * ⛔ A DECLARED ATTACHMENT THAT WILL NOT DECODE FAILS THE SEND.
 * The two derived loaders swallow their errors (`.catch(() => [])`) because a
 * billing PDF can be regenerated and the email still has a job to do. These are
 * different: the file IS the point of the email. Quietly delivering "here are
 * your connection files" with nothing attached is worse than not sending, so
 * `loadJobAttachments` throws and lets the job retry and then fail visibly.
 */

/** Per-file ceiling, on the DECODED bytes. */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
/** Ceiling across all files on one email, on the DECODED bytes. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 5;

export type EmailAttachmentInput = {
  filename: string;
  /** Defaults to application/octet-stream, which every mail client can save. */
  contentType?: string;
  content: Buffer | Uint8Array;
};

/** Shape persisted in `EmailJob.attachments` (JSON). */
export type StoredEmailAttachment = {
  filename: string;
  contentType: string;
  contentBase64: string;
};

/** Shape both send paths hand to nodemailer / SendGrid. */
export type LoadedEmailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

export class EmailAttachmentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "EmailAttachmentError";
  }
}

/**
 * A filename is a LABEL, never a path. Directory separators, traversal and
 * control characters are stripped rather than rejected, so a caller passing a
 * full path still gets a sane attachment instead of an error they must handle.
 */
export function sanitizeAttachmentFilename(raw: string): string {
  // Control characters are removed by code point rather than by regex: the
  // escapes this needs are exactly the ones that get mangled when a file is
  // written through a shell, and a silently broken class here would strip
  // ordinary characters out of customers’ filenames.
  const printable = Array.from(String(raw ?? ""))
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
  const base = printable
    .split("\\").join(" ")   // no directories: a filename is a label, not a path
    .split("/").join(" ")
    .replace(/\s+/g, " ")
    // Leading dots and spaces come off LAST and repeatedly. "../../secret.key"
    // becomes ".. .. secret.key" once the slashes are gone, so a single
    // strip-leading-dots pass would leave ".. secret.key" behind.
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);
  return base || "attachment";
}

/** Validate + encode for storage. Throws `EmailAttachmentError` on violation. */
export function buildEmailAttachments(inputs: EmailAttachmentInput[]): StoredEmailAttachment[] {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  if (inputs.length > MAX_ATTACHMENT_COUNT) {
    throw new EmailAttachmentError(
      "too_many_attachments",
      `An email can carry at most ${MAX_ATTACHMENT_COUNT} files; ${inputs.length} were given.`,
    );
  }

  let total = 0;
  const out: StoredEmailAttachment[] = [];
  for (const input of inputs) {
    const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content ?? []);
    const filename = sanitizeAttachmentFilename(input.filename);
    if (content.length === 0) {
      throw new EmailAttachmentError("empty_attachment", `"${filename}" is empty — nothing to attach.`);
    }
    if (content.length > MAX_ATTACHMENT_BYTES) {
      throw new EmailAttachmentError(
        "attachment_too_large",
        `"${filename}" is ${(content.length / 1024 / 1024).toFixed(1)} MB; the limit for one file is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      );
    }
    total += content.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new EmailAttachmentError(
        "attachments_too_large",
        `Those files come to more than the ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB an email can carry.`,
      );
    }
    out.push({
      filename,
      contentType: String(input.contentType || "application/octet-stream").slice(0, 120),
      contentBase64: content.toString("base64"),
    });
  }
  return out;
}

/**
 * Decode what was stored, for the send paths.
 * ⛔ Throws rather than dropping — see the header. A row whose attachments are
 * unreadable must not be delivered as a bare email.
 */
export function loadJobAttachments(job: { attachments?: unknown; id?: string }): LoadedEmailAttachment[] {
  const raw = job?.attachments;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : null;
  if (!list) {
    throw new EmailAttachmentError("attachments_malformed", `EmailJob ${job?.id ?? "?"}: attachments is not a list.`);
  }
  if (list.length === 0) return [];
  return list.map((entry: any, i: number) => {
    const filename = sanitizeAttachmentFilename(entry?.filename);
    const b64 = entry?.contentBase64;
    if (typeof b64 !== "string" || b64.length === 0) {
      throw new EmailAttachmentError(
        "attachment_content_missing",
        `EmailJob ${job?.id ?? "?"}: attachment ${i + 1} ("${filename}") has no content.`,
      );
    }
    const content = Buffer.from(b64, "base64");
    if (content.length === 0) {
      throw new EmailAttachmentError(
        "attachment_content_unreadable",
        `EmailJob ${job?.id ?? "?"}: attachment ${i + 1} ("${filename}") could not be decoded.`,
      );
    }
    return {
      filename,
      content,
      contentType: String(entry?.contentType || "application/octet-stream"),
    };
  });
}

/**
 * Queue an email carrying files. Validation happens HERE, at creation, so a bad
 * attachment is a loud error to whoever asked for the send — not a job that
 * retries five times at 2am and dies.
 */
export async function queueEmailWithAttachments(
  db: any,
  input: {
    tenantId: string;
    type: string;
    toEmail: string;
    subject: string;
    htmlBody: string;
    textBody: string;
    attachments: EmailAttachmentInput[];
  },
): Promise<{ id: string }> {
  const attachments = buildEmailAttachments(input.attachments);
  return db.emailJob.create({
    data: {
      tenantId: input.tenantId,
      type: input.type,
      toEmail: input.toEmail,
      subject: input.subject,
      htmlBody: input.htmlBody,
      textBody: input.textBody,
      attachments: attachments as any,
      status: "QUEUED",
    },
    select: { id: true },
  });
}
