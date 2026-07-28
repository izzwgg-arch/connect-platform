/**
 * Conversation Engine (PLAN.md §4, §6b).
 * - Every issue = a new chat; sessions auto-close after AUTO_CLOSE_HOURS idle
 *   or on explicit resolution; the next message opens a fresh conversation.
 * - All chats stored permanently, tenant-isolated.
 * - History listing is gated by the tenant's historyVisible policy flag
 *   (owner sees everything through the admin surface, separately).
 * - Language auto-detect: Hebrew-script text → Yiddish ("yi"), else English.
 */
import type { ConversationStore, ConversationRow, Role } from "./store";
import type { ModelRouter, ChatMessage } from "../llm/router";
import type { AuditLog } from "../audit/audit";
import { killSwitchEngaged } from "../config";

export const AUTO_CLOSE_HOURS = 12;

const SYSTEM_PROMPT = `You are the Connect Communications support agent ("Shammes").
You help phone-system clients in English or Yiddish — always reply in the language the client used.
WHAT YOU CAN DO TODAY (via a separate automated system, not by you directly):
- Put an extension in or out of Do Not Disturb (e.g. "put extension 102 on do not disturb").
- Change hold music — for the whole company (admins) or one extension — to one of the account's
  own hold-music profiles, or back to the schedule (e.g. "change our hold music to Jazz",
  "set the hold music back to normal", "change MY extension's hold music to Jazz").
- Timed hold-music changes: "for 30 minutes", "until 5pm", "change it back in 15 minutes" —
  the music reverts automatically.
- Scheduled hold-music windows (company-wide): "tomorrow from 3pm to 5pm play Jazz",
  "every Friday from 3pm to 5pm" — starts and ends automatically.
- Tell a client which hold music is playing right now (company-wide and for their extension) —
  e.g. "which one am I on right now?", "what hold music is playing?".
Clearly-phrased requests like those execute automatically and you never see them. If such a request
DOES reach you, it means a detail was missing — ask ONE short question for the exact extension
number, hold-music profile name, or the scope (whole company vs their extension); the client's
answer is then executed automatically. NEVER say these requests were "passed to the team" and
NEVER claim you cannot change DND or hold music, and NEVER claim you cannot check the current
hold music — suggest asking "what hold music is playing right now?" instead.
CRITICAL: you yourself cannot execute changes. If a NEW DND or hold-music request reaches you,
THAT message was not executed — NEVER say it is done, fixed, or "will happen automatically".
Apologize briefly and ask the client to send it as ONE short sentence, e.g. "change the hold
music to Main for 20 minutes".
CRITICAL — past changes: whether an EARLIER request was executed is answered ONLY by the
"RECENT AUTOMATED CHANGES" list in your context (EXECUTED = done and verified; FAILED = did
not happen). NEVER claim a change did or didn't happen from memory or conversation flow alone.
If the list is absent or doesn't mention it, say you can't confirm and suggest asking
"what hold music is playing right now?".
EVERYTHING ELSE (other changes, diagnostics): you cannot do it yet — warmly say the request has
been passed to the human team, and summarize it clearly.
Never invent capabilities, never promise timelines, never discuss other tenants or internal systems.`;

/**
 * When the Yiddish Labs translate-bridge is active, the LLM must reason and
 * answer ONLY in English. Yiddish Labs handles BOTH translation legs (Yiddish→
 * English in, English→Yiddish out), so the customer only ever sees YL's
 * authentic heimishe Yiddish — never model-generated Yiddish.
 */
const SYSTEM_PROMPT_BRIDGE = `${SYSTEM_PROMPT}
TRANSLATION BRIDGE ACTIVE: Write your reply in clear, simple English ONLY. Never output Yiddish or Hebrew-script text — a dedicated Yiddish translation service renders your English into authentic Yiddish for the customer. Keep sentences short and plain so they translate cleanly.`;

