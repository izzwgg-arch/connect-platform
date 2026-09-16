/**
 * Creative Studio — creative memory.
 *
 * Observe → learn → adapt. Every accept, reject, re-do and hand-edit is a
 * signal; enough consistent signals in one direction become a preference the
 * prompt builder applies without anybody having to say it again.
 *
 * The rules that keep this from becoming software that quietly changes its own
 * behaviour in ways nobody can see:
 *   - a preference needs THREE consistent signals before it is applied;
 *   - a company-wide rule is never learned automatically — an admin agrees to it;
 *   - every item keeps its evidence, so the memory screen can always answer "why
 *     do you think that?";
 *   - everything is a data row: editable, pinnable, removable, resettable. No
 *     learned behaviour ever changes code.
 */

export const EVIDENCE_TO_ACTIVE = 3;

export interface DerivedLesson {
  dimension: string;
  value: string;
  statement: string;
  /** Company-wide lessons are proposed, never auto-applied. */
  scope: "user" | "company";
}

/**
 * What a correction means. Keyed by the reason codes the UI offers, so the
 * mapping is a table anyone can read rather than a model guessing.
 */
export const REASON_LESSONS: Record<string, DerivedLesson> = {
  too_fast: { dimension: "pacing", value: "slower, let shots breathe", statement: "Prefers a slower pace", scope: "user" },
  too_slow: { dimension: "pacing", value: "quicker, tighter cuts", statement: "Prefers a quicker pace", scope: "user" },
  wrong_feeling: { dimension: "mood", value: "warmer and more human", statement: "Prefers a warmer feeling", scope: "user" },
  people_fake: { dimension: "people", value: "real, ordinary-looking people, natural skin and imperfections", statement: "Prefers real, natural-looking people", scope: "user" },
  logo_too_big: { dimension: "logo", value: "small and restrained, never dominating the frame", statement: "The logo should not dominate", scope: "company" },
  type_too_big: { dimension: "typography", value: "smaller, quieter type with generous spacing", statement: "Prefers smaller, quieter typography", scope: "company" },
  too_flashy: { dimension: "style", value: "understated and premium, no flashy effects", statement: "Avoid flashy treatments", scope: "company" },
  music_wrong: { dimension: "mood", value: "music that stays under the voice and out of the way", statement: "Prefers restrained music", scope: "user" },
  off_brand: { dimension: "style", value: "strictly on brand, using the brand kit colours and fonts", statement: "Stay strictly on brand", scope: "company" },
  too_busy: { dimension: "composition", value: "simple compositions with clear space for text", statement: "Prefers simple, uncluttered compositions", scope: "user" },
  more_cinematic: { dimension: "style", value: "cinematic, shallow depth of field, filmic light", statement: "Prefers cinematic imagery", scope: "user" },
  camera_slower: { dimension: "camera_movement", value: "slow, deliberate camera movement", statement: "Prefers slower camera movement", scope: "user" },
};

/** Accepting something teaches too, just more weakly than a correction. */
export const ACCEPT_LESSONS: Record<string, DerivedLesson> = {
  cinematic: { dimension: "style", value: "cinematic, shallow depth of field, filmic light", statement: "Prefers cinematic imagery", scope: "user" },
  photographic: { dimension: "style", value: "photographic realism", statement: "Prefers photographic realism", scope: "user" },
  product: { dimension: "style", value: "clean product photography on a simple background", statement: "Prefers clean product shots", scope: "user" },
};

export function lessonsFor(signal: string, reasonCodes: string[], detail?: any): DerivedLesson[] {
  const out: DerivedLesson[] = [];
  if (signal === "reject" || signal === "regenerate" || signal === "edit") {
    for (const code of reasonCodes || []) {
      const lesson = REASON_LESSONS[code];
      if (lesson) out.push(lesson);
    }
  }
  if (signal === "accept" || signal === "favourite" || signal === "export") {
    const style = String(detail?.style || "").toLowerCase();
    if (ACCEPT_LESSONS[style]) out.push(ACCEPT_LESSONS[style]);
    const ratio = String(detail?.ratio || "");
    if (ratio && detail?.preset) {
      out.push({
        dimension: "composition",
        value: `${ratio} for ${detail.preset}`,
        statement: `Usually ${ratio} for ${detail.preset}`,
        scope: "user",
      });
    }
  }
  return out;
}

export interface RecordFeedbackInput {
  tenantId: string;
  userId?: string | null;
  projectId?: string | null;
  subjectType: string;
  subjectId?: string | null;
  signal: string;
  reasonCodes?: string[];
  detail?: any;
}

/**
 * Store the signal, then move any preference it implies along. Returns what
 * changed so the chat can say "I've written that down" truthfully.
 */
