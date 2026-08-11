import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { SpeechClient } from "@google-cloud/speech";
import { Storage } from "@google-cloud/storage";
import { VertexAI } from "@google-cloud/vertexai";

type TranscriptStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "UNAVAILABLE";

export type CallTranscriptionInput = {
  tenantId: string;
  contactId: string;
  linkedId: string;
};

type SpeechClientLike = {
  longRunningRecognize: (request: unknown) => Promise<[{
    promise: () => Promise<[{
      results?: Array<{
        alternatives?: Array<{ transcript?: string; confidence?: number }>;
      }>;
    }]>;
    name?: string;
  }]>;
};

type StorageLike = {
  bucket: (name: string) => {
    file: (name: string) => {
      save: (buffer: Buffer, options?: unknown) => Promise<unknown>;
      delete: (options?: unknown) => Promise<unknown>;
    };
  };
};

type SummaryClientLike = {
  summarize: (transcript: string) => Promise<SummaryResult | null>;
};

type TranscriptionDeps = {
  speechClient?: SpeechClientLike;
  storageClient?: StorageLike;
  summaryClient?: SummaryClientLike;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type SummaryResult = {
  summary: string | null;
  actionItems: Array<{ title: string; detail?: string | null; dueHint?: string | null }>;
  sentiment: string | null;
  intent: string | null;
  modelName: string | null;
};

type TranscriptionResult = {
  status: TranscriptStatus;
  reason?: string;
};

const DEFAULT_LANGUAGE_CODE = "en-US";

export async function enqueueAndProcessCallTranscription(
  input: CallTranscriptionInput,
  deps: TranscriptionDeps = {},
): Promise<TranscriptionResult> {
  const queued = await enqueueCallTranscription(input, deps);
  if (queued.status !== "QUEUED") return queued;

  void processCallTranscription(input, deps).catch((err) => {
    console.error("[CRM][transcription] async processing failed", {
      tenantId: input.tenantId,
      linkedId: input.linkedId,
      error: err?.message,
    });
  });

  return queued;
}

export async function enqueueCallTranscription(
  input: CallTranscriptionInput,
  deps: Pick<TranscriptionDeps, "now"> = {},
): Promise<TranscriptionResult> {
  const loaded = await loadEligibleCall(input);
  if (loaded.ok === false) return { status: loaded.status, reason: loaded.reason };

  const now = deps.now?.() ?? new Date();
  const existing = await (db as any).crmCallTranscript.findUnique({
    where: { tenantId_linkedId: { tenantId: input.tenantId, linkedId: input.linkedId } },
    select: { status: true },
  });
  if (existing?.status === "PROCESSING" || existing?.status === "COMPLETED") {
    return { status: existing.status };
  }

  await (db as any).crmCallTranscript.upsert({
    where: { tenantId_linkedId: { tenantId: input.tenantId, linkedId: input.linkedId } },
    create: {
      tenantId: input.tenantId,
      contactId: input.contactId,
      linkedId: input.linkedId,
      status: "QUEUED",
      provider: "google",
      languageCode: process.env.GOOGLE_SPEECH_LANGUAGE_CODE || DEFAULT_LANGUAGE_CODE,
      queuedAt: now,
    },
    update: {
      contactId: input.contactId,
      status: "QUEUED",
      errorCode: null,
      errorMessage: null,
      queuedAt: now,
      failedAt: null,
    },
  });

  return { status: "QUEUED" };
}

export async function processCallTranscription(
  input: CallTranscriptionInput,
  deps: TranscriptionDeps = {},
): Promise<TranscriptionResult> {
  const loaded = await loadEligibleCall(input);
  if (loaded.ok === false) {
    await markTranscriptUnavailable(input, loaded.reason, deps.now?.() ?? new Date());
    return { status: loaded.status, reason: loaded.reason };
  }

  const now = deps.now?.() ?? new Date();
  await (db as any).crmCallTranscript.upsert({
    where: { tenantId_linkedId: { tenantId: input.tenantId, linkedId: input.linkedId } },
    create: {
      tenantId: input.tenantId,
      contactId: input.contactId,
      linkedId: input.linkedId,
      status: "PROCESSING",
      provider: "google",
      languageCode: process.env.GOOGLE_SPEECH_LANGUAGE_CODE || DEFAULT_LANGUAGE_CODE,
      queuedAt: now,
      startedAt: now,
    },
    update: {
      contactId: input.contactId,
      status: "PROCESSING",
      startedAt: now,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
    },
  });

  const bucketName = process.env.GOOGLE_CALL_TRANSCRIPTS_BUCKET;
  if (!bucketName) {
    return failTranscript(input, "google_bucket_missing", "Google transcript bucket is not configured.", deps.now?.() ?? new Date());
  }

  const objectName = buildGcsObjectName(input);
  const gcsUri = `gs://${bucketName}/${objectName}`;
  const storage = deps.storageClient ?? new Storage();
  const speech = deps.speechClient ?? (new SpeechClient() as unknown as SpeechClientLike);
  const file = storage.bucket(bucketName).file(objectName);

  try {
    const audio = await fetchRecordingBuffer(loaded.cdr, deps.fetchImpl ?? fetch);
    await file.save(audio.buffer, {
      contentType: audio.contentType,
      resumable: false,
      metadata: {
        metadata: {
          tenantId: input.tenantId,
          linkedId: input.linkedId,
          source: "connect-crm-call-transcription",
        },
      },
    });

    const speechResult = await transcribeGcsAudio(speech, {
      gcsUri,
      languageCode: process.env.GOOGLE_SPEECH_LANGUAGE_CODE || DEFAULT_LANGUAGE_CODE,
    });
    const summary = await summarizeTranscript(speechResult.transcript, deps.summaryClient);
    const completedAt = deps.now?.() ?? new Date();

    await (db as any).crmCallTranscript.update({
      where: { tenantId_linkedId: { tenantId: input.tenantId, linkedId: input.linkedId } },
      data: {
        status: "COMPLETED",
        transcript: speechResult.transcript,
        summary: summary?.summary ?? null,
        actionItems: summary?.actionItems ?? [],
        sentiment: summary?.sentiment ?? null,
        intent: summary?.intent ?? null,
        confidence: speechResult.confidence,
        modelName: summary?.modelName ?? process.env.GOOGLE_SPEECH_MODEL ?? "google-speech-to-text",
        googleOperationName: speechResult.operationName,
        gcsUri,
        audioDurationSec: loaded.cdr.talkSec || loaded.cdr.durationSec || null,
        completedAt,
        errorCode: null,
        errorMessage: null,
      },
    });

    await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    return { status: "COMPLETED" };
  } catch (err: any) {
    await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    return failTranscript(
      input,
      "google_transcription_failed",
      safeErrorMessage(err),
      deps.now?.() ?? new Date(),
    );
  }
}

async function loadEligibleCall(input: CallTranscriptionInput): Promise<
  | { ok: true; cdr: { linkedId: string; tenantId: string; recordingPath: string; durationSec: number; talkSec: number; pbxVitalTenantId: string | null; pbxTenantCode: string | null } }
  | { ok: false; status: "UNAVAILABLE"; reason: string }
> {
  const [settings, contact, cdr] = await Promise.all([
    db.crmTenantSettings.findUnique({
      where: { tenantId: input.tenantId },
      select: { enabled: true, transcriptionEnabled: true },
    }),
    (db as any).contact.findFirst({
      where: { id: input.contactId, tenantId: input.tenantId, active: true, archivedAt: null, crmMeta: { isNot: null } },
      select: { id: true },
    }),
    db.connectCdr.findFirst({
      where: { tenantId: input.tenantId, linkedId: input.linkedId },
      select: {
        linkedId: true,
        tenantId: true,
        recordingPath: true,
        recordingMissingAt: true,
        durationSec: true,
        talkSec: true,
        pbxVitalTenantId: true,
        pbxTenantCode: true,
      },
    }),
  ]);

  if (!settings?.enabled || !settings.transcriptionEnabled) {
    return { ok: false, status: "UNAVAILABLE", reason: "transcription_disabled" };
  }
  if (!contact) return { ok: false, status: "UNAVAILABLE", reason: "contact_not_available" };
  // recordingMissingAt = the PBX has already confirmed there is no file. Without
  // this the transcriber would queue work for audio that can never be fetched.
  if (!cdr?.recordingPath || !cdr.tenantId || cdr.recordingMissingAt) return { ok: false, status: "UNAVAILABLE", reason: "recording_not_available" };
  return { ok: true, cdr: { ...cdr, tenantId: cdr.tenantId, recordingPath: cdr.recordingPath } };
}

async function fetchRecordingBuffer(
  cdr: { linkedId: string; tenantId: string | null; recordingPath: string; pbxVitalTenantId: string | null; pbxTenantCode: string | null },
  fetchImpl: typeof fetch,
): Promise<{ buffer: Buffer; contentType: string }> {
  const pbxInstance = await resolvePbxInstanceForCdr(cdr.tenantId, cdr.linkedId);
  if (!pbxInstance) throw new Error("pbx_not_linked");

  const auth = decryptJson<{ token: string; secret?: string | null }>(pbxInstance.apiAuthEncrypted);
  const audioUrl = buildRecordingUrl(pbxInstance.baseUrl, cdr.recordingPath);
  const pbxResp = await fetchImpl(audioUrl, {
    headers: {
      "app-key": auth.token,
      Accept: "audio/*, */*",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!pbxResp.ok) throw new Error(pbxResp.status === 404 ? "recording_file_missing" : "audio_fetch_failed");

  return {
    buffer: Buffer.from(await pbxResp.arrayBuffer()),
    contentType: pbxResp.headers.get("content-type") || "audio/wav",
  };
}

async function transcribeGcsAudio(
  speech: SpeechClientLike,
  input: { gcsUri: string; languageCode: string },
): Promise<{ transcript: string; confidence: number | null; operationName: string | null }> {
  const [operation] = await speech.longRunningRecognize({
    audio: { uri: input.gcsUri },
    config: {
      languageCode: input.languageCode,
      enableAutomaticPunctuation: true,
      model: process.env.GOOGLE_SPEECH_MODEL || "phone_call",
      useEnhanced: process.env.GOOGLE_SPEECH_USE_ENHANCED !== "0",
    },
  });
  const [response] = await operation.promise();
  const alternatives = (response.results ?? [])
    .map((result) => result.alternatives?.[0])
    .filter(Boolean) as Array<{ transcript?: string; confidence?: number }>;
  const transcript = alternatives.map((alt) => alt.transcript?.trim()).filter(Boolean).join("\n").trim();
  if (!transcript) throw new Error("empty_transcript");
  const confidenceValues = alternatives.map((alt) => alt.confidence).filter((value): value is number => typeof value === "number");
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : null;
  return { transcript, confidence, operationName: operation.name ?? null };
}

async function summarizeTranscript(
  transcript: string,
  summaryClient?: SummaryClientLike,
): Promise<SummaryResult | null> {
  if (!transcript.trim()) return null;
  if (summaryClient) return summaryClient.summarize(transcript);

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  const modelName = process.env.GOOGLE_VERTEX_MODEL;
  if (!project || !modelName) return null;

  try {
    const vertex = new VertexAI({ project, location });
    const model = vertex.getGenerativeModel({ model: modelName });
    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [{ text: buildSummaryPrompt(transcript) }],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
      },
    } as any);
    const text = result.response?.candidates?.[0]?.content?.parts?.map((part: any) => part.text).filter(Boolean).join("\n") ?? "";
    return parseSummaryResponse(text, modelName);
  } catch (err) {
    console.warn("[CRM][transcription] summary generation skipped", { error: (err as Error)?.message });
    return null;
  }
}

