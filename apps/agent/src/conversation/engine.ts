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
CURRENT LIMITATIONS (be honest about them): you cannot yet run diagnostics or make any changes;
those capabilities are being certified. For any request to change or fix something, warmly say the
request has been passed to the human team, and summarize it clearly.
Never invent capabilities, never promise timelines, never discuss other tenants or internal systems.`;

export function detectLanguage(text: string): "en" | "yi" {
  // Hebrew-script characters → treat as Yiddish for this platform's audience.
  return /[֐-׿]/.test(text) ? "yi" : "en";
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

export class ConversationEngine {
  constructor(
    private store: ConversationStore,
    private llm: ModelRouter | null,
    private audit: AuditLog,
    private triage: TriageLike | null = null,
  ) {}

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
    const conv = await this.getOrOpenConversation(ctx);
    if (!conv.language) await this.store.setLanguage(conv.id, language);
    await this.store.addMessage({ conversationId: conv.id, role: "user", content: text });
    await this.audit.record({ actor: ctx.role, event: "chat.user_message", tenantId: ctx.tenantId, conversationId: conv.id, payload: { chars: text.length, language } });

    // Kill switch / disabled: store, acknowledge read-only, never call tools or LLM actions.
    if (killSwitchEngaged()) {
      const reply =
        language === "yi"
          ? "דער סופּפּאָרט אַסיסטענט איז יעצט נישט אַקטיוו. אײַער מעסעדזש איז איבערגעגעבן געוואָרן צום טים."
          : "The support assistant is currently paused. Your message has been recorded and passed to the team.";
      await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: reply, model: "killswitch" });
      return { conversationId: conv.id, reply, language, degraded: true };
    }

    // Triage: if the message is an actionable intent (diagnostic or a catalog
    // action) and a triage orchestrator is wired, handle it deterministically
    // (policy-gated, approval-gated) before falling back to conversational LLM.
    if (this.triage) {
      try {
        const { detectIntent } = await import("../triage/intent");
        const intent = detectIntent(text);
        if (intent.kind !== "chat") {
          const outcome = await this.triage.handle(intent, { tenantId: ctx.tenantId, clientUserId: ctx.clientUserId, role: ctx.role, conversationId: conv.id }, language);
          if (outcome.handled && outcome.reply) {
            const reply = language === "yi" && outcome.yiddish ? outcome.yiddish : outcome.reply;
            await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: reply, model: "triage" });
            await this.audit.record({ actor: "agent", event: "chat.triage_reply", tenantId: ctx.tenantId, conversationId: conv.id, payload: { intent: intent.kind, diagReportId: outcome.diagReportId, actionId: outcome.actionId } });
            return { conversationId: conv.id, reply, language, model: "triage", degraded: false };
          }
        }
      } catch (err) {
        await this.audit.record({ actor: "system", event: "chat.triage_failed", conversationId: conv.id, payload: { error: String(err) } });
      }
    }

    // Build short history for context (last 20 messages).
    const history = await this.store.listMessages(conv.id, 100);
    const msgs: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.slice(-20).map((m) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        content: m.content,
      })),
    ];

    let reply: string;
    let model: string | undefined;
    let degraded = false;
    if (this.llm && this.llm.available().length > 0) {
      try {
        const res = await this.llm.complete("support_chat", msgs, { maxTokens: 800, conversationId: conv.id });
        reply = res.text.trim() || fallbackReply(language);
        model = `${res.provider}:${res.model}`;
      } catch (err) {
        await this.audit.record({ actor: "system", event: "chat.llm_failed", conversationId: conv.id, payload: { error: String(err) } });
        reply = fallbackReply(language);
        degraded = true;
      }
    } else {
      reply = fallbackReply(language);
      degraded = true;
    }

    await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: reply, model });
    await this.audit.record({ actor: "agent", event: "chat.agent_reply", tenantId: ctx.tenantId, conversationId: conv.id, payload: { model, degraded } });
    return { conversationId: conv.id, reply, language, model, degraded };
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
