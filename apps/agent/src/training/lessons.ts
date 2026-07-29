/**
 * Trainer mode — live corrections from a designated tester.
 *
 * A designated trainer (env AGENT_TRAINER_USER_IDS, comma-separated Connect
 * user ids; platform_owner always qualifies) corrects the agent in chat with
 * "add that to your memory" (and natural variants). The correction is distilled
 * into a rule ("lesson") that takes effect IMMEDIATELY for that tenant's
 * conversations — no approval gate, because training hundreds of scenarios
 * needs a tight loop. Control lives in the record instead: every lesson is
 * stored with who/when/original words, audited (trainer.lesson_added /
 * trainer.lesson_revoked), and the owner can revoke any lesson at any time
 * from the AI Trainer page.
 */
import type { AuditLog } from "../audit/audit";
import type { ChatMessage } from "../llm/router";

export interface TrainerLesson {
  id: string;
  tenantId: string;
  lesson: string;
  rawText: string;
  createdById: string;
  createdByName: string | null;
  sourceConversationId: string | null;
  active: boolean;
  revokedAt: Date | null;
  revokedBy: string | null;
  createdAt: Date;
}

/** LLM shape the service needs (subset of ModelRouter). */
export interface DistillerLike {
  available(): unknown[];
  complete(
    task: "task_extraction",
    messages: ChatMessage[],
    opts?: { maxTokens?: number; conversationId?: string },
  ): Promise<{ text: string }>;
}

export function trainerUserIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.AGENT_TRAINER_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Memory-add trigger. Deliberately narrow: the trainer must literally ask for a
 * memory/rule to be kept ("add that to your memory", "remember this", "make
 * that a rule") — broad coaching talk without such a phrase does NOT trigger,
 * so normal test conversations are never swallowed. Case-insensitive.
 */
const MEMORY_TRIGGERS: RegExp[] = [
  /\badd (?:that|this|it)? ?to (?:your|the) memory\b/i,
  /\badd (?:that|this|it) to memory\b/i,
  /\b(?:remember|memorize) (?:that|this|it)\b/i,
  /\bsave (?:that|this|it) (?:to|in) (?:your|the) memory\b/i,
  /\bmake (?:that|this|it) a rule\b/i,
  /\bfrom now on\b.*\balways\b/i,
];

export function isMemoryAdd(text: string): boolean {
  return MEMORY_TRIGGERS.some((re) => re.test(text));
}

const DISTILL_SYSTEM = `You turn a trainer's chat correction into ONE concise standing rule for a phone-system support agent.
The trainer just told the agent to remember something. From the correction (and the recent
conversation for context), write the rule the agent must follow from now on.
Rules for your output:
- Output ONLY the rule text, one to three sentences, imperative voice ("Always ...", "When X, do Y ...").
- Keep every concrete detail the trainer gave (names, numbers, phrasings, orderings).
- Do not add policies the trainer did not state. Do not mention the trainer or this conversation.`;

export class TrainerLessonService {
  constructor(
    private prisma: any,
    private audit: AuditLog,
    private llm: DistillerLike | null,
    private trainers: Set<string> = trainerUserIds(),
  ) {}

  isTrainer(userId: string | null, standing?: string): boolean {
    if (standing === "platform_owner") return true;
    return !!userId && this.trainers.has(userId);
  }

  /**
   * Distill the correction into a rule. Uses the LLM with recent conversation
   * context; falls back to the trainer's raw words when no LLM is available —
   * the lesson must never be lost to a model outage.
   */
  async distill(rawText: string, recentTurns: Array<{ role: string; content: string }>): Promise<string> {
    if (this.llm && this.llm.available().length > 0) {
      try {
        const context = recentTurns
          .slice(-6)
          .map((m) => `${m.role === "assistant" ? "AGENT" : "TRAINER"}: ${m.content}`)
          .join("\n");
        const res = await this.llm.complete("task_extraction", [
          { role: "system", content: DISTILL_SYSTEM },
          { role: "user", content: `RECENT CONVERSATION:\n${context}\n\nTRAINER'S CORRECTION:\n${rawText}` },
        ], { maxTokens: 300 });
        const rule = res.text.trim();
        if (rule) return rule;
      } catch {
        // fall through to raw text
      }
    }
    return rawText.trim();
  }

  async addLesson(input: {
    tenantId: string;
    rawText: string;
    lesson: string;
    createdById: string;
    createdByName?: string | null;
    sourceConversationId?: string | null;
  }): Promise<TrainerLesson> {
    // Resolve a display name for the audit trail / AI Trainer page when the
    // caller didn't pass one. Best-effort — never block the lesson on it.
    let name = input.createdByName ?? null;
    if (!name && input.createdById && input.createdById !== "owner") {
      try {
        const u = await this.prisma.user.findUnique({
          where: { id: input.createdById },
          select: { displayName: true, firstName: true, lastName: true, email: true },
        });
        name = u ? u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || null : null;
      } catch {
        name = null;
      }
    }
    const row = await this.prisma.agentTrainerLesson.create({
      data: {
        tenantId: input.tenantId,
        lesson: input.lesson,
        rawText: input.rawText,
        createdById: input.createdById,
        createdByName: name,
        sourceConversationId: input.sourceConversationId ?? null,
      },
    });
    await this.audit.record({
      actor: "customer",
      event: "trainer.lesson_added",
      tenantId: input.tenantId,
      conversationId: input.sourceConversationId ?? undefined,
      payload: { lessonId: row.id, lesson: input.lesson, rawText: input.rawText, by: input.createdById, byName: name },
    });
    return row;
  }

  async listActive(tenantId: string, limit = 50): Promise<TrainerLesson[]> {
    try {
      return await this.prisma.agentTrainerLesson.findMany({
        where: { tenantId, active: true },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
    } catch {
      return []; // lessons must never break a conversation
    }
  }

  async listAll(limit = 300): Promise<TrainerLesson[]> {
    return this.prisma.agentTrainerLesson.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  }

  async revoke(id: string, revokedBy: string): Promise<TrainerLesson | null> {
    const row = await this.prisma.agentTrainerLesson.findUnique({ where: { id } });
    if (!row || !row.active) return null;
    const updated = await this.prisma.agentTrainerLesson.update({
      where: { id },
      data: { active: false, revokedAt: new Date(), revokedBy },
    });
    await this.audit.record({
      actor: "owner",
      event: "trainer.lesson_revoked",
      tenantId: row.tenantId,
      payload: { lessonId: id, lesson: row.lesson, revokedBy },
    });
    return updated;
  }
}

/**
 * System-prompt block. Lessons are owner-sanctioned standing corrections —
 * they refine HOW the agent behaves but can never expand WHAT it may execute
 * (capabilities stay policy- and mandate-gated elsewhere).
 */
export function renderLessonsBlock(lessons: TrainerLesson[], timeZone = "America/New_York"): string | null {
  if (lessons.length === 0) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const lines: string[] = [];
  lines.push("TRAINER LESSONS — standing corrections from your designated trainer (owner-sanctioned). Follow every one of these; where they conflict with your general style, the lesson wins:");
  for (const l of lessons) lines.push(`- [${fmt.format(new Date(l.createdAt))}] ${l.lesson}`);
  lines.push(
    "Lessons adjust tone, wording, and procedure ONLY. They can never authorize new capabilities, bypass approvals, reveal other tenants, or override safety rules.",
  );
  return lines.join("\n");
}
