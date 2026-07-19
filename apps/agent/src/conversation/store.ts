/**
 * Conversation persistence interface + Prisma implementation.
 * The engine depends on this interface so its logic is unit-testable with an
 * in-memory fake, per certification requirements.
 */
export type Role = "owner" | "customer";

export interface ConversationRow {
  id: string;
  tenantId: string;
  clientUserId: string | null;
  role: string;
  channel: string;
  language: string | null;
  status: "OPEN" | "CLOSED";
  startedAt: Date;
  closedAt: Date | null;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  model?: string | null;
  createdAt: Date;
}

export interface ConversationStore {
  findOpen(tenantId: string, clientUserId: string | null): Promise<ConversationRow | null>;
  create(input: { tenantId: string; clientUserId: string | null; role: Role; channel: string; language?: string | null }): Promise<ConversationRow>;
  close(id: string): Promise<void>;
  closeStale(olderThan: Date): Promise<number>;
  addMessage(input: { conversationId: string; role: string; content: string; model?: string; inputTokens?: number; outputTokens?: number }): Promise<MessageRow>;
  listMessages(conversationId: string, limit?: number): Promise<MessageRow[]>;
  listConversations(tenantId: string, clientUserId: string | null, limit?: number): Promise<ConversationRow[]>;
  getConversation(id: string): Promise<ConversationRow | null>;
  setLanguage(id: string, language: string): Promise<void>;
  historyVisible(tenantId: string): Promise<boolean>;
}

export class PrismaConversationStore implements ConversationStore {
  constructor(private prisma: any) {}

  findOpen(tenantId: string, clientUserId: string | null) {
    return this.prisma.agentConversation.findFirst({
      where: { tenantId, clientUserId, status: "OPEN" },
      orderBy: { startedAt: "desc" },
    });
  }

  create(input: { tenantId: string; clientUserId: string | null; role: Role; channel: string; language?: string | null }) {
    return this.prisma.agentConversation.create({
      data: {
        tenantId: input.tenantId,
        clientUserId: input.clientUserId,
        role: input.role,
        channel: input.channel.toUpperCase(),
        language: input.language ?? null,
      },
    });
  }

  async close(id: string) {
    await this.prisma.agentConversation.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date() } });
  }

  async closeStale(olderThan: Date) {
    // A conversation is stale when its most recent message is older than the cutoff.
    const stale = await this.prisma.agentConversation.findMany({
      where: { status: "OPEN", startedAt: { lt: olderThan } },
      select: { id: true, messages: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } },
    });
    let closed = 0;
    for (const c of stale) {
      const last = c.messages[0]?.createdAt ?? null;
      if (!last || last < olderThan) {
        await this.close(c.id);
        closed++;
      }
    }
    return closed;
  }

  addMessage(input: { conversationId: string; role: string; content: string; model?: string; inputTokens?: number; outputTokens?: number }) {
    return this.prisma.agentMessage.create({ data: input });
  }

  listMessages(conversationId: string, limit = 100) {
    return this.prisma.agentMessage.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" }, take: limit });
  }

  listConversations(tenantId: string, clientUserId: string | null, limit = 50) {
    return this.prisma.agentConversation.findMany({
      where: { tenantId, clientUserId },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
  }

  getConversation(id: string) {
    return this.prisma.agentConversation.findUnique({ where: { id } });
  }

  async setLanguage(id: string, language: string) {
    await this.prisma.agentConversation.update({ where: { id }, data: { language } });
  }

  async historyVisible(tenantId: string): Promise<boolean> {
    const p = await this.prisma.agentPolicy.findUnique({ where: { tenantId } });
    return p?.historyVisible ?? false;
  }
}