export function parseSummaryResponse(text: string, modelName: string | null = null): SummaryResult {
  const trimmed = text.trim();
  const jsonText = trimmed.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : null,
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(formatActionItem).filter(Boolean) : [],
      sentiment: typeof parsed.sentiment === "string" ? parsed.sentiment : null,
      intent: typeof parsed.intent === "string" ? parsed.intent : null,
      modelName,
    };
  } catch {
    return {
      summary: trimmed || null,
      actionItems: [],
      sentiment: null,
      intent: null,
      modelName,
    };
  }
}

function formatActionItem(item: unknown) {
  if (typeof item === "string") return { title: item };
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title : typeof value.action === "string" ? value.action : null;
  if (!title) return null;
  return {
    title,
    detail: typeof value.detail === "string" ? value.detail : null,
    dueHint: typeof value.dueHint === "string" ? value.dueHint : null,
  };
}

function buildSummaryPrompt(transcript: string): string {
  return [
    "Summarize this CRM phone call transcript for an agent.",
    "Return strict JSON with keys: summary, actionItems, sentiment, intent.",
    "actionItems must be an array of objects with title, detail, and dueHint.",
    "Do not invent details not present in the transcript.",
    "",
    "Transcript:",
    transcript.slice(0, 40_000),
  ].join("\n");
}