/**
 * Whole-sentence dominant language. This audience code-switches heavily —
 * Yiddish is spoken with many English loanwords mixed in — so a single English
 * word must NOT flip a Yiddish sentence to English (and one Yiddish word must not
 * flip an English sentence to Yiddish). Decide by the SHARE of Hebrew-script
 * (Yiddish) letters among all letters, leaning Yiddish (the community's base
 * language), rather than by mere presence of one character.
 */
export const YIDDISH_DOMINANCE_THRESHOLD = 0.2;
export function detectLanguage(text: string): "en" | "yi" {
  const hebrew = (text.match(/[֐-׿]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const letters = hebrew + latin;
  if (letters === 0) return "en"; // no alphabetic content → default English
  // ≥20% Hebrew-script letters ⇒ Yiddish. A Yiddish sentence peppered with
  // English words still clears this; near-pure English (a stray Yiddish word)
  // does not. Tune YIDDISH_DOMINANCE_THRESHOLD if the lean needs adjusting.
  return hebrew / letters >= YIDDISH_DOMINANCE_THRESHOLD ? "yi" : "en";
}

/**
 * Yiddish Labs translate-bridge. Source language is auto-detected by YL; the
 * method name selects the target. `YiddishLabsClient` satisfies this shape.
 */
export interface TranslatorLike {
  readonly configured: boolean;
  toEnglish(text: string): Promise<{ text: string; creditsConsumed: number }>;
  toYiddish(text: string): Promise<{ text: string; creditsConsumed: number }>;
}

export interface ChatContext {
  tenantId: string;
  clientUserId: string | null;
  role: Role;
  channel?: string;
}

export interface ChatResult {
  conversationId: string;
  reply: string;
  language: "en" | "yi";
  model?: string;
  degraded: boolean;
}

/** Minimal triage interface the engine calls (avoids a hard import cycle). */
export interface TriageLike {
  handle(
    intent: { kind: string } & Record<string, unknown>,
    ctx: { tenantId: string; clientUserId: string | null; role: Role; conversationId?: string },
    language: "en" | "yi",
  ): Promise<{ handled: boolean; reply?: string; yiddish?: string; diagReportId?: string; actionId?: string }>;
}

export interface RateLimitLike {
  check(tenantId: string, kind: "messages", opts?: { now?: number }): string | null;
}

/**
 * X2: builds the verified identity + dossier system block for a session.
 * ok:false ⇒ identity could not be verified/built ⇒ the session runs
 * FAIL-CLOSED info-only: no triage (no diagnostics, no action drafting).
 */
export type ContextProvider = (ctx: ChatContext) => Promise<{ ok: true; block: string | null } | { ok: false; reason?: string }>;

export class ConversationEngine {
  constructor(
    private store: ConversationStore,
    private llm: ModelRouter | null,
    private audit: AuditLog,
    private triage: TriageLike | null = null,
    private rateLimiter: RateLimitLike | null = null,
    private translator: TranslatorLike | null = null,
    private bridgeEnabled = false,
    private contextProvider: ContextProvider | null = null,
  ) {}

  /** Is the YL translate-bridge active for this turn? Yiddish + YL configured + enabled. */
  private bridging(language: "en" | "yi"): boolean {
    return this.bridgeEnabled && language === "yi" && !!this.translator?.configured;
  }

  /**
   * Finish a bridged turn: translate the LLM's English reply → Yiddish via YL,
   * persist both sides (Yiddish user-facing + English mirror), and return the
   * Yiddish to the customer. On YL failure, degrade to a canned Yiddish note —
   * never leaks model-generated Yiddish.
   */
  private async finishBridged(
    conv: ConversationRow,
    ctx: ChatContext,
    englishReply: string,
    model: string,
    inDegraded: boolean,
  ): Promise<ChatResult> {
    let userFacing: string;
    let degraded = inDegraded;
    try {
      const out = await this.translator!.toYiddish(englishReply);
      userFacing = out.text?.trim() || fallbackReply("yi");
    } catch (err) {
      userFacing = fallbackReply("yi");
      degraded = true;
      await this.audit.record({ actor: "system", event: "chat.bridge_out_failed", tenantId: ctx.tenantId, conversationId: conv.id, payload: { error: String(err) } });
    }
    await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: userFacing, contentEn: englishReply, model });
    await this.audit.record({ actor: "agent", event: "chat.agent_reply", tenantId: ctx.tenantId, conversationId: conv.id, payload: { model, degraded, bridged: true } });
    return { conversationId: conv.id, reply: userFacing, language: "yi", model, degraded };
  }

  async getOrOpenConversation(ctx: ChatContext): Promise<ConversationRow> {
    const open = await this.store.findOpen(ctx.tenantId, ctx.clientUserId);
    if (open) return open;
    const conv = await this.store.create({
      tenantId: ctx.tenantId,
      clientUserId: ctx.clientUserId,
      role: ctx.role,
      channel: ctx.channel ?? "chat",
    });
    await this.audit.record({ actor: ctx.role, event: "conversation.opened", tenantId: ctx.tenantId, conversationId: conv.id });
    return conv;
  }

  async handleMessage(ctx: ChatContext, text: string): Promise<ChatResult> {
    const language = detectLanguage(text);
    const bridging = this.bridging(language);

    // Per-tenant rate cap (Phase 7) — checked before any work. Owners exempt.
    if (this.rateLimiter && ctx.role !== "owner") {
      const denial = this.rateLimiter.check(ctx.tenantId, "messages");
      if (denial) {
        const conv0 = await this.getOrOpenConversation(ctx);
        const english = "We've received a lot of requests from your account today. Please try again later or contact us directly.";
        if (bridging) return this.finishBridged(conv0, ctx, english, "ratelimit", true);
        const reply = language === "yi" ? "מיר האָבן באַקומען צו פֿיל אָנפֿרעגן פֿון אײַער קאָנטע היינט. ביטע פּרובירט שפּעטער אָדער רופֿט אונדז." : english;
        await this.store.addMessage({ conversationId: conv0.id, role: "assistant", content: reply, model: "ratelimit" });
        await this.audit.record({ actor: "system", event: "chat.rate_limited", tenantId: ctx.tenantId, conversationId: conv0.id, payload: { denial } });
        return { conversationId: conv0.id, reply, language, degraded: true };
      }
    }

    const conv = await this.getOrOpenConversation(ctx);
    if (!conv.language) await this.store.setLanguage(conv.id, language);

    // ── INPUT LEG ── Yiddish → English via Yiddish Labs, so the LLM reasons in
    // English. The original Yiddish is stored as the user's message; the English
    // mirror (contentEn) drives triage + the LLM and feeds the tuning corpus.
    let englishText = text;
    let bridgeDegraded = false;
    if (bridging) {
      try {
        const inTx = await this.translator!.toEnglish(text);
        englishText = inTx.text?.trim() || text;
      } catch (err) {
        bridgeDegraded = true;
        await this.audit.record({ actor: "system", event: "chat.bridge_in_failed", tenantId: ctx.tenantId, conversationId: conv.id, payload: { error: String(err) } });
      }
    }

    await this.store.addMessage({ conversationId: conv.id, role: "user", content: text, contentEn: bridging ? englishText : undefined });
    await this.audit.record({ actor: ctx.role, event: "chat.user_message", tenantId: ctx.tenantId, conversationId: conv.id, payload: { chars: text.length, language, bridged: bridging } });

    // Kill switch / disabled: store, acknowledge read-only, never call tools or LLM actions.
    if (killSwitchEngaged()) {
      const english = "The support assistant is currently paused. Your message has been recorded and passed to the team.";
      if (bridging) return this.finishBridged(conv, ctx, english, "killswitch", true);
      const reply = language === "yi"
        ? "דער סופּפּאָרט אַסיסטענט איז יעצט נישט אַקטיוו. אײַער מעסעדזש איז איבערגעגעבן געוואָרן צום טים."
        : english;
      await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: reply, model: "killswitch" });
      return { conversationId: conv.id, reply, language, degraded: true };
    }

    // ── X2 IDENTITY ── Build the verified identity + dossier block. Identity
    // comes from the server-verified ctx, NEVER from chat text. If the build
    // fails, the session is FAIL-CLOSED info-only: no triage (no diagnostics,
    // no action drafting) — take a message and suggest re-login.
    let identityBlock: string | null = null;
    let infoOnly = false;
    if (this.contextProvider) {
      try {
        const idr = await this.contextProvider(ctx);
        if (idr.ok) identityBlock = idr.block;
        else {
          infoOnly = true;
          await this.audit.record({ actor: "system", event: "identity.fail_closed", tenantId: ctx.tenantId, conversationId: conv.id, payload: { reason: (idr as any).reason ?? "unknown" } });
        }
      } catch (err) {
        infoOnly = true;
        await this.audit.record({ actor: "system", event: "identity.fail_closed", tenantId: ctx.tenantId, conversationId: conv.id, payload: { reason: String(err) } });
      }
    }
    if (infoOnly) {
      const english =
        "I couldn't verify your account details just now, so to be safe I can only take a message — no lookups or changes. Your message has been recorded for the team. Logging out and back in usually fixes this.";
      if (bridging) return this.finishBridged(conv, ctx, english, "identity-failclosed", true);
      const reply = language === "yi"
        ? "איך האָב יעצט נישט געקענט באַשטעטיקן אײַער קאָנטע, דעריבער קען איך בלויז איבערגעבן אַ מעסעדזש צום טים. ביטע פּרובירט זיך אויסלאָגן און ווידער אײַנלאָגן."
        : english;
      await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: reply, model: "identity-failclosed" });
      return { conversationId: conv.id, reply, language, degraded: true };
    }

    // Triage: if the message is an actionable intent (diagnostic or a catalog
    // action) and a triage orchestrator is wired, handle it deterministically
    // (policy-gated, approval-gated) before falling back to conversational LLM.
    // Intent detection runs on the ENGLISH text when bridging (numbers/keywords
    // parse more reliably), and the English reply is translated back via YL.
    if (this.triage) {
      try {
        const { detectIntent } = await import("../triage/intent");
        const intent = detectIntent(bridging ? englishText : text);
        // Chat-kind intents also go through triage: a bare reply like "Main"
        // may be the answer to triage's own pending clarifying question
        // (resume path). Triage returns handled:false for genuine small talk.
        const outcome = await this.triage.handle(intent, { tenantId: ctx.tenantId, clientUserId: ctx.clientUserId, role: ctx.role, conversationId: conv.id }, language);
        if (outcome.handled && outcome.reply) {
          if (bridging) return this.finishBridged(conv, ctx, outcome.reply, "triage", bridgeDegraded);
          const reply = language === "yi" && outcome.yiddish ? outcome.yiddish : outcome.reply;
          await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: reply, model: "triage" });
          await this.audit.record({ actor: "agent", event: "chat.triage_reply", tenantId: ctx.tenantId, conversationId: conv.id, payload: { intent: intent.kind, diagReportId: outcome.diagReportId, actionId: outcome.actionId } });
          return { conversationId: conv.id, reply, language, model: "triage", degraded: false };
        }
      } catch (err) {
        await this.audit.record({ actor: "system", event: "chat.triage_failed", conversationId: conv.id, payload: { error: String(err) } });
      }
    }

    // Build short history for context (last 20 messages). When bridging, feed the
    // English mirror so the model stays entirely in English.
    const history = await this.store.listMessages(conv.id, 100);
    const msgs: ChatMessage[] = [
      { role: "system", content: bridging ? SYSTEM_PROMPT_BRIDGE : SYSTEM_PROMPT },
      ...(identityBlock ? [{ role: "system" as const, content: identityBlock }] : []),
      ...history.slice(-20).map((m) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        content: bridging ? (m.contentEn ?? m.content) : m.content,
      })),
    ];

    // Fallback English used when the LLM is unavailable or errors.
    const teamFallbackEn = "I've received your message and passed it to our team — someone will follow up with you shortly.";

    if (this.llm && this.llm.available().length > 0) {
      try {
        const res = await this.llm.complete("support_chat", msgs, { maxTokens: 800, conversationId: conv.id });
        const model = `${res.provider}:${res.model}`;
        if (bridging) {
          const englishReply = res.text.trim() || teamFallbackEn;
          return this.finishBridged(conv, ctx, englishReply, model, bridgeDegraded);
        }
        const reply = res.text.trim() || fallbackReply(language);
        await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: reply, model });
        await this.audit.record({ actor: "agent", event: "chat.agent_reply", tenantId: ctx.tenantId, conversationId: conv.id, payload: { model, degraded: false, bridged: false } });
        return { conversationId: conv.id, reply, language, model, degraded: false };
      } catch (err) {
        await this.audit.record({ actor: "system", event: "chat.llm_failed", conversationId: conv.id, payload: { error: String(err) } });
        if (bridging) return this.finishBridged(conv, ctx, teamFallbackEn, "fallback", true);
      }
    }

    // No LLM (or LLM failed in non-bridging mode): canned fallback.
    if (bridging) return this.finishBridged(conv, ctx, teamFallbackEn, "fallback", true);
    const reply = fallbackReply(language);
    await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: reply });
    await this.audit.record({ actor: "agent", event: "chat.agent_reply", tenantId: ctx.tenantId, conversationId: conv.id, payload: { degraded: true, bridged: false } });
    return { conversationId: conv.id, reply, language, degraded: true };
  }

  async closeConversation(ctx: ChatContext, conversationId: string): Promise<boolean> {
    const conv = await this.store.getConversation(conversationId);
    if (!conv || conv.tenantId !== ctx.tenantId) return false; // tenant isolation — absolute
    if (ctx.role !== "owner" && conv.clientUserId !== ctx.clientUserId) return false;
    await this.store.close(conversationId);
    await this.audit.record({ actor: ctx.role, event: "conversation.closed", tenantId: ctx.tenantId, conversationId });
    return true;
  }

  async autoCloseStale(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - AUTO_CLOSE_HOURS * 3600 * 1000);
    const n = await this.store.closeStale(cutoff);
    if (n > 0) await this.audit.record({ actor: "system", event: "conversation.auto_closed", payload: { count: n } });
    return n;
  }

  /** Client-facing history. Gated per tenant; owner surface bypasses via role. */
  async listHistory(ctx: ChatContext): Promise<{ visible: boolean; conversations: ConversationRow[] }> {
    if (ctx.role !== "owner") {
      const visible = await this.store.historyVisible(ctx.tenantId);
      if (!visible) return { visible: false, conversations: [] };
    }
    const conversations = await this.store.listConversations(ctx.tenantId, ctx.clientUserId);
    return { visible: true, conversations };
  }

  async getMessages(ctx: ChatContext, conversationId: string) {
    const conv = await this.store.getConversation(conversationId);
    if (!conv || conv.tenantId !== ctx.tenantId) return null;
    if (ctx.role !== "owner" && conv.clientUserId !== ctx.clientUserId) return null;
    return this.store.listMessages(conversationId);
  }
}

function fallbackReply(language: "en" | "yi"): string {
  return language === "yi"
    ? "איך האָב אײַער מעסעדזש באַקומען און איבערגעגעבן צום טים — עמעצער וועט זיך באַלד פֿאַרבינדן מיט אײַך."
    : "I've received your message and passed it to our team — someone will follow up with you shortly.";
}
