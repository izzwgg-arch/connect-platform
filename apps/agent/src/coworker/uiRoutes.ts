/**
 * The Coworker WORKSPACE's own routes — what the bubble chat and the full page call
 * besides sending a message (that stays POST /agent/chat/message, with a turnId).
 *
 *   POST /agent/coworker/activity   { turnId, after }          → { events, done, lastSeq }
 *   POST /agent/coworker/attach     { conversationId }         → { turnId | null }   (a window opened mid-task)
 *   POST /agent/coworker/answer     { turnId, questionId, answer | null }
 *   POST /agent/coworker/stop       { turnId }
 *   POST /agent/coworker/tasks      {}                         → the person's tasks, last 30 days
 *   POST /agent/coworker/log        { limit }                  → "Everything it did"
 *   POST /agent/coworker/prefs      { prefs? }                 → read (no prefs) or save
 *   POST /agent/coworker/transcribe { audioBase64, filename }  → { text, language, engine }
 *
 * ⛔ Identity from the portal JWT only (`resolveIdentity`), and a person with no user
 * id (an internal caller) gets nothing here. Someone else's turn or task reads as
 * not found, never forbidden.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveIdentity } from "../conversation/routes";
import type { ConversationStore } from "../conversation/store";
import type { AuditLog } from "../audit/audit";
import type { ActivityHub } from "./activity";
import type { CoworkerPrefsStore } from "./prefs";
import { YiddishLabsClient } from "../transcription/yiddishlabs";

export const TASK_HISTORY_DAYS = 30;

/**
 * ⛔ The page starts polling the SAME instant it sends the message, and the poll
 * route is an in-memory lookup while /agent/chat/message verifies the token and reads
 * the database before it opens the turn — so the very first poll lost that race on
 * every real send (2026-09-18, three for three) and the page, told "not found", gave
 * up watching for good: no steps, no "Right now", a blank spinner until the reply.
 * A poll for a turn that is not open YET waits this long for it before saying 404.
 */
export const ACTIVITY_OPEN_GRACE_MS = 2000;
const ACTIVITY_OPEN_TICK_MS = 50;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Owner = { tenantId: string; clientUserId: string };

function owner(req: FastifyRequest): { id: Owner; role: string } | null {
  const id = resolveIdentity(req);
  if (!id || !id.clientUserId) return null;
  return { id: { tenantId: id.tenantId, clientUserId: id.clientUserId }, role: id.role };
}