async function markTranscriptUnavailable(input: CallTranscriptionInput, reason: string, now: Date): Promise<void> {
  await (db as any).crmCallTranscript.upsert({
    where: { tenantId_linkedId: { tenantId: input.tenantId, linkedId: input.linkedId } },
    create: {
      tenantId: input.tenantId,
      contactId: input.contactId,
      linkedId: input.linkedId,
      status: "UNAVAILABLE",
      provider: "google",
      errorCode: reason,
      errorMessage: "Transcript is unavailable for this recording.",
      failedAt: now,
    },
    update: {
      contactId: input.contactId,
      status: "UNAVAILABLE",
      errorCode: reason,
      errorMessage: "Transcript is unavailable for this recording.",
      failedAt: now,
    },
  });
}

async function failTranscript(input: CallTranscriptionInput, code: string, message: string, now: Date): Promise<TranscriptionResult> {
  await (db as any).crmCallTranscript.update({
    where: { tenantId_linkedId: { tenantId: input.tenantId, linkedId: input.linkedId } },
    data: {
      status: "FAILED",
      errorCode: code,
      errorMessage: message,
      failedAt: now,
    },
  });
  return { status: "FAILED", reason: code };
}

async function resolvePbxInstanceForCdr(
  cdrTenantId: string | null,
  linkedId: string,
): Promise<{ id: string; baseUrl: string; apiAuthEncrypted: string } | null> {
  const pick = async (where: any) => {
    const link = await db.tenantPbxLink.findFirst({ where, include: { pbxInstance: true } });
    return link?.pbxInstance
      ? { id: link.pbxInstance.id, baseUrl: link.pbxInstance.baseUrl, apiAuthEncrypted: link.pbxInstance.apiAuthEncrypted }
      : null;
  };

  if (cdrTenantId && !cdrTenantId.startsWith("vpbx:")) {
    const hit = await pick({ tenantId: cdrTenantId });
    if (hit) return hit;
  }

  if (cdrTenantId?.startsWith("vpbx:")) {
    const slug = cdrTenantId.slice(5);
    const dirRow = await db.pbxTenantDirectory.findFirst({ where: { tenantSlug: slug } });
    if (dirRow?.vitalTenantId) {
      const hit = await pick({ pbxTenantId: dirRow.vitalTenantId });
      if (hit) return hit;
    }
  }

  const cdr = await (db as any).connectCdr.findUnique({
    where: { linkedId },
    select: { pbxVitalTenantId: true, pbxTenantCode: true },
  });
  if (cdr?.pbxVitalTenantId) {
    const hit = await pick({ pbxTenantId: cdr.pbxVitalTenantId });
    if (hit) return hit;
  }
  if (cdr?.pbxTenantCode) {
    const hit = await pick({ pbxTenantId: cdr.pbxTenantCode });
    if (hit) return hit;
  }

  const anyLinked = await pick({ status: "LINKED" });
  if (anyLinked) return anyLinked;

  const instances = await db.pbxInstance.findMany({
    where: {
      isEnabled: true,
      NOT: [
        { baseUrl: { contains: "127.0.0.1" } },
        { baseUrl: { contains: "localhost" } },
        { baseUrl: { contains: "sim.local" } },
        { baseUrl: { contains: "example.com" } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 1,
    select: { id: true, baseUrl: true, apiAuthEncrypted: true },
  });
  return instances[0] ?? null;
}

function buildRecordingUrl(pbxBaseUrl: string, recordingPath: string): string {
  const base = pbxBaseUrl.replace(/\/+$/, "");
  let rel = recordingPath.replace(/^\/var\/spool\/asterisk\/monitor\/+/, "");
  rel = rel.replace(/^\/+/, "");
  return `${base}/monitor/${rel}`;
}

function buildGcsObjectName(input: CallTranscriptionInput): string {
  const safeTenant = input.tenantId.replace(/[^\w.-]/g, "_");
  const safeLinkedId = input.linkedId.replace(/[^\w.-]/g, "_");
  return `crm-call-transcripts/${safeTenant}/${safeLinkedId}.wav`;
}

function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "unknown_error");
  if (/credential|token|secret|key/i.test(message)) return "Google transcription credentials are not configured correctly.";
  if (/recording_file_missing/.test(message)) return "Recording file was not found on the PBX.";
  if (/audio_fetch_failed/.test(message)) return "Recording audio could not be fetched.";
  if (/empty_transcript/.test(message)) return "Google returned an empty transcript.";
  return "Google transcription failed.";
}
