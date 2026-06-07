import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import { assertCrmContactAllowed } from "./crmContactAccess";
import { buildPhoneMatchCandidates, matchTenantContactByPhone } from "./inboundCallerMatch";

const contextQuerySchema = z.object({
  contactId: z.string().min(1).optional(),
  linkedId: z.string().min(1).optional(),
  phone: z.string().min(4).optional(),
  memberId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
});

const CONTACT_INCLUDE = {
  phones: { orderBy: { isPrimary: "desc" as const } },
  emails: { orderBy: { isPrimary: "desc" as const } },
  addresses: true,
  tagLinks: { include: { tag: true } },
  crmMeta: {
    include: {
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
      },
    },
  },
} as const;

export async function registerCrmLiveCallContextRoutes(app: FastifyInstance) {
  app.get("/crm/live-call/context", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;

    const parsed = contextQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_query", detail: parsed.error.format() });
    }

    const { tenantId } = user;
    const { contactId, linkedId, phone, memberId, campaignId } = parsed.data;
    const cdr = linkedId
      ? await db.connectCdr.findFirst({
          where: { linkedId, tenantId },
          select: {
            linkedId: true,
            fromNumber: true,
            fromName: true,
            toNumber: true,
            direction: true,
            disposition: true,
            startedAt: true,
            answeredAt: true,
            endedAt: true,
            durationSec: true,
            talkSec: true,
            recordingPath: true,
          },
        })
      : null;

    const resolvedContactId =
      contactId ??
      (phone ? (await matchTenantContactByPhone(tenantId, phone))?.contactId : null) ??
      (cdr?.fromNumber ? (await matchTenantContactByPhone(tenantId, cdr.fromNumber))?.contactId : null) ??
      (cdr?.toNumber ? (await matchTenantContactByPhone(tenantId, cdr.toNumber))?.contactId : null) ??
      null;

    if (!resolvedContactId) {
      return {
        matched: false,
        reason: "no_crm_contact_matched",
        currentCall: formatCurrentCall({ linkedId, phone, cdr }),
      };
    }

    if (!(await assertCrmContactAllowed(user, resolvedContactId, reply))) return;

    const contact = await (db as any).contact.findFirst({
      where: { id: resolvedContactId, tenantId, active: true, archivedAt: null },
      include: CONTACT_INCLUDE,
    });

    if (!contact?.crmMeta) {
      return {
        matched: false,
        reason: "matched_contact_not_in_crm",
        currentCall: formatCurrentCall({ linkedId, phone, cdr }),
      };
    }

    const primaryPhone = contact.phones?.find((p: any) => p.isPrimary) ?? contact.phones?.[0] ?? null;
    const phoneCandidates = buildCallHistoryPhoneCandidates([
      primaryPhone?.numberRaw,
      phone,
      cdr?.fromNumber,
      cdr?.toNumber,
      ...(contact.phones ?? []).map((p: any) => p.numberRaw),
    ]);

    const [
      settings,
      timeline,
      tasks,
      forms,
      documents,
      scripts,
      checklists,
      checklistResponses,
      campaignContext,
      cdrRows,
      transcript,
    ] = await Promise.all([
      db.crmTenantSettings.findUnique({
        where: { tenantId },
        select: {
          defaultScriptId: true,
          defaultChecklistId: true,
          transcriptionEnabled: true,
        },
      }),
      (db as any).crmTimelineEvent.findMany({
        where: { tenantId, contactId: resolvedContactId },
        orderBy: { createdAt: "desc" },
        take: 40,
        include: {
          createdByUser: {
            select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
          },
        },
      }),
      (db as any).crmContactTask.findMany({
        where: { tenantId, contactId: resolvedContactId, status: { in: ["OPEN", "IN_PROGRESS"] } },
        orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
        take: 12,
        include: {
          assignedTo: { select: { id: true, firstName: true, lastName: true, displayName: true, email: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true, displayName: true, email: true } },
        },
      }),
      (db as any).crmFormRequest.findMany({
        where: { tenantId, contactId: resolvedContactId },
        orderBy: { createdAt: "desc" },
        take: 12,
        include: { formTemplate: { select: { id: true, name: true, category: true } }, submission: true },
      }),
      db.crmLeadDocument.findMany({
        where: { tenantId, contactId: resolvedContactId },
        orderBy: { createdAt: "desc" },
        take: 12,
        select: {
          id: true,
          originalFileName: true,
          mimeType: true,
          sizeBytes: true,
          status: true,
          matchConfidence: true,
          importedAt: true,
          textExtractionStatus: true,
          textExtractedAt: true,
          createdAt: true,
        },
      }),
      db.crmScript.findMany({
        where: { tenantId, isActive: true },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, isActive: true },
      }),
      db.crmChecklist.findMany({
        where: { tenantId, isActive: true },
        orderBy: { createdAt: "desc" },
        include: { items: { orderBy: { sortOrder: "asc" } } },
      }),
      db.crmChecklistResponse.findMany({
        where: { tenantId, contactId: resolvedContactId },
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { checklist: { select: { id: true, name: true } } },
      }),
      loadCampaignContext({ tenantId, contactId: resolvedContactId, memberId, campaignId }),
      phoneCandidates.length
        ? db.connectCdr.findMany({
            where: {
              tenantId,
              OR: [
                ...(linkedId ? [{ linkedId }] : []),
                ...phoneCandidates.flatMap((candidate) => [
                  { fromNumber: { contains: candidate } },
                  { toNumber: { contains: candidate } },
                ]),
              ],
            },
            orderBy: { startedAt: "desc" },
            take: 12,
            select: {
              linkedId: true,
              fromNumber: true,
              fromName: true,
              toNumber: true,
              direction: true,
              disposition: true,
              startedAt: true,
              answeredAt: true,
              endedAt: true,
              durationSec: true,
              talkSec: true,
              recordingPath: true,
            },
          })
        : Promise.resolve([]),
      linkedId
        ? (db as any).crmCallTranscript.findUnique({
            where: { tenantId_linkedId: { tenantId, linkedId } },
            select: {
              id: true,
              status: true,
              provider: true,
              languageCode: true,
              transcript: true,
              summary: true,
              actionItems: true,
              sentiment: true,
              intent: true,
              confidence: true,
              modelName: true,
              errorCode: true,
              errorMessage: true,
              queuedAt: true,
              startedAt: true,
              completedAt: true,
              failedAt: true,
              updatedAt: true,
            },
          })
        : Promise.resolve(null),
    ]);

    const defaultScriptId = campaignContext?.campaign?.scriptId ?? settings?.defaultScriptId ?? null;
    const defaultChecklistId = campaignContext?.campaign?.checklistId ?? settings?.defaultChecklistId ?? null;

    return {
      matched: true,
      contact: formatContact(contact),
      currentCall: formatCurrentCall({ linkedId, phone, cdr }),
      campaignContext,
      timeline: timeline.map(formatTimelineEvent),
      tasks: tasks.map(formatTask),
      forms: forms.map(formatFormRequest),
      documents: documents.map(formatDocument),
      scripts: {
        defaultScriptId,
        items: scripts.map((script) => ({
          ...script,
          isDefault: script.id === defaultScriptId,
        })),
      },
      checklists: {
        defaultChecklistId,
        items: checklists.map((checklist) => ({
          ...checklist,
          isDefault: checklist.id === defaultChecklistId,
        })),
        recentResponses: checklistResponses.map(formatChecklistResponse),
      },
      callHistory: cdrRows.map(formatCdr),
      openItems: buildOpenItems({ tasks, forms, documents, checklistResponses, defaultChecklistId }),
      aiCallIntelligence: {
        transcriptionEnabled: !!settings?.transcriptionEnabled,
        transcriptAvailable: transcript?.status === "COMPLETED" && !!transcript.transcript,
        summaryAvailable: transcript?.status === "COMPLETED" && !!transcript.summary,
        actionItemsAvailable: transcript?.status === "COMPLETED" && Array.isArray(transcript.actionItems) && transcript.actionItems.length > 0,
        placeholder: settings?.transcriptionEnabled
          ? "Transcript will appear here after the recorded call is processed."
          : "Transcript will appear here when call transcription is enabled.",
        transcript: transcript ? formatTranscript(transcript) : null,
      },
    };
  });
}

