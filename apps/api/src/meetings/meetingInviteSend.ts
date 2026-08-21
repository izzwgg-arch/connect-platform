/**
 * Queueing meeting invites.
 *
 * ⛔ The join link is built from `canonicalPortalOrigin()`, NOT from the host
 * the request arrived on. This is the durable-link case from publicOrigins:
 * somebody opens this email a month later, and one env flip
 * (PUBLIC_PORTAL_URL) must be able to move the whole platform. A link built
 * from the request host would freeze whichever hostname the admin happened to
 * be signed into that day.
 *
 * ⛔ Failure direction: an address is recorded as invited only AFTER its email
 * job exists. A crash in between therefore leaves it unsent and re-sendable —
 * a duplicate invite is a small annoyance, a missing invite is somebody who
 * does not know about the meeting. Same trade as the SMS bridge.
 */
import { canonicalPortalOrigin } from "../publicOrigins";
import { resolvePersonDisplayName } from "@connect/shared";
import { buildMeetingInviteEmail, MEETING_INVITE_EMAIL_TYPE } from "./meetingInviteEmail";
import { formatMeetingWhen, isUsableTimeZone, type MeetingWhen } from "./meetingSchedule";

export type InvitableMeeting = {
  id: string;
  code: string;
  title: string;
  tenantId: string;
  createdByUserId: string;
  scheduledStartAt?: Date | string | null;
  durationMinutes?: number | null;
  timezone?: string | null;
  inviteMessage?: string | null;
};

export function meetingJoinUrl(code: string): string {
  return `${canonicalPortalOrigin()}/meet/${code}`;
}

/** The When block for this meeting, or null when it is an instant meeting.
 *  ⛔ Returns null rather than throwing on an unusable stored zone: a bad zone
 *  must not stop the invite going out — the email simply omits the time panel
 *  instead of stating a time that is right for nobody. */
export function meetingWhen(meeting: InvitableMeeting, now?: Date): MeetingWhen | null {
  if (!meeting.scheduledStartAt) return null;
  const startAt = meeting.scheduledStartAt instanceof Date ? meeting.scheduledStartAt : new Date(meeting.scheduledStartAt);
  if (Number.isNaN(startAt.getTime())) return null;
  const zone = String(meeting.timezone || "");
  if (!isUsableTimeZone(zone)) return null;
  return formatMeetingWhen({
    startAt,
    durationMinutes: meeting.durationMinutes || 30,
    timeZone: zone,
    now,
  });
}

/** What to call the host in the email. Follows the platform rule: the PBX
 *  extension name wins, then a stored name, then the email local part. */
export async function resolveHostName(db: any, userId: string): Promise<string> {
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        firstName: true,
        lastName: true,
        extension: { select: { displayName: true } },
      },
    });
    if (!user) return "Loopcom";
    return resolvePersonDisplayName(
      {
        extensionDisplayName: user.extension?.displayName ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        email: user.email ?? null,
      },
      "Loopcom",
    );
  } catch {
    // A name lookup must never stop an invite. "Loopcom invited you" is a
    // worse email than "Sara invited you"; it is a far better one than none.
    return "Loopcom";
  }
}

export type InviteSendResult = {
  /** Addresses an email job was queued for in this call. */
  sent: string[];
  /** Addresses skipped because they had already been emailed for this meeting. */
  alreadyInvited: string[];
  /** Addresses we could not queue (the reason is logged, not shown raw). */
  failed: string[];
};

export async function sendMeetingInvites(
  db: any,
  params: {
    meeting: InvitableMeeting;
    emails: string[];
    /** Skip anyone already emailed. False on first send (nobody has been). */
    skipAlreadyInvited?: boolean;
    now?: Date;
    log?: (msg: string) => void;
  },
): Promise<InviteSendResult> {
  const { meeting, emails } = params;
  const result: InviteSendResult = { sent: [], alreadyInvited: [], failed: [] };
  if (!emails.length) return result;

  const joinUrl = meetingJoinUrl(meeting.code);
  const hostName = await resolveHostName(db, meeting.createdByUserId);
  const when = meetingWhen(meeting, params.now);
  const template = buildMeetingInviteEmail({
    meetingTitle: meeting.title,
    hostName,
    joinUrl,
    when,
    message: meeting.inviteMessage ?? null,
  });

  for (const email of emails) {
    try {
      const existing = await db.videoMeetingInvite.findUnique({
        where: { meetingId_email: { meetingId: meeting.id, email } },
      });
      if (existing?.emailedAt && params.skipAlreadyInvited) {
        result.alreadyInvited.push(email);
        continue;
      }
      if (!existing) {
        await db.videoMeetingInvite.create({ data: { meetingId: meeting.id, email } });
      }

      await db.emailJob.create({
        data: {
          // Billed and scoped to the host's own tenant, like every customer
          // email on this platform.
          tenantId: meeting.tenantId,
          type: MEETING_INVITE_EMAIL_TYPE,
          toEmail: email,
          subject: template.subject,
          htmlBody: template.html,
          textBody: template.text,
          status: "QUEUED",
          attempts: 0,
          nextRunAt: new Date(),
        },
      });

      // Stamped only now — see the failure-direction note at the top.
      await db.videoMeetingInvite.update({
        where: { meetingId_email: { meetingId: meeting.id, email } },
        data: { emailedAt: new Date() },
      });
      result.sent.push(email);
    } catch (e: any) {
      params.log?.(`[MEETING_INVITE] could not queue ${email}: ${e?.message || e}`);
      result.failed.push(email);
    }
  }

  return result;
}