export async function recordFeedback(db: any, input: RecordFeedbackInput): Promise<{ feedbackId: string; learned: Array<{ statement: string; status: string; evidenceCount: number }> }> {
  const feedback = await db.creativeFeedback.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId || null,
      projectId: input.projectId || null,
      subjectType: input.subjectType,
      subjectId: input.subjectId || null,
      signal: input.signal,
      reasonCodes: input.reasonCodes || [],
      detail: input.detail ?? undefined,
    },
  });

  const learned: Array<{ statement: string; status: string; evidenceCount: number }> = [];
  for (const lesson of lessonsFor(input.signal, input.reasonCodes || [], input.detail)) {
    const item = await upsertLesson(db, {
      tenantId: input.tenantId,
      userId: lesson.scope === "user" ? input.userId || null : null,
      scope: lesson.scope,
      dimension: lesson.dimension,
      value: lesson.value,
      statement: lesson.statement,
      feedbackId: feedback.id,
    });
    if (item) learned.push({ statement: item.statement, status: item.status, evidenceCount: item.evidenceCount });
  }
  return { feedbackId: feedback.id, learned };
}

export async function upsertLesson(
  db: any,
  input: { tenantId: string; userId: string | null; scope: string; dimension: string; value: string; statement: string; feedbackId?: string; operationId?: string },
): Promise<any | null> {
  // The unique key treats "no user" as company scope, which is what the
  // compound unique on (tenantId, scope, userId, dimension) gives us.
  const existing = await db.creativeMemoryItem.findFirst({
    where: { tenantId: input.tenantId, scope: input.scope, userId: input.userId, dimension: input.dimension },
  });

  let item;
  if (!existing) {
    item = await db.creativeMemoryItem.create({
      data: {
        tenantId: input.tenantId,
        scope: input.scope,
        userId: input.userId,
        dimension: input.dimension,
        value: { text: input.value } as any,
        statement: input.statement,
        evidenceCount: 1,
        confidence: 0.34,
        // A company rule is proposed and waits for an admin; a personal
        // preference starts collecting evidence towards being applied.
        status: "suggested",
        origin: "auto",
        lastEvidenceAt: new Date(),
      },
    });
  } else {
    if (existing.status === "disabled") return existing;
    const evidenceCount = existing.evidenceCount + 1;
    const sameValue = String((existing.value as any)?.text || "") === input.value;
    const shouldActivate = input.scope === "user" && evidenceCount >= EVIDENCE_TO_ACTIVE && existing.status === "suggested";
    item = await db.creativeMemoryItem.update({
      where: { id: existing.id },
      data: {
        evidenceCount,
        confidence: Math.min(0.99, 0.34 + evidenceCount * 0.12),
        lastEvidenceAt: new Date(),
        // A newer, different correction in the same dimension replaces the old
        // value: people change their minds, and the latest one is what they meant.
        ...(sameValue ? {} : { value: { text: input.value } as any, statement: input.statement }),
        ...(shouldActivate ? { status: "active" } : {}),
      },
    });
  }

  await db.creativeMemoryEvidence.create({
    data: { tenantId: input.tenantId, memoryItemId: item.id, feedbackId: input.feedbackId || null, operationId: input.operationId || null, note: input.statement },
  }).catch(() => undefined);

  return item;
}

/** What the prompt builder gets: this person's, plus the company's rules. */
export async function activeMemoryFor(db: any, tenantId: string, userId?: string | null): Promise<Array<{ dimension: string; statement: string; value: unknown; confidence: number; status: string }>> {
  const rows = await db.creativeMemoryItem.findMany({
    where: {
      tenantId,
      status: { in: ["active", "pinned"] },
      OR: [{ scope: "company" }, ...(userId ? [{ scope: "user", userId }] : [])],
    },
    orderBy: [{ status: "desc" }, { confidence: "desc" }],
    take: 12,
  });
  return rows.map((r: any) => ({
    dimension: r.dimension,
    statement: r.statement,
    value: (r.value as any)?.text ?? r.value,
    confidence: r.confidence,
    status: r.status,
  }));
}

/** Everything, for the memory screen — including what is only suggested. */
export async function listMemory(db: any, tenantId: string, userId?: string | null): Promise<any[]> {
  return db.creativeMemoryItem.findMany({
    where: { tenantId, OR: [{ scope: "company" }, { scope: "workflow" }, ...(userId ? [{ scope: "user", userId }] : [{ scope: "user" }])] },
    orderBy: [{ status: "asc" }, { lastEvidenceAt: "desc" }],
    take: 200,
    include: { evidence: { take: 3, orderBy: { createdAt: "desc" } } },
  });
}