async function loadCampaignContext({
  tenantId,
  contactId,
  memberId,
  campaignId,
}: {
  tenantId: string;
  contactId: string;
  memberId?: string;
  campaignId?: string;
}) {
  const where = memberId
    ? { id: memberId, tenantId, contactId }
    : campaignId
      ? { tenantId, contactId, campaignId }
      : { tenantId, contactId };

  const member = await db.crmCampaignMember.findFirst({
    where,
    orderBy: [{ updatedAt: "desc" }],
    include: {
      campaign: {
        select: {
          id: true,
          name: true,
          status: true,
          priority: true,
          scriptId: true,
          checklistId: true,
          script: { select: { id: true, name: true } },
          checklist: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!member) return null;
  return {
    member: {
      id: member.id,
      status: member.status,
      attemptCount: member.attemptCount,
      lastAttemptAt: member.lastAttemptAt,
      callbackAt: member.callbackAt,
      callbackNote: member.callbackNote,
    },
    campaign: member.campaign,
  };
}

function formatContact(c: any) {
  const primaryPhone = c.phones?.find((p: any) => p.isPrimary) ?? c.phones?.[0] ?? null;
  const primaryEmail = c.emails?.find((e: any) => e.isPrimary) ?? c.emails?.[0] ?? null;
  return {
    id: c.id,
    tenantId: c.tenantId,
    displayName: c.displayName,
    firstName: c.firstName,
    lastName: c.lastName,
    company: c.company,
    title: c.title,
    notes: c.notes,
    phones: c.phones ?? [],
    emails: c.emails ?? [],
    addresses: c.addresses ?? [],
    tags: c.tagLinks?.map((tl: any) => tl.tag) ?? [],
    primaryPhone,
    primaryEmail,
    crmStage: c.crmMeta?.stage ?? null,
    assignedTo: c.crmMeta?.assignedTo ?? null,
    doNotCall: c.crmMeta?.doNotCall ?? false,
    doNotSms: c.crmMeta?.doNotSms ?? false,
    lastActivityAt: c.crmMeta?.lastActivityAt ?? null,
    lastDisposition: c.crmMeta?.lastDisposition ?? null,
    lastDispositionAt: c.crmMeta?.lastDispositionAt ?? null,
    timezoneIana: c.crmMeta?.timezoneIana ?? null,
    timezoneLabel: c.crmMeta?.timezoneLabel ?? null,
    timezoneOffsetMinutes: c.crmMeta?.timezoneOffsetMinutes ?? null,
    timezoneResolutionStatus: c.crmMeta?.timezoneResolutionStatus ?? null,
    active: c.active ?? true,
    archivedAt: c.archivedAt ? new Date(c.archivedAt).toISOString() : null,
    isInCrm: true,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function formatTimelineEvent(event: any) {
  return {
    id: event.id,
    type: event.type,
    title: event.title,
    body: event.body ?? null,
    metadata: event.metadata ?? null,
    linkedId: event.linkedId ?? null,
    createdAt: event.createdAt,
    createdBy: event.createdByUser
      ? {
          id: event.createdByUser.id,
          displayName:
            event.createdByUser.displayName ||
            [event.createdByUser.firstName, event.createdByUser.lastName].filter(Boolean).join(" ") ||
            event.createdByUser.email,
        }
      : null,
  };
}

function formatTask(task: any) {
  return {
    id: task.id,
    contactId: task.contactId,
    title: task.title,
    body: task.body ?? null,
    dueAt: task.dueAt ?? null,
    priority: task.priority,
    status: task.status,
    completedAt: task.completedAt ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    assignedTo: formatUser(task.assignedTo),
    createdBy: formatUser(task.createdBy),
  };
}

function formatUser(user: any) {
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName || [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
  };
}

function formatFormRequest(request: any) {
  return {
    id: request.id,
    status: request.status,
    recipientEmail: request.recipientEmail,
    expiresAt: request.expiresAt ?? null,
    openedAt: request.openedAt ?? null,
    completedAt: request.completedAt ?? null,
    revokedAt: request.revokedAt ?? null,
    createdAt: request.createdAt,
    formTemplate: request.formTemplate
      ? {
          id: request.formTemplate.id,
          name: request.formTemplate.name,
          category: request.formTemplate.category ?? null,
        }
      : null,
    submission: request.submission
      ? {
          id: request.submission.id,
          submittedAt: request.submission.submittedAt ?? null,
        }
      : null,
  };
}

function formatDocument(doc: any) {
  return {
    id: doc.id,
    originalFileName: doc.originalFileName,
    mimeType: doc.mimeType ?? null,
    sizeBytes: doc.sizeBytes != null ? Number(doc.sizeBytes) : null,
    status: doc.status,
    matchConfidence: doc.matchConfidence ?? null,
    importedAt: doc.importedAt ?? null,
    textExtractionStatus: doc.textExtractionStatus ?? null,
    textExtractedAt: doc.textExtractedAt ?? null,
    createdAt: doc.createdAt,
  };
}

function formatChecklistResponse(response: any) {
  return {
    id: response.id,
    checklistId: response.checklistId,
    checklistName: response.checklist?.name ?? "Checklist",
    linkedId: response.linkedId ?? null,
    answers: response.answers ?? {},
    createdAt: response.createdAt,
  };
}

function formatCdr(cdr: any) {
  return {
    linkedId: cdr.linkedId,
    fromNumber: cdr.fromNumber ?? null,
    fromName: cdr.fromName ?? null,
    toNumber: cdr.toNumber ?? null,
    direction: cdr.direction,
    disposition: cdr.disposition,
    startedAt: cdr.startedAt,
    answeredAt: cdr.answeredAt ?? null,
    endedAt: cdr.endedAt ?? null,
    durationSec: cdr.durationSec ?? 0,
    talkSec: cdr.talkSec ?? 0,
    recordingAvailable: !!cdr.recordingPath,
    summary: null,
    transcriptionSummary: null,
  };
}

function formatTranscript(row: any) {
  return {
    id: row.id,
    status: row.status,
    provider: row.provider,
    languageCode: row.languageCode,
    transcript: row.transcript ?? null,
    summary: row.summary ?? null,
    actionItems: Array.isArray(row.actionItems) ? row.actionItems : [],
    sentiment: row.sentiment ?? null,
    intent: row.intent ?? null,
    confidence: row.confidence ?? null,
    modelName: row.modelName ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    queuedAt: row.queuedAt ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    failedAt: row.failedAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function formatCurrentCall({
  linkedId,
  phone,
  cdr,
}: {
  linkedId?: string;
  phone?: string;
  cdr: any | null;
}) {
  return {
    linkedId: linkedId ?? cdr?.linkedId ?? null,
    fromNumber: cdr?.fromNumber ?? phone ?? null,
    fromName: cdr?.fromName ?? null,
    toNumber: cdr?.toNumber ?? null,
    direction: cdr?.direction ?? null,
    disposition: cdr?.disposition ?? null,
    startedAt: cdr?.startedAt ?? null,
    answeredAt: cdr?.answeredAt ?? null,
    durationSec: cdr?.durationSec ?? null,
    recordingAvailable: !!cdr?.recordingPath,
  };
}

function buildCallHistoryPhoneCandidates(values: Array<string | null | undefined>): string[] {
  const candidates = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const { normalizedKeys, safeSuffix10 } = buildPhoneMatchCandidates(value);
    normalizedKeys.forEach((candidate) => {
      if (candidate.length >= 7) candidates.add(candidate);
    });
    if (safeSuffix10) candidates.add(safeSuffix10);
  }
  return [...candidates].slice(0, 8);
}

function buildOpenItems({
  tasks,
  forms,
  documents,
  checklistResponses,
  defaultChecklistId,
}: {
  tasks: any[];
  forms: any[];
  documents: any[];
  checklistResponses: any[];
  defaultChecklistId: string | null;
}) {
  const pendingForms = forms.filter((request) => ["SENT", "OPENED"].includes(String(request.status)));
  const pendingDocuments = documents.filter((doc) =>
    ["DISCOVERED", "IMPORT_PENDING", "IMPORTING", "IMPORT_FAILED", "FAILED"].includes(String(doc.status)),
  );
  const latestDefaultChecklist = defaultChecklistId
    ? checklistResponses.find((response) => response.checklistId === defaultChecklistId) ?? null
    : null;
  return {
    openTaskCount: tasks.length,
    pendingFormCount: pendingForms.length,
    pendingDocumentCount: pendingDocuments.length,
    latestChecklistResponse: latestDefaultChecklist ? formatChecklistResponse(latestDefaultChecklist) : null,
  };
}
