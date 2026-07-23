/**
 * X2 Per-User Dossier (spec §3) — every user's running markdown file: a summary
 * block per closed conversation + compacted digest of older ones.
 *
 * RECORDING IS UNCONDITIONAL (Izzy, 2026-07-23): dossiers are written for every
 * tenant and every user, always. The history VISIBILITY toggle only controls
 * what a customer sees in the portal — it never suppresses recording or the
 * agent's reading of the dossier.
 *
 * Crash-safe sweep design: closed conversations carry dossierRecordedAt=null
 * until their summary lands; the sweep is idempotent and survives restarts.
 * Optimistic concurrency via `rev` compare-and-set (retry once, then skip +
 * audit — a missed summary never blocks anything and is retried next sweep).
 */
import type { AuditLog } from "../audit/audit";
import type { ModelRouter } from "../llm/router";

export const DOSSIER_MAX_BYTES = 8 * 1024;
export const DOSSIER_KEEP_VERBATIM = 20;

const CHAT_HEADER = "## Chat ";
const DIGEST_HEADER = "## Older chats (digest)";

export class DossierService {
  constructor(
    private prisma: any,
    private audit: AuditLog,
    private llm: ModelRouter | null = null,
  ) {}

  /** Load a user's dossier markdown (null = first contact). */
  async load(tenantId: string, clientUserId: string): Promise<string | null> {
    const row = await this.prisma.agentUserDossier.findUnique({
      where: { tenantId_clientUserId: { tenantId, clientUserId } },
      select: { dossierMd: true },
    });
    return row?.dossierMd ?? null;
  }

  /**
   * Sweep: summarize every CLOSED conversation not yet recorded. Called from
   * the same 5-minute scheduler tick as auto-close. Idempotent.
   */
  async sweep(limit = 25): Promise<number> {
    const due = await this.prisma.agentConversation.findMany({
      where: { status: "CLOSED", dossierRecordedAt: null },
      orderBy: { closedAt: "asc" },
      take: limit,
      select: { id: true, tenantId: true, clientUserId: true, channel: true, language: true, startedAt: true, closedAt: true },
    });
    let recorded = 0;
    for (const conv of due) {
      try {
        if (await this.recordConversation(conv)) recorded++;
      } catch (err) {
        await this.audit.record({ actor: "system", event: "dossier.record_failed", tenantId: conv.tenantId, conversationId: conv.id, payload: { error: String(err) } });
      }
    }
    return recorded;
  }

  private async recordConversation(conv: {
    id: string;
    tenantId: string;
    clientUserId: string | null;
    channel: string | null;
    language: string | null;
    startedAt: Date;
    closedAt: Date | null;
  }): Promise<boolean> {
    // CLAIM FIRST (multi-instance safe): atomically take ownership of this
    // conversation's summary. A second sweeper racing us gets count=0 and
    // skips — a chat can never land in the dossier twice. On any failure the
    // claim is released so the next sweep retries (raw AgentConversation/
    // AgentMessage records are permanent regardless — the dossier is derived).
    const claimed = await this.prisma.agentConversation.updateMany({
      where: { id: conv.id, dossierRecordedAt: null },
      data: { dossierRecordedAt: new Date() },
    });
    if (!claimed || claimed.count === 0) return false;

    // Conversations without a known user still stay permanently recorded in
    // AgentConversation/AgentMessage — there is just no per-user file to key.
    if (!conv.clientUserId) return true;

    try {
      return await this.appendClaimed(conv as any);
    } catch (err) {
      await this.releaseClaim(conv.id);
      throw err;
    }
  }