/** A task's name in the list: the first thing they asked, without attachment notes. */
export function taskTitle(firstUserMessage: string | null | undefined): string {
  const t = String(firstUserMessage ?? "")
    .split("\n")
    .filter((l) => !/^\[Attached: .*\]$/.test(l.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "Untitled task";
  return t.length > 80 ? `${t.slice(0, 77).trimEnd()}…` : t;
}

export type TranscribeDeps = {
  keys: { yiddishLabsApiKey?: string | null; openaiApiKey?: string | null };
  glossaryContext: () => Promise<string | undefined>;
};

/**
 * Voice in the Coworker. Izzy, 2026-09-15: *"wire [Yiddish] Labs transcription and GPT
 * for English transcription into it."*
 *
 * ⛔ BOTH RUN AT ONCE, and the language decides the winner: Yiddish Labs is the one
 * that gets American Yiddish right, OpenAI's transcription model is the one that
 * gets English right. Yiddish Labs answers a short clip at once in rapid mode and
 * says which language it heard; when it heard Yiddish its text wins, otherwise the
 * OpenAI text wins. Either one failing leaves the other. ⛔ Not the widget's
 * /agent/chat/transcribe route (Laybel voice mode rides that one) — its order is
 * unchanged.
 */
export async function transcribeForCoworker(
  deps: TranscribeDeps,
  buf: Buffer,
  filename: string,
  openaiTranscribe: (key: string, buf: Buffer, filename: string, opts?: { model?: string }) => Promise<{ text: string }>,
  ylFactory: (key: string) => { submitSync: YiddishLabsClient["submitSync"]; get: YiddishLabsClient["get"] } = (k) => new YiddishLabsClient(k),
): Promise<{ ok: true; text: string; language: "en" | "yi"; engine: "yiddishlabs" | "openai" } | { ok: false; error: string }> {
  const clean = (s: string) => s.replace(/⟦[^⟧]*⟧/g, " ").replace(/[⟦⟧]/g, " ").replace(/[ \t]+/g, " ").trim();
  const hasHebrew = (s: string) => /[֐-׿]/.test(s);
  const model = process.env.COWORKER_TRANSCRIBE_MODEL || "gpt-4o-transcribe";

  const openai = deps.keys.openaiApiKey
    ? openaiTranscribe(deps.keys.openaiApiKey, buf, filename, { model }).then((r) => clean(r.text || ""), () => "")
    : Promise.resolve("");

  const yiddish = (async (): Promise<{ text: string; language: "en" | "yi" } | null> => {
    if (!deps.keys.yiddishLabsApiKey) return null;
    try {
      const cli = ylFactory(deps.keys.yiddishLabsApiKey);
      const ctx = await deps.glossaryContext().catch(() => undefined);
      let r: any = await cli.submitSync({ file: buf, filename, language: "auto", context: ctx, rapid: true } as any);
      // Short dictation completes at once; give a longer clip up to a minute.
      for (let i = 0; i < 30 && r.status !== "completed" && r.status !== "failed"; i++) {
        await new Promise((x) => setTimeout(x, 2000));
        r = await cli.get(r.id);
      }
      if (r.status !== "completed" || !r.text || !String(r.text).trim()) return null;
      const language = YiddishLabsClient.normalizeLanguage(r) === "yi" ? "yi" : "en";
      return { text: clean(String(r.text)), language };
    } catch {
      return null;
    }
  })();

  const openaiText = await openai;
  // English from OpenAI with no Hebrew letters: that is the English engine's win,
  // unless Yiddish Labs — already running — says the speech was Yiddish.
  if (openaiText && !hasHebrew(openaiText)) {
    const yl = await Promise.race([yiddish, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
    if (yl && yl.language === "yi") return { ok: true, text: yl.text, language: "yi", engine: "yiddishlabs" };
    return { ok: true, text: openaiText, language: "en", engine: "openai" };
  }
  const yl = await yiddish;
  if (yl) return { ok: true, text: yl.text, language: yl.language, engine: "yiddishlabs" };
  if (openaiText) return { ok: true, text: openaiText, language: hasHebrew(openaiText) ? "yi" : "en", engine: "openai" };
  return { ok: false, error: deps.keys.openaiApiKey || deps.keys.yiddishLabsApiKey ? "transcription_unavailable" : "no_transcription_provider" };
}

export function registerCoworkerUiRoutes(
  app: FastifyInstance,
  deps: {
    hub: ActivityHub;
    prisma: any;
    store: ConversationStore;
    audit: AuditLog;
    prefs: CoworkerPrefsStore;
    transcribe: TranscribeDeps;
    /** How long a poll waits for a not-yet-open turn (tests shorten it). */
    activityOpenGraceMs?: number;
  },
) {
  const { hub, prisma, store, prefs } = deps;
  const openGraceMs = deps.activityOpenGraceMs ?? ACTIVITY_OPEN_GRACE_MS;

  // ⛔ Polled about once a second per open window while a task runs; logged at warn
  // so the agent's log is not two lines per poll.
  app.post("/agent/coworker/activity", { logLevel: "warn" }, async (req, reply) => {
    const who = owner(req);
    if (!who) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ turnId: z.string().min(8).max(64), after: z.number().int().min(0).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    let r = hub.read(body.data.turnId, who.id, body.data.after ?? 0);
    // Not open yet (the message that opens it is still being verified)? Wait for it.
    // Only a FRESH watcher (after = 0) waits: one that already saw events and now
    // reads "not found" is looking at a turn that is truly gone.
    if (!r.ok && !(body.data.after ?? 0)) {
      const deadline = Date.now() + openGraceMs;
      while (!r.ok && Date.now() < deadline) {
        await sleep(Math.min(ACTIVITY_OPEN_TICK_MS, Math.max(1, deadline - Date.now())));
        r = hub.read(body.data.turnId, who.id, body.data.after ?? 0);
      }
    }
    if (!r.ok) return reply.code(404).send({ error: "not_found" });
    return { events: r.events, done: r.done, lastSeq: r.lastSeq };
  });

  app.post("/agent/coworker/attach", { logLevel: "warn" }, async (req, reply) => {
    const who = owner(req);
    if (!who) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ conversationId: z.string().min(1).max(64) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return { turnId: hub.activeTurnFor(who.id, body.data.conversationId) };
  });

  app.post("/agent/coworker/answer", async (req, reply) => {
    const who = owner(req);
    if (!who) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ turnId: z.string().min(8).max(64), questionId: z.string().min(1).max(40), answer: z.string().max(4000).nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const r = hub.answer(body.data.turnId, who.id, body.data.questionId, body.data.answer);
    if (!r.ok) return reply.code(r.error === "not_found" ? 404 : r.error === "already_answered" ? 409 : 400).send({ error: r.error });
    return { ok: true };
  });

  app.post("/agent/coworker/stop", async (req, reply) => {
    const who = owner(req);
    if (!who) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ turnId: z.string().min(8).max(64) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const r = hub.stop(body.data.turnId, who.id);
    if (!r.ok) return reply.code(404).send({ error: "not_found" });
    await deps.audit.record({ actor: "customer", event: "coworker.stop", tenantId: who.id.tenantId, payload: { userId: who.id.clientUserId, turnId: body.data.turnId, alreadyDone: r.alreadyDone } });
    return { ok: true, alreadyDone: r.alreadyDone };
  });

  app.post("/agent/coworker/tasks", async (req, reply) => {
    const who = owner(req);
    if (!who) return reply.code(403).send({ error: "forbidden" });
    // ⛔ The company's "customers may see their chat history" switch still governs
    // the LIST, exactly as it does for /agent/chat/history. The current task stays
    // readable either way through /agent/chat/messages.
    if (who.role !== "owner") {
      const visible = await store.historyVisible(who.id.tenantId).catch(() => false);
      if (!visible) return { visible: false, tasks: [] };
    }
    const since = new Date(Date.now() - TASK_HISTORY_DAYS * 24 * 3600 * 1000);
    const rows: any[] = await prisma.agentConversation.findMany({
      where: { tenantId: who.id.tenantId, clientUserId: who.id.clientUserId, startedAt: { gte: since } },
      orderBy: { startedAt: "desc" },
      take: 60,
      select: {
        id: true, startedAt: true, status: true, closedAt: true,
        messages: { where: { role: "user" }, orderBy: { createdAt: "asc" }, take: 1, select: { content: true } },
      },
    });
    return {
      visible: true,
      tasks: rows.map((r) => ({
        id: r.id,
        title: taskTitle(r.messages?.[0]?.content),
        startedAt: r.startedAt,
        status: r.status,
        running: hub.activeTurnFor(who.id, r.id) !== null,
      })),
    };
  });

  app.post("/agent/coworker/log", async (req, reply) => {
    const who = owner(req);
    if (!who) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ limit: z.number().int().min(1).max(200).optional() }).safeParse(req.body ?? {});
    const limit = body.success ? body.data.limit ?? 100 : 100;
    const rows: any[] = await prisma.agentAuditLog.findMany({
      where: { event: "coworker.step", tenantId: who.id.tenantId, payload: { path: ["userId"], equals: who.id.clientUserId } },
      orderBy: { ts: "desc" },
      take: limit,
      select: { ts: true, conversationId: true, payload: true },
    });
    return {
      entries: rows.map((r) => {
        const p = (r.payload ?? {}) as Record<string, unknown>;
        return {
          at: r.ts,
          conversationId: r.conversationId,
          kind: typeof p.kind === "string" ? p.kind : "think",
          label: typeof p.label === "string" ? p.label : "Step",
          state: typeof p.state === "string" ? p.state : "done",
          changed: typeof p.changed === "string" ? p.changed : null,
          tookMs: typeof p.tookMs === "number" ? p.tookMs : null,
        };
      }),
    };
  });

  app.post("/agent/coworker/prefs", async (req, reply) => {
    const who = owner(req);
    if (!who) return reply.code(403).send({ error: "forbidden" });
    const b = (req.body ?? {}) as { prefs?: unknown };
    if (b.prefs === undefined) return { prefs: await prefs.get(who.id) };
    if (!b.prefs || typeof b.prefs !== "object" || Array.isArray(b.prefs)) return reply.code(400).send({ error: "bad_request" });
    try {
      return { prefs: await prefs.set(who.id, b.prefs) };
    } catch {
      return reply.code(503).send({ error: "not_saved", message: "Your settings could not be saved just now. Try again." });
    }
  });

  app.post("/agent/coworker/transcribe", async (req, reply) => {
    const who = owner(req);
    if (!who) return reply.code(403).send({ error: "forbidden" });
    const b = (req.body ?? {}) as { audioBase64?: unknown; filename?: unknown };
    if (typeof b.audioBase64 !== "string" || b.audioBase64.length < 32) return reply.code(400).send({ ok: false, error: "no_audio" });
    let buf: Buffer;
    try { buf = Buffer.from(b.audioBase64.replace(/^data:[^,]+,/, ""), "base64"); } catch { return reply.code(400).send({ ok: false, error: "bad_audio" }); }
    if (buf.length < 64) return reply.code(400).send({ ok: false, error: "no_audio" });
    const filename = typeof b.filename === "string" && /^[\w.-]{1,60}$/.test(b.filename) ? b.filename : "voice.webm";
    const { openaiTranscribe } = await import("../transcription/openaiStt");
    const r = await transcribeForCoworker(deps.transcribe, buf, filename, openaiTranscribe as any);
    if (!r.ok) return reply.code(502).send(r);
    await deps.audit.record({ actor: "customer", event: "coworker.voice", tenantId: who.id.tenantId, payload: { userId: who.id.clientUserId, engine: r.engine, language: r.language, chars: r.text.length, bytes: buf.length } });
    return r;
  });
}
