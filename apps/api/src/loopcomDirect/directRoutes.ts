/**
 * Loopcom Direct — cross-company chat by phone number, and the video call that
 * starts from it. (2026-08-21)
 *
 * ⛔⛔ THIS IS THE ONE PLACE ON THE PLATFORM WHERE A PERSON AT COMPANY A CAN
 * REACH A PERSON AT COMPANY B. Read `directPolicy.ts` before changing anything
 * here: every privacy decision lives there as a pure function, and these
 * handlers only fetch rows and apply them. Do not re-derive a rule inline.
 *
 * ⛔ There is deliberately NO tenantId filter on any query in this file, and
 * that is not an oversight — a Direct thread spans two tenants, so a tenant
 * filter would silently return nothing for every real conversation. Isolation
 * is per USER: every route resolves the caller's own participant row (or their
 * own identity row) before reading anything, and a non-participant gets the
 * same 404 the rest of the chat surface gives.
 *
 * ⛔ The whole feature is inert until a person verifies their own mobile
 * number: no identity row means they cannot be found, cannot be messaged, and
 * see nothing. Deploying this changes nothing for anybody until somebody opts
 * in.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomInt, createHash, timingSafeEqual } from "node:crypto";

import { db as defaultDb } from "@connect/db";
import { resolvePersonDisplayName } from "@connect/shared";

import { resolveBillingSmsSender } from "../billing/billingSmsSender";
import {
  buildDirectCard,
  buildPairKey,
  decideCanCall,
  decideCanSend,
  decideLookup,
  decideRecipientInitialState,
  normalizeDirectPhone,
  sanitizeMessageBody,
  visibleReadAtForOther,
  type DirectParticipantRow,
  type DirectParticipantState,
} from "./directPolicy";
import { startDirectVideoCall } from "./directCall";

/** Same shape and lifetime as the sign-in code, for the same reasons. */
export const DIRECT_VERIFY_CODE_TTL_SECONDS = 600;
export const DIRECT_VERIFY_MAX_ATTEMPTS = 5;
/** Sending a text costs real money — cap how many a person can trigger. */
export const DIRECT_VERIFY_MAX_SENDS_PER_HOUR = 5;

type AnyDb = typeof defaultDb;