  private async appendClaimed(conv: {
    id: string;
    tenantId: string;
    clientUserId: string;
    channel: string | null;
    language: string | null;
    startedAt: Date;
    closedAt: Date | null;
  }): Promise<boolean> {
    const messages = await this.prisma.agentMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true, contentEn: true },
    });
    const actions = await this.prisma.agentAction.findMany({
      where: { conversationId: conv.id },
      select: { capabilityId: true, status: true, summary: true },
    });

    const block = await this.summaryBlock(conv, messages, actions);

    // Upsert with rev CAS (retry once on a concurrent write).
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.prisma.agentUserDossier.findUnique({
        where: { tenantId_clientUserId: { tenantId: conv.tenantId, clientUserId: conv.clientUserId } },
        select: { id: true, rev: true, dossierMd: true },
      });
      if (!existing) {
        try {
          await this.prisma.agentUserDossier.create({
            data: { tenantId: conv.tenantId, clientUserId: conv.clientUserId, dossierMd: compact(block), rev: 1 },
          });
          return true;
        } catch {
          continue; // unique race: another writer created it — retry as update
        }
      }
      const nextMd = compact(`${existing.dossierMd}\n\n${block}`);
      const res = await this.prisma.agentUserDossier.updateMany({
        where: { id: existing.id, rev: existing.rev },
        data: { dossierMd: nextMd, rev: existing.rev + 1 },
      });
      if (res.count > 0) return true;
    }
    // Both attempts lost the dossier CAS — release the claim so the next sweep
    // retries this conversation. Audit so a persistent loser is visible.
    await this.releaseClaim(conv.id);
    await this.audit.record({ actor: "system", event: "dossier.cas_retry_exhausted", tenantId: conv.tenantId, conversationId: conv.id });
    return false;
  }

  private async releaseClaim(conversationId: string): Promise<void> {
    await this.prisma.agentConversation.update({ where: { id: conversationId }, data: { dossierRecordedAt: null } });
  }

  /** LLM summary when available; deterministic fallback ALWAYS works. */
  private async summaryBlock(
    conv: { id: string; channel: string | null; language: string | null; startedAt: Date; closedAt: Date | null },
    messages: Array<{ role: string; content: string; contentEn: string | null }>,
    actions: Array<{ capabilityId: string; status: string; summary: string }>,
  ): Promise<string> {
    const date = (conv.closedAt ?? conv.startedAt).toISOString().slice(0, 10);
    const head = `${CHAT_HEADER}${date} (${conv.channel ?? "chat"}${conv.language ? `, ${conv.language}` : ""})`;
    const firstUser = messages.find((m) => m.role === "user");
    const asked = (firstUser?.contentEn ?? firstUser?.content ?? "(no message)").slice(0, 200);
    const actionLines = actions.map((a) => `- Action: ${a.summary} [${a.capabilityId}] → ${a.status}`);

    let summary: string | null = null;
    if (this.llm && this.llm.available().length > 0) {
      try {
        const transcript = messages
          .slice(-30)
          .map((m) => `${m.role}: ${(m.contentEn ?? m.content).slice(0, 300)}`)
          .join("\n");
        const res = await this.llm.complete(
          "report_writing",
          [
            { role: "system", content: "Summarize this support chat in 2-3 short plain-English bullet points: what was asked, what was done, how it ended. Output only the bullets." },
            { role: "user", content: transcript },
          ],
          { maxTokens: 200, conversationId: conv.id },
        );
        summary = res.text.trim() || null;
      } catch {
        summary = null; // deterministic fallback below
      }
    }

    const body = summary ?? `- Asked: ${asked}\n- Messages: ${messages.length}`;
    return [head, body, ...actionLines].join("\n");
  }
}

/**
 * Compaction: keep a leading non-chat preamble (facts etc.), the digest
 * section, and the last DOSSIER_KEEP_VERBATIM chat blocks verbatim. Older chat
 * blocks collapse into one digest line each. Hard-capped at DOSSIER_MAX_BYTES.
 */
export function compact(md: string): string {
  const idx = md.indexOf(CHAT_HEADER);
  let preamble = idx >= 0 ? md.slice(0, idx).trimEnd() : md.trimEnd();
  const chatsRaw = idx >= 0 ? md.slice(idx) : "";
  const blocks = chatsRaw
    .split(new RegExp(`(?=${CHAT_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g"))
    .map((b) => b.trim())
    .filter((b) => b.startsWith(CHAT_HEADER));

  // Existing digest lines live in the preamble section — preserve them.
  let digestLines: string[] = [];
  const dIdx = preamble.indexOf(DIGEST_HEADER);
  if (dIdx >= 0) {
    const after = preamble.slice(dIdx + DIGEST_HEADER.length);
    digestLines = after.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
    preamble = preamble.slice(0, dIdx).trimEnd();
  }

  if (blocks.length > DOSSIER_KEEP_VERBATIM) {
    const overflow = blocks.splice(0, blocks.length - DOSSIER_KEEP_VERBATIM);
    for (const b of overflow) {
      const header = b.split("\n", 1)[0].slice(CHAT_HEADER.length).trim();
      const firstBullet = b.split("\n").find((l) => l.trim().startsWith("- "))?.trim() ?? "";
      digestLines.push(`- ${header}: ${firstBullet.replace(/^- /, "").slice(0, 120)}`);
    }
  }

  const parts: string[] = [];
  if (preamble) parts.push(preamble);
  if (digestLines.length) parts.push(`${DIGEST_HEADER}\n${digestLines.slice(-100).join("\n")}`);
  parts.push(...blocks);
  let out = parts.join("\n\n");

  // Hard byte cap: drop oldest digest lines first, then oldest verbatim blocks.
  while (Buffer.byteLength(out, "utf8") > DOSSIER_MAX_BYTES && digestLines.length > 0) {
    digestLines.shift();
    const p: string[] = [];
    if (preamble) p.push(preamble);
    if (digestLines.length) p.push(`${DIGEST_HEADER}\n${digestLines.join("\n")}`);
    p.push(...blocks);
    out = p.join("\n\n");
  }
  while (Buffer.byteLength(out, "utf8") > DOSSIER_MAX_BYTES && blocks.length > 1) {
    blocks.shift();
    const p: string[] = [];
    if (preamble) p.push(preamble);
    if (digestLines.length) p.push(`${DIGEST_HEADER}\n${digestLines.join("\n")}`);
    p.push(...blocks);
    out = p.join("\n\n");
  }
  return out;
}
