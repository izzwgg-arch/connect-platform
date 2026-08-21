/**
 * Loopcom Direct — starting a video call from a conversation.
 *
 * ⛔ THE DIVISION OF LABOUR IS THE SAME ONE MEETINGS ALREADY USES: LiveKit
 * carries the video, Connect only decides who may join. This module creates a
 * VideoMeeting row (the same table `/meetings` uses, so a Direct call and a
 * link-join meeting are the SAME machinery at different sizes — there is no
 * second video system to keep in step) and tells the other person about it.
 *
 * ⛔⛔ WHAT THIS DELIBERATELY DOES **NOT** DO YET: make the recipient's phone
 * RING. That needs a new call-control push type handled by native code in the
 * Android/iOS app, which only reaches a customer through an app build. Sending
 * a ring push that no installed app understands would be worse than useless —
 * `INCOMING_CALL` is the only type the native service rings on, and borrowing it
 * would make the phone try to answer a SIP call that does not exist. So v1
 * delivers the call as a message with a join link plus an ordinary message
 * push, which works on every phone and browser TODAY. The ring is Phase 3 and
 * ships with the app build.
 */

import { getLiveKitConfig, buildMeetingCode } from "../meetings/livekit";

type MinimalDb = {
  videoMeeting: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; code: string }>;
  };
  loopcomDirectMessage: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; createdAt: Date }>;
  };
  loopcomDirectThread: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
  user: {
    findUnique: (args: { where: { id: string }; select: Record<string, boolean> }) => Promise<{ tenantId: string } | null>;
  };
};

export type StartDirectCallResult =
  | { ok: true; code: string; joinPath: string }
  | { ok: false; error: string; message: string };

/** How many times a code collision is retried before giving up. */
const CODE_ATTEMPTS = 3;

export async function startDirectVideoCall(input: {
  db: unknown;
  threadId: string;
  callerUserId: string;
  callerTenantId: string;
  callerName: string;
  recipientUserId: string;
  origin: string | null;
  sendPushToUserDevices?: (args: {
    tenantId: string;
    userId: string;
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
}): Promise<StartDirectCallResult> {
  const db = input.db as MinimalDb;

  // ⛔ Read at call time, never module load — the Turnstile/meetings pattern.
  // An unconfigured video server must refuse in plain English, never 500.
  const cfg = getLiveKitConfig();
  if (!cfg) {
    return {
      ok: false,
      error: "video_not_configured",
      message: "Video calling isn't switched on for this server yet.",
    };
  }

  let meeting: { id: string; code: string } | null = null;
  for (let attempt = 0; attempt < CODE_ATTEMPTS && !meeting; attempt += 1) {
    const code = buildMeetingCode();
    try {
      meeting = await db.videoMeeting.create({
        data: {
          code,
          // ⛔ The CALLER's tenant owns the row. A meeting has to belong to one
          // company for the existing tenant-scoped reads to stay correct, and
          // the caller is the one who started it. Access is NOT decided by this
          // field — the code is the credential, exactly as for a link meeting.
          tenantId: input.callerTenantId,
          createdByUserId: input.callerUserId,
          title: `Call with ${input.callerName}`,
        },
      });
    } catch (err) {
      const code2 = (err as { code?: string } | null)?.code;
      if (code2 !== "P2002" || attempt === CODE_ATTEMPTS - 1) {
        return {
          ok: false,
          error: "meeting_create_failed",
          message: "We couldn't start the call. Try again.",
        };
      }
    }
  }
  if (!meeting) {
    return { ok: false, error: "meeting_create_failed", message: "We couldn't start the call. Try again." };
  }

  const joinPath = `/meet/${meeting.code}`;
  const link = input.origin ? `${input.origin}${joinPath}` : joinPath;

  // The call lands IN the conversation, so both sides have one history and the
  // other person can join from any device by tapping the thread.
  const now = new Date();
  await db.loopcomDirectMessage.create({
    data: {
      threadId: input.threadId,
      senderUserId: input.callerUserId,
      kind: "CALL_EVENT",
      body: `Video call started — join at ${link}`,
      meetingCode: meeting.code,
    },
  });
  await db.loopcomDirectThread.update({ where: { id: input.threadId }, data: { lastMessageAt: now } });

  // Best-effort: a push failure must never fail a call that really started.
  if (input.sendPushToUserDevices) {
    try {
      const recipient = await db.user.findUnique({
        where: { id: input.recipientUserId },
        select: { tenantId: true },
      });
      if (recipient) {
        await input.sendPushToUserDevices({
          tenantId: recipient.tenantId,
          userId: input.recipientUserId,
          payload: {
            type: "dm_message",
            conversationId: input.threadId,
            senderName: input.callerName,
            preview: "is video calling you on Loopcom",
            direct: true,
            meetingCode: meeting.code,
          },
        });
      }
    } catch {
      /* ignore */
    }
  }

  return { ok: true, code: meeting.code, joinPath };
}