export type DirectRoutesDeps = {
  db?: AnyDb;
  /** Injected so tests never reach the real push fan-out. */
  sendPushToUserDevices?: (input: {
    tenantId: string;
    userId: string;
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Injected so tests never send a real text. */
  smsSender?: typeof resolveBillingSmsSender;
};

type SessionUser = { sub: string; tenantId: string; role?: string };

function sessionUser(req: FastifyRequest): SessionUser | null {
  const u = (req as unknown as { user?: SessionUser }).user;
  if (!u?.sub || !u?.tenantId) return null;
  return u;
}

/** 6 digits, zero-padded so a leading zero is a real code. */
function generateVerifyCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * ⛔ Salted with the row id, exactly like the sign-in code: two people whose
 * codes happen to match must never share a hash.
 */
function hashVerifyCode(code: string, challengeId: string): string {
  return createHash("sha256").update(`${challengeId}:${code.trim()}`).digest("hex");
}

function verifyCodeMatches(candidate: unknown, challengeId: string, storedHash: string): boolean {
  if (typeof candidate !== "string") return false;
  const cleaned = candidate.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  const a = Buffer.from(hashVerifyCode(cleaned, challengeId), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** (845) 723-1213 — how a number is shown to a person. */
function formatUsPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * The name a stranger at another company sees.
 *
 * ⛔ `email` is deliberately NOT passed to the resolver. Its documented last
 * resort is the email's local part, which is fine inside one company (that is
 * the whole point of the 2026-08-17 naming work) and is a small privacy leak
 * across companies — "who is +1347…?" would answer "sender.weiss". A person
 * with no usable name shows as "Loopcom user" instead.
 */
function directDisplayName(user: {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  extension?: { displayName?: string | null } | null;
}): string {
  const name = resolvePersonDisplayName(
    {
      extensionDisplayName: user.extension?.displayName ?? null,
      displayName: user.displayName ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
    },
    "",
  );
  return name && name !== "there" ? name : "";
}

const userCardSelect = {
  id: true,
  displayName: true,
  firstName: true,
  lastName: true,
  tenantId: true,
  tenant: { select: { name: true, loopcomDirectEnabled: true } },
  ownedExtensions: { select: { displayName: true }, take: 1 },
} as const;

type UserCardRow = {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  tenantId: string;
  tenant: { name: string | null; loopcomDirectEnabled: boolean } | null;
  ownedExtensions: { displayName: string | null }[];
};

function cardFor(user: UserCardRow, phoneE164: string) {
  return buildDirectCard({
    displayName: directDisplayName({
      displayName: user.displayName,
      firstName: user.firstName,
      lastName: user.lastName,
      extension: user.ownedExtensions[0] ? { displayName: user.ownedExtensions[0].displayName } : null,
    }),
    tenantName: user.tenant?.name ?? null,
    phoneE164,
  });
}

export function registerLoopcomDirectRoutes(app: FastifyInstance, deps: DirectRoutesDeps = {}): void {
  const db = deps.db ?? defaultDb;
  const smsSender = deps.smsSender ?? resolveBillingSmsSender;
  const pushToUser = deps.sendPushToUserDevices;

  /** Is EITHER side blocking the other? See decideLookup's note on why both. */
  async function blockedEitherWay(a: string, b: string): Promise<boolean> {
    const row = await db.loopcomDirectBlock.findFirst({
      where: {
        OR: [
          { blockerUserId: a, blockedUserId: b },
          { blockerUserId: b, blockedUserId: a },
        ],
      },
      select: { id: true },
    });
    return Boolean(row);
  }

  async function myIdentity(userId: string) {
    return db.loopcomDirectIdentity.findUnique({ where: { userId } });
  }

  /**
   * Load a thread the caller is genuinely part of, with both participants.
   * ⛔ Returns null for a non-participant, and every caller answers 404 — the
   * same shape the rest of the chat surface uses, so a probe cannot tell an
   * existing thread from one that never existed.
   */
  async function loadThreadFor(userId: string, threadId: string) {
    const thread = await db.loopcomDirectThread.findUnique({
      where: { id: threadId },
      include: { participants: true },
    });
    if (!thread) return null;
    const mine = thread.participants.find((p) => p.userId === userId);
    if (!mine) return null;
    return { thread, mine };
  }

  function participantRows(participants: { userId: string; state: string; lastReadAt: Date | null }[]): DirectParticipantRow[] {
    return participants.map((p) => ({
      userId: p.userId,
      state: p.state as DirectParticipantState,
      lastReadAt: p.lastReadAt,
    }));
  }

  // ------------------------------------------------------------------ me

  /**
   * Everything the privacy screen needs, plus whether this person has opted in
   * at all. ⛔ Answers 200 with `identity: null` for somebody who has never
   * verified — never a 403. The screen asks on every open and a console full of
   * 403s for the ordinary case buries real failures (the voice-changer lesson).
   */
  app.get("/direct/me", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });

    const [identity, tenant, blocks] = await Promise.all([
      myIdentity(user.sub),
      db.tenant.findUnique({ where: { id: user.tenantId }, select: { loopcomDirectEnabled: true } }),
      db.loopcomDirectBlock.findMany({ where: { blockerUserId: user.sub }, select: { blockedUserId: true } }),
    ]);

    const blockedUsers = blocks.length
      ? await db.user.findMany({ where: { id: { in: blocks.map((b) => b.blockedUserId) } }, select: userCardSelect })
      : [];
    const blockedIdentities = blockedUsers.length
      ? await db.loopcomDirectIdentity.findMany({
          where: { userId: { in: blockedUsers.map((u) => u.id) } },
          select: { userId: true, phoneE164: true },
        })
      : [];
    const phoneByUser = new Map(blockedIdentities.map((i) => [i.userId, i.phoneE164]));

    return reply.send({
      companyEnabled: tenant?.loopcomDirectEnabled !== false,
      identity: identity
        ? {
            phoneE164: identity.phoneE164,
            phoneDisplay: formatUsPhone(identity.phoneE164),
            verifiedAt: identity.verifiedAt,
            findable: identity.findable,
            requireRequests: identity.requireRequests,
          }
        : null,
      blocked: blockedUsers.map((u) => ({
        userId: u.id,
        ...cardFor(u as UserCardRow, phoneByUser.get(u.id) ?? ""),
      })),
    });
  });

  /** Toggle findable / requests. Only ever touches the caller's own row. */
  app.patch("/direct/me", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const body = (req.body ?? {}) as { findable?: unknown; requireRequests?: unknown };

    const identity = await myIdentity(user.sub);
    if (!identity) {
      return reply.status(400).send({
        error: "not_verified",
        message: "Verify your mobile number first.",
      });
    }

    const data: { findable?: boolean; requireRequests?: boolean } = {};
    if (typeof body.findable === "boolean") data.findable = body.findable;
    if (typeof body.requireRequests === "boolean") data.requireRequests = body.requireRequests;
    if (!Object.keys(data).length) return reply.status(400).send({ error: "nothing_to_change" });

    const updated = await db.loopcomDirectIdentity.update({ where: { userId: user.sub }, data });
    return reply.send({
      findable: updated.findable,
      requireRequests: updated.requireRequests,
    });
  });

  // -------------------------------------------------------------- verify

  /**
   * Send a 6-digit code to the number a person says is theirs.
   *
   * ⛔ Verifying is the OPT-IN: this is the only door that creates an identity,
   * and until it is walked the person is invisible to number search.
   */
  app.post("/direct/verify/start", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });

    const tenant = await db.tenant.findUnique({
      where: { id: user.tenantId },
      select: { loopcomDirectEnabled: true },
    });
    if (tenant?.loopcomDirectEnabled === false) {
      return reply.status(403).send({
        error: "company_disabled",
        message: "Your company has Loopcom Direct switched off.",
      });
    }

    const parsed = normalizeDirectPhone((req.body as { phone?: unknown } | undefined)?.phone);
    if (!parsed.ok) {
      return reply.status(400).send({
        error: "invalid_number",
        message: "Enter a 10-digit mobile number.",
      });
    }

    // ⛔ One number, one person. Taking over a number silently would hand the
    // new owner every conversation the old one had.
    const taken = await db.loopcomDirectIdentity.findUnique({ where: { phoneE164: parsed.e164 } });
    if (taken && taken.userId !== user.sub) {
      return reply.status(409).send({
        error: "number_in_use",
        message: "That number is already verified on another Loopcom account.",
      });
    }

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recentSends = await db.loopcomDirectVerification.count({
      where: { userId: user.sub, createdAt: { gt: since } },
    });
    if (recentSends >= DIRECT_VERIFY_MAX_SENDS_PER_HOUR) {
      return reply.status(429).send({
        error: "too_many_codes",
        message: "Too many codes requested. Try again in an hour.",
      });
    }

    const code = generateVerifyCode();
    // Two-step insert: the hash is salted with the row id, which does not
    // exist until the row does.
    const row = await db.loopcomDirectVerification.create({
      data: {
        userId: user.sub,
        phoneE164: parsed.e164,
        codeHash: "pending",
        expiresAt: new Date(Date.now() + DIRECT_VERIFY_CODE_TTL_SECONDS * 1000),
      },
    });
    await db.loopcomDirectVerification.update({
      where: { id: row.id },
      data: { codeHash: hashVerifyCode(code, row.id) },
    });

    const sender = await smsSender();
    if (!sender.ok) {
      return reply.status(503).send({
        error: "sms_unavailable",
        message: "We couldn't send the code right now. Try again shortly.",
      });
    }
    try {
      // ⛔ Plain ASCII: one emoji flips the whole text to UCS-2 and cuts a
      // segment from 160 characters to 70.
      await sender.send({
        tenantId: user.tenantId,
        to: parsed.e164,
        body: `Your Loopcom code is ${code}. It expires in 10 minutes.`,
      });
    } catch {
      return reply.status(502).send({
        error: "sms_failed",
        message: "We couldn't send the code right now. Try again shortly.",
      });
    }

    return reply.send({
      sent: true,
      // Honest about test mode rather than claiming a text went out.
      testMode: sender.testMode === true,
      phoneDisplay: formatUsPhone(parsed.e164),
      expiresInSeconds: DIRECT_VERIFY_CODE_TTL_SECONDS,
    });
  });

  /** Confirm the code and create the identity — the moment a person becomes findable. */
  app.post("/direct/verify/confirm", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const body = (req.body ?? {}) as { phone?: unknown; code?: unknown };

    const parsed = normalizeDirectPhone(body.phone);
    if (!parsed.ok) return reply.status(400).send({ error: "invalid_number", message: "Enter a 10-digit mobile number." });

    const row = await db.loopcomDirectVerification.findFirst({
      where: { userId: user.sub, phoneE164: parsed.e164, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) {
      return reply.status(400).send({ error: "no_code", message: "Ask for a new code." });
    }
    if (row.expiresAt.getTime() < Date.now()) {
      return reply.status(400).send({ error: "expired", message: "That code expired. Ask for a new one." });
    }
    if (row.attempts >= DIRECT_VERIFY_MAX_ATTEMPTS) {
      return reply.status(429).send({ error: "too_many_attempts", message: "Too many tries. Ask for a new code." });
    }
    if (!verifyCodeMatches(body.code, row.id, row.codeHash)) {
      const bumped = await db.loopcomDirectVerification.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });
      return reply.status(400).send({
        error: "wrong_code",
        message: "That code isn't right.",
        attemptsRemaining: Math.max(0, DIRECT_VERIFY_MAX_ATTEMPTS - bumped.attempts),
      });
    }

    // ⛔ Atomic spend — two racing confirms must not both win.
    const spent = await db.loopcomDirectVerification.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!spent.count) {
      return reply.status(400).send({ error: "no_code", message: "Ask for a new code." });
    }

    const taken = await db.loopcomDirectIdentity.findUnique({ where: { phoneE164: parsed.e164 } });
    if (taken && taken.userId !== user.sub) {
      return reply.status(409).send({
        error: "number_in_use",
        message: "That number is already verified on another Loopcom account.",
      });
    }

    const identity = await db.loopcomDirectIdentity.upsert({
      where: { userId: user.sub },
      create: {
        userId: user.sub,
        tenantId: user.tenantId,
        phoneE164: parsed.e164,
        verifiedAt: new Date(),
      },
      update: {
        phoneE164: parsed.e164,
        tenantId: user.tenantId,
        verifiedAt: new Date(),
        findable: true,
      },
    });

    return reply.send({
      verified: true,
      phoneE164: identity.phoneE164,
      phoneDisplay: formatUsPhone(identity.phoneE164),
      findable: identity.findable,
      requireRequests: identity.requireRequests,
    });
  });

  // -------------------------------------------------------------- lookup

  /**
   * "Type a number, find the person." Answers 200 in every case — found or
   * not — because "not on Loopcom" is a normal answer, not an error.
   */
  app.get("/direct/lookup", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });

    const parsed = normalizeDirectPhone((req.query as { phone?: unknown } | undefined)?.phone);
    if (!parsed.ok) {
      return reply.send({ result: "invalid", message: "Enter a 10-digit phone number." });
    }

    const identity = await db.loopcomDirectIdentity.findUnique({ where: { phoneE164: parsed.e164 } });
    const blocked = identity ? await blockedEitherWay(user.sub, identity.userId) : false;

    let targetTenantDisabled = false;
    let targetUser: UserCardRow | null = null;
    if (identity) {
      targetUser = (await db.user.findUnique({ where: { id: identity.userId }, select: userCardSelect })) as UserCardRow | null;
      targetTenantDisabled = targetUser?.tenant?.loopcomDirectEnabled === false;
    }

    const outcome = decideLookup({
      viewerUserId: user.sub,
      identity: identity
        ? {
            userId: identity.userId,
            tenantId: identity.tenantId,
            phoneE164: identity.phoneE164,
            findable: identity.findable,
            requireRequests: identity.requireRequests,
          }
        : null,
      blockedEitherWay: blocked,
      targetTenantDisabled,
    });

    if (outcome.kind === "self") {
      return reply.send({ result: "self", phoneDisplay: formatUsPhone(parsed.e164) });
    }
    if (outcome.kind !== "found" || !targetUser) {
      // ⛔ One answer for "not on Loopcom", "hidden", and "blocked".
      return reply.send({ result: "not_on_loopcom", phoneDisplay: formatUsPhone(parsed.e164) });
    }

    const existing = await db.loopcomDirectThread.findUnique({
      where: { pairKey: buildPairKey(user.sub, targetUser.id) },
      select: { id: true },
    });

    return reply.send({
      result: "found",
      userId: targetUser.id,
      ...cardFor(targetUser, identity!.phoneE164),
      phoneDisplay: formatUsPhone(identity!.phoneE164),
      existingThreadId: existing?.id ?? null,
    });
  });

  // ------------------------------------------------------------- threads

  /**
   * The chat list, plus the requests tray. ⛔ Requests are returned SEPARATELY
   * rather than mixed into the list — the tray only appears when something is
   * waiting, and a request must never look like an ordinary conversation.
   */
  app.get("/direct/threads", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });

    const mine = await db.loopcomDirectParticipant.findMany({
      where: { userId: user.sub, state: { in: ["ACTIVE", "REQUEST_PENDING"] } },
      include: {
        thread: {
          include: {
            participants: true,
            messages: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        },
      },
      orderBy: { thread: { lastMessageAt: "desc" } },
      take: 200,
    });

    const otherIds = mine
      .flatMap((p) => p.thread.participants.filter((x) => x.userId !== user.sub).map((x) => x.userId))
      .filter((v, i, a) => a.indexOf(v) === i);

    const [others, identities] = await Promise.all([
      otherIds.length ? db.user.findMany({ where: { id: { in: otherIds } }, select: userCardSelect }) : [],
      otherIds.length
        ? db.loopcomDirectIdentity.findMany({
            where: { userId: { in: otherIds } },
            select: { userId: true, phoneE164: true },
          })
        : [],
    ]);
    const userById = new Map((others as UserCardRow[]).map((u) => [u.id, u]));
    const phoneById = new Map(identities.map((i) => [i.userId, i.phoneE164]));

    const shape = (p: (typeof mine)[number]) => {
      const other = p.thread.participants.find((x) => x.userId !== user.sub);
      const otherUser = other ? userById.get(other.userId) : undefined;
      const last = p.thread.messages[0];
      const unread =
        last && last.senderUserId !== user.sub && (!p.lastReadAt || p.lastReadAt < last.createdAt);
      return {
        threadId: p.thread.id,
        state: p.state,
        lastMessageAt: p.thread.lastMessageAt,
        unread: Boolean(unread),
        lastMessage: last ? { body: last.body, kind: last.kind, mine: last.senderUserId === user.sub } : null,
        other: otherUser
          ? {
              userId: otherUser.id,
              ...cardFor(otherUser, phoneById.get(otherUser.id) ?? ""),
            }
          : null,
      };
    };

    return reply.send({
      threads: mine.filter((p) => p.state === "ACTIVE").map(shape),
      requests: mine.filter((p) => p.state === "REQUEST_PENDING").map(shape),
    });
  });

  /**
   * Start a conversation. Creates the thread, puts the recipient into the
   * right state, and stores the first message in ONE transaction — a thread
   * with no message would show up as a blank row on both sides.
   */
  app.post("/direct/threads", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const body = (req.body ?? {}) as { phone?: unknown; body?: unknown };

    const me = await myIdentity(user.sub);
    if (!me) {
      return reply.status(403).send({
        error: "not_verified",
        message: "Verify your mobile number before starting a conversation.",
      });
    }

    const parsed = normalizeDirectPhone(body.phone);
    if (!parsed.ok) return reply.status(400).send({ error: "invalid_number", message: "Enter a 10-digit phone number." });

    const text = sanitizeMessageBody(body.body);
    if (!text.ok) return reply.status(400).send({ error: "empty_message", message: text.message });

    const identity = await db.loopcomDirectIdentity.findUnique({ where: { phoneE164: parsed.e164 } });
    const target = identity
      ? ((await db.user.findUnique({ where: { id: identity.userId }, select: userCardSelect })) as UserCardRow | null)
      : null;
    const blocked = identity ? await blockedEitherWay(user.sub, identity.userId) : false;

    const outcome = decideLookup({
      viewerUserId: user.sub,
      identity: identity
        ? {
            userId: identity.userId,
            tenantId: identity.tenantId,
            phoneE164: identity.phoneE164,
            findable: identity.findable,
            requireRequests: identity.requireRequests,
          }
        : null,
      blockedEitherWay: blocked,
      targetTenantDisabled: target?.tenant?.loopcomDirectEnabled === false,
    });
    if (outcome.kind !== "found" || !identity || !target) {
      // ⛔ Same words as a number that was never on Loopcom.
      return reply.status(404).send({
        error: "not_on_loopcom",
        message: "That number isn't on Loopcom.",
      });
    }

    const pairKey = buildPairKey(user.sub, identity.userId);
    const existing = await db.loopcomDirectThread.findUnique({
      where: { pairKey },
      include: { participants: true },
    });

    if (existing) {
      const mineRow = existing.participants.find((p) => p.userId === user.sub);
      const theirRow = existing.participants.find((p) => p.userId === identity.userId);
      const decision = decideCanSend({
        senderUserId: user.sub,
        participants: participantRows(existing.participants),
        blockedEitherWay: blocked,
        senderMessageCount: await db.loopcomDirectMessage.count({
          where: { threadId: existing.id, senderUserId: user.sub },
        }),
      });
      if (!decision.ok) {
        return reply.status(409).send({ error: decision.reason, message: decision.message, threadId: existing.id });
      }
      void mineRow;
      void theirRow;
      return reply.send({ threadId: existing.id, created: false });
    }

    const hasAcceptedBefore = false; // no prior thread exists — this is first contact
    const recipientState = decideRecipientInitialState({
      recipientRequiresRequests: identity.requireRequests,
      recipientHasAcceptedBefore: hasAcceptedBefore,
    });

    const created = await db.$transaction(async (tx) => {
      const thread = await tx.loopcomDirectThread.create({
        data: {
          pairKey,
          lastMessageAt: new Date(),
          participants: {
            create: [
              { userId: user.sub, state: "ACTIVE", lastReadAt: new Date() },
              { userId: identity.userId, state: recipientState },
            ],
          },
        },
      });
      await tx.loopcomDirectMessage.create({
        data: { threadId: thread.id, senderUserId: user.sub, body: text.body },
      });
      return thread;
    });

    await notifyNewMessage({
      recipientUserId: identity.userId,
      recipientTenantId: target.tenantId,
      threadId: created.id,
      senderUserId: user.sub,
      senderTenantId: user.tenantId,
      preview: text.body,
      isRequest: recipientState === "REQUEST_PENDING",
    });

    return reply.send({ threadId: created.id, created: true, state: recipientState });
  });

  /** One conversation: the other person's card, the messages, and what I may do. */
  app.get("/direct/threads/:threadId", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const { threadId } = req.params as { threadId: string };

    const loaded = await loadThreadFor(user.sub, threadId);
    if (!loaded) return reply.status(404).send({ error: "not_found" });
    const { thread, mine } = loaded;

    const other = thread.participants.find((p) => p.userId !== user.sub);
    const [otherUser, otherIdentity, messages] = await Promise.all([
      other ? (db.user.findUnique({ where: { id: other.userId }, select: userCardSelect }) as Promise<UserCardRow | null>) : null,
      other ? db.loopcomDirectIdentity.findUnique({ where: { userId: other.userId } }) : null,
      db.loopcomDirectMessage.findMany({
        where: { threadId },
        orderBy: { createdAt: "asc" },
        take: 300,
      }),
    ]);

    const blocked = other ? await blockedEitherWay(user.sub, other.userId) : false;
    const canSend = decideCanSend({
      senderUserId: user.sub,
      participants: participantRows(thread.participants),
      blockedEitherWay: blocked,
      senderMessageCount: messages.filter((m) => m.senderUserId === user.sub).length,
    });
    const canCall = decideCanCall({
      callerUserId: user.sub,
      participants: participantRows(thread.participants),
      blockedEitherWay: blocked,
    });

    return reply.send({
      threadId: thread.id,
      myState: mine.state,
      other: otherUser
        ? {
            userId: otherUser.id,
            ...cardFor(otherUser, otherIdentity?.phoneE164 ?? ""),
            // ⛔ Only ACTIVE participants expose a read receipt.
            readAt: other ? visibleReadAtForOther(participantRows([other])[0]) : null,
          }
        : null,
      canSend: canSend.ok,
      sendBlockedReason: canSend.ok ? null : canSend.message,
      canCall: canCall.ok,
      callBlockedReason: canCall.ok ? null : canCall.message,
      messages: messages.map((m) => ({
        id: m.id,
        mine: m.senderUserId === user.sub,
        kind: m.kind,
        body: m.body,
        meetingCode: m.meetingCode,
        callSeconds: m.callSeconds,
        createdAt: m.createdAt,
      })),
    });
  });

  app.post("/direct/threads/:threadId/messages", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const { threadId } = req.params as { threadId: string };

    const text = sanitizeMessageBody((req.body as { body?: unknown } | undefined)?.body);
    if (!text.ok) return reply.status(400).send({ error: "empty_message", message: text.message });

    const loaded = await loadThreadFor(user.sub, threadId);
    if (!loaded) return reply.status(404).send({ error: "not_found" });
    const { thread } = loaded;

    const other = thread.participants.find((p) => p.userId !== user.sub);
    const blocked = other ? await blockedEitherWay(user.sub, other.userId) : false;
    const senderMessageCount = await db.loopcomDirectMessage.count({
      where: { threadId, senderUserId: user.sub },
    });

    const decision = decideCanSend({
      senderUserId: user.sub,
      participants: participantRows(thread.participants),
      blockedEitherWay: blocked,
      senderMessageCount,
    });
    if (!decision.ok) return reply.status(409).send({ error: decision.reason, message: decision.message });

    const message = await db.$transaction(async (tx) => {
      const created = await tx.loopcomDirectMessage.create({
        data: { threadId, senderUserId: user.sub, body: text.body },
      });
      await tx.loopcomDirectThread.update({ where: { id: threadId }, data: { lastMessageAt: created.createdAt } });
      await tx.loopcomDirectParticipant.update({
        where: { threadId_userId: { threadId, userId: user.sub } },
        data: { lastReadAt: created.createdAt },
      });
      return created;
    });

    if (other) {
      const otherUser = (await db.user.findUnique({
        where: { id: other.userId },
        select: { tenantId: true },
      })) as { tenantId: string } | null;
      if (otherUser) {
        await notifyNewMessage({
          recipientUserId: other.userId,
          recipientTenantId: otherUser.tenantId,
          threadId,
          senderUserId: user.sub,
          senderTenantId: user.tenantId,
          preview: text.body,
          isRequest: other.state === "REQUEST_PENDING",
        });
      }
    }

    return reply.send({
      id: message.id,
      body: message.body,
      createdAt: message.createdAt,
      mine: true,
      kind: message.kind,
    });
  });

  app.post("/direct/threads/:threadId/read", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const { threadId } = req.params as { threadId: string };

    const loaded = await loadThreadFor(user.sub, threadId);
    if (!loaded) return reply.status(404).send({ error: "not_found" });

    // ⛔ Marking read on a PENDING request would leak a read receipt the moment
    // it is accepted; the request screen deliberately does not call this.
    if (loaded.mine.state !== "ACTIVE") return reply.send({ ok: true, recorded: false });

    await db.loopcomDirectParticipant.update({
      where: { threadId_userId: { threadId, userId: user.sub } },
      data: { lastReadAt: new Date() },
    });
    return reply.send({ ok: true, recorded: true });
  });

  // ------------------------------------------------------------ requests

  app.post("/direct/threads/:threadId/accept", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const { threadId } = req.params as { threadId: string };

    const loaded = await loadThreadFor(user.sub, threadId);
    if (!loaded) return reply.status(404).send({ error: "not_found" });
    if (loaded.mine.state === "ACTIVE") return reply.send({ ok: true, state: "ACTIVE" });

    await db.loopcomDirectParticipant.update({
      where: { threadId_userId: { threadId, userId: user.sub } },
      data: { state: "ACTIVE", lastReadAt: new Date() },
    });
    return reply.send({ ok: true, state: "ACTIVE" });
  });

  /**
   * Decline: the thread disappears for me and the sender is NEVER told.
   * ⛔ Telling them would make declining worse than ignoring, which is how a
   * request tray stops being used.
   */
  app.post("/direct/threads/:threadId/decline", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const { threadId } = req.params as { threadId: string };

    const loaded = await loadThreadFor(user.sub, threadId);
    if (!loaded) return reply.status(404).send({ error: "not_found" });

    await db.loopcomDirectParticipant.update({
      where: { threadId_userId: { threadId, userId: user.sub } },
      data: { state: "DECLINED" },
    });
    return reply.send({ ok: true, state: "DECLINED" });
  });

  /** Block: decline, plus they can never find or reach me again. */
  app.post("/direct/threads/:threadId/block", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const { threadId } = req.params as { threadId: string };

    const loaded = await loadThreadFor(user.sub, threadId);
    if (!loaded) return reply.status(404).send({ error: "not_found" });
    const other = loaded.thread.participants.find((p) => p.userId !== user.sub);
    if (!other) return reply.status(404).send({ error: "not_found" });

    await db.$transaction(async (tx) => {
      await tx.loopcomDirectParticipant.update({
        where: { threadId_userId: { threadId, userId: user.sub } },
        data: { state: "DECLINED" },
      });
      await tx.loopcomDirectBlock.upsert({
        where: { blockerUserId_blockedUserId: { blockerUserId: user.sub, blockedUserId: other.userId } },
        create: { blockerUserId: user.sub, blockedUserId: other.userId },
        update: {},
      });
    });
    return reply.send({ ok: true, blocked: true });
  });

  app.delete("/direct/blocks/:userId", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const { userId } = req.params as { userId: string };
    await db.loopcomDirectBlock.deleteMany({ where: { blockerUserId: user.sub, blockedUserId: userId } });
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- call

  /**
   * Start a video call with the person in this thread.
   *
   * ⛔ The meeting row is created here rather than through `POST /meetings`,
   * which is SUPER_ADMIN-only by Izzy's 2026-08-21 decision. That gate is about
   * who may HOST a meeting room; a Direct call is a different door with its own
   * rule — both people must already be talking to each other.
   */
  app.post("/direct/threads/:threadId/call", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    const { threadId } = req.params as { threadId: string };

    const loaded = await loadThreadFor(user.sub, threadId);
    if (!loaded) return reply.status(404).send({ error: "not_found" });
    const other = loaded.thread.participants.find((p) => p.userId !== user.sub);
    if (!other) return reply.status(404).send({ error: "not_found" });

    const blocked = await blockedEitherWay(user.sub, other.userId);
    const decision = decideCanCall({
      callerUserId: user.sub,
      participants: participantRows(loaded.thread.participants),
      blockedEitherWay: blocked,
    });
    if (!decision.ok) return reply.status(409).send({ error: "cannot_call", message: decision.message });

    const callerUser = (await db.user.findUnique({ where: { id: user.sub }, select: userCardSelect })) as UserCardRow | null;
    const callerName = callerUser ? cardFor(callerUser, "").name : "A Loopcom user";

    const result = await startDirectVideoCall({
      db,
      threadId,
      callerUserId: user.sub,
      callerTenantId: user.tenantId,
      callerName,
      recipientUserId: other.userId,
      sendPushToUserDevices: pushToUser,
      origin: originFromRequest(req),
    });
    if (!result.ok) {
      return reply.status(503).send({ error: result.error, message: result.message });
    }
    return reply.send({ meetingCode: result.code, joinPath: result.joinPath });
  });

  // --------------------------------------------------------------- push

  /**
   * ⛔ Best-effort by design and never allowed to fail a send: a message that
   * was stored must not report failure because a phone could not be reached.
   * ⛔ The preview is omitted for a REQUEST — an unaccepted stranger must not
   * be able to put arbitrary text on somebody's lock screen.
   */
  async function notifyNewMessage(input: {
    recipientUserId: string;
    recipientTenantId: string;
    threadId: string;
    senderUserId: string;
    senderTenantId: string;
    preview: string;
    isRequest: boolean;
  }): Promise<void> {
    if (!pushToUser) return;
    try {
      const senderUser = (await db.user.findUnique({
        where: { id: input.senderUserId },
        select: userCardSelect,
      })) as UserCardRow | null;
      const senderName = senderUser ? cardFor(senderUser, "").name : "Someone";
      await pushToUser({
        tenantId: input.recipientTenantId,
        userId: input.recipientUserId,
        payload: {
          type: "dm_message",
          conversationId: input.threadId,
          senderName,
          preview: input.isRequest
            ? "wants to chat with you on Loopcom"
            : input.preview.slice(0, 120),
          direct: true,
        },
      });
    } catch {
      /* a push failure must never fail a delivered message */
    }
  }
}

/** The host the caller is actually on — the two-hostname rule. */
function originFromRequest(req: FastifyRequest): string | null {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host;
  if (!host) return null;
  return `${proto.split(",")[0].trim()}://${String(host).split(",")[0].trim()}`;
}

export const __testing = {
  generateVerifyCode,
  hashVerifyCode,
  verifyCodeMatches,
  formatUsPhone,
  directDisplayName,
};
