CREATE TABLE "YcSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "adapterKey" TEXT,
    "governanceClass" TEXT NOT NULL,
    "trainingExportEligibility" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "contentAllowed" BOOLEAN NOT NULL DEFAULT false,
    "audioFetchMode" TEXT NOT NULL DEFAULT 'DISABLED',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "termsUrl" TEXT,
    "termsCheckedAt" TIMESTAMP(3),
    "rightsNote" TEXT,
    "config" JSONB,
    "discoveryCursor" TEXT,
    "lastDiscoveryAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YcSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcRightsRecord" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "allowedUse" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "evidence" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcRightsRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcSourceItem" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "title" TEXT,
    "seriesName" TEXT,
    "category" TEXT,
    "host" TEXT,
    "publishedLabel" TEXT,
    "publishedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "mediaUrl" TEXT,
    "imageUrl" TEXT,
    "metadata" JSONB,
    "fingerprint" TEXT NOT NULL,
    "duplicateOfId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "noveltyScore" DOUBLE PRECISION,
    "speechRatio" DOUBLE PRECISION,
    "processingVersion" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YcSourceItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcAudioAsset" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "storage" TEXT NOT NULL DEFAULT 'REFERENCE_ONLY',
    "uri" TEXT,
    "storageKey" TEXT,
    "sha256" TEXT,
    "bytes" INTEGER,
    "durationMs" INTEGER,
    "sampleRate" INTEGER,
    "channels" INTEGER,
    "codec" TEXT,
    "qualityScore" DOUBLE PRECISION,
    "kind" TEXT NOT NULL DEFAULT 'EXTERNAL',
    "retentionClass" TEXT NOT NULL DEFAULT 'ORDINARY',
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deleteReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcAudioAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcSegment" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "klass" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "klassConfidence" DOUBLE PRECISION,
    "speakerClusterId" TEXT,
    "rmsDb" DOUBLE PRECISION,
    "speechRate" DOUBLE PRECISION,
    "pitchMeanHz" DOUBLE PRECISION,
    "features" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcSegment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcSpeakerCluster" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sourceKey" TEXT,
    "statedName" TEXT,
    "minutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "centroid" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YcSpeakerCluster_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcTranscript" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "segmentId" TEXT,
    "engine" TEXT NOT NULL,
    "sttProvider" TEXT,
    "text" TEXT NOT NULL,
    "language" TEXT,
    "confidence" DOUBLE PRECISION,
    "isConsensus" BOOLEAN NOT NULL DEFAULT false,
    "originRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcTranscript_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcLexeme" (
    "id" TEXT NOT NULL,
    "writtenForm" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'YI',
    "category" TEXT,
    "frequency" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcLexeme_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcPronunciationObservation" (
    "id" TEXT NOT NULL,
    "lexemeId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "realization" TEXT,
    "sourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "itemId" TEXT,
    "segmentId" TEXT,
    "speakerClusterId" TEXT,
    "context" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evidenceKind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcPronunciationObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcPronunciationRule" (
    "id" TEXT NOT NULL,
    "lexemeId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "realization" TEXT,
    "ipa" TEXT,
    "method" TEXT NOT NULL DEFAULT 'INSTRUCTION_HINT',
    "contextPattern" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "evidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "supportSummary" JSONB,
    "dictionaryVersion" INTEGER NOT NULL DEFAULT 1,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YcPronunciationRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcProsodyObservation" (
    "id" TEXT NOT NULL,
    "itemId" TEXT,
    "segmentId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcProsodyObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcFinding" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "evidence" JSONB,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "speakerCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcFinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcReviewItem" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "lexemeId" TEXT,
    "reason" TEXT NOT NULL,
    "detail" JSONB,
    "resolvesCount" INTEGER NOT NULL DEFAULT 1,
    "impactScore" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "decision" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcReviewItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcProcessingJob" (
    "id" TEXT NOT NULL,
    "itemId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YcProcessingJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcBudget" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT,
    "scope" TEXT NOT NULL,
    "apiCentsPerDay" INTEGER NOT NULL DEFAULT 0,
    "transcriptionMinutesPerDay" INTEGER NOT NULL DEFAULT 0,
    "storageBytesMax" BIGINT NOT NULL DEFAULT 0,
    "concurrency" INTEGER NOT NULL DEFAULT 2,
    "requestsPerMinute" INTEGER NOT NULL DEFAULT 30,
    "mode" TEXT NOT NULL DEFAULT 'METADATA_ONLY',
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "spentCentsToday" INTEGER NOT NULL DEFAULT 0,
    "transcribedMinutesToday" INTEGER NOT NULL DEFAULT 0,
    "spendDate" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YcBudget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcSourceHealth" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "probeKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OK',
    "detail" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "brokenSince" TIMESTAMP(3),

    CONSTRAINT "YcSourceHealth_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcMetricSnapshot" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL DEFAULT '__all__',
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcMetricSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcBenchmarkCase" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceRef" TEXT,
    "category" TEXT NOT NULL,
    "tags" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trainingUse" TEXT NOT NULL DEFAULT 'SERVING_ONLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcBenchmarkCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcVoiceProfileVersion" (
    "id" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "model" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "instructions" TEXT,
    "speed" DOUBLE PRECISION,
    "responseFormat" TEXT NOT NULL DEFAULT 'mp3',
    "dictionaryVersion" INTEGER NOT NULL DEFAULT 1,
    "internalMeta" JSONB,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcVoiceProfileVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcBenchmarkRun" (
    "id" TEXT NOT NULL,
    "profileVersionId" TEXT NOT NULL,
    "baselineRunId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "ratedCount" INTEGER NOT NULL DEFAULT 0,
    "meanRating" DOUBLE PRECISION,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "YcBenchmarkRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YcBenchmarkResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "audioKey" TEXT,
    "latencyMs" INTEGER,
    "bytes" INTEGER,
    "rating" INTEGER,
    "ratedBy" TEXT,
    "notes" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YcBenchmarkResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "YcSource_key_key" ON "YcSource"("key");
CREATE UNIQUE INDEX "YcRightsRecord_sourceId_allowedUse_key" ON "YcRightsRecord"("sourceId", "allowedUse");
CREATE INDEX "YcSourceItem_sourceId_state_idx" ON "YcSourceItem"("sourceId", "state");
CREATE INDEX "YcSourceItem_fingerprint_idx" ON "YcSourceItem"("fingerprint");
CREATE INDEX "YcSourceItem_state_priority_idx" ON "YcSourceItem"("state", "priority");
CREATE UNIQUE INDEX "YcSourceItem_sourceId_externalId_key" ON "YcSourceItem"("sourceId", "externalId");
CREATE INDEX "YcAudioAsset_itemId_idx" ON "YcAudioAsset"("itemId");
CREATE INDEX "YcAudioAsset_retentionClass_expiresAt_idx" ON "YcAudioAsset"("retentionClass", "expiresAt");
CREATE INDEX "YcSegment_assetId_startMs_idx" ON "YcSegment"("assetId", "startMs");
CREATE INDEX "YcSegment_klass_idx" ON "YcSegment"("klass");
CREATE UNIQUE INDEX "YcSpeakerCluster_label_key" ON "YcSpeakerCluster"("label");
CREATE INDEX "YcTranscript_itemId_idx" ON "YcTranscript"("itemId");
CREATE INDEX "YcTranscript_engine_idx" ON "YcTranscript"("engine");
CREATE UNIQUE INDEX "YcLexeme_writtenForm_key" ON "YcLexeme"("writtenForm");
CREATE INDEX "YcLexeme_normalized_idx" ON "YcLexeme"("normalized");
CREATE INDEX "YcLexeme_frequency_idx" ON "YcLexeme"("frequency");
CREATE INDEX "YcPronunciationObservation_lexemeId_variantKey_idx" ON "YcPronunciationObservation"("lexemeId", "variantKey");
CREATE INDEX "YcPronunciationObservation_sourceKey_idx" ON "YcPronunciationObservation"("sourceKey");
CREATE INDEX "YcPronunciationRule_status_idx" ON "YcPronunciationRule"("status");
CREATE UNIQUE INDEX "YcPronunciationRule_lexemeId_variantKey_dictionaryVersion_key" ON "YcPronunciationRule"("lexemeId", "variantKey", "dictionaryVersion");
CREATE INDEX "YcProsodyObservation_feature_idx" ON "YcProsodyObservation"("feature");
CREATE INDEX "YcFinding_status_createdAt_idx" ON "YcFinding"("status", "createdAt");
CREATE INDEX "YcReviewItem_state_impactScore_idx" ON "YcReviewItem"("state", "impactScore");
CREATE UNIQUE INDEX "YcReviewItem_subjectType_subjectId_key" ON "YcReviewItem"("subjectType", "subjectId");
CREATE INDEX "YcProcessingJob_state_nextRunAt_priority_idx" ON "YcProcessingJob"("state", "nextRunAt", "priority");
CREATE INDEX "YcProcessingJob_sourceKey_stage_idx" ON "YcProcessingJob"("sourceKey", "stage");
CREATE UNIQUE INDEX "YcBudget_sourceId_key" ON "YcBudget"("sourceId");
CREATE UNIQUE INDEX "YcBudget_scope_key" ON "YcBudget"("scope");
CREATE UNIQUE INDEX "YcSourceHealth_sourceId_probeKey_key" ON "YcSourceHealth"("sourceId", "probeKey");
CREATE INDEX "YcMetricSnapshot_metric_day_idx" ON "YcMetricSnapshot"("metric", "day");
CREATE UNIQUE INDEX "YcMetricSnapshot_day_sourceKey_metric_key" ON "YcMetricSnapshot"("day", "sourceKey", "metric");
CREATE INDEX "YcBenchmarkCase_category_active_idx" ON "YcBenchmarkCase"("category", "active");
CREATE UNIQUE INDEX "YcVoiceProfileVersion_profileKey_version_key" ON "YcVoiceProfileVersion"("profileKey", "version");
CREATE UNIQUE INDEX "YcBenchmarkResult_runId_caseId_key" ON "YcBenchmarkResult"("runId", "caseId");
ALTER TABLE "YcRightsRecord" ADD CONSTRAINT "YcRightsRecord_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "YcSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcSourceItem" ADD CONSTRAINT "YcSourceItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "YcSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcAudioAsset" ADD CONSTRAINT "YcAudioAsset_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "YcSourceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcSegment" ADD CONSTRAINT "YcSegment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "YcAudioAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcSegment" ADD CONSTRAINT "YcSegment_speakerClusterId_fkey" FOREIGN KEY ("speakerClusterId") REFERENCES "YcSpeakerCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "YcTranscript" ADD CONSTRAINT "YcTranscript_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "YcSourceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcPronunciationObservation" ADD CONSTRAINT "YcPronunciationObservation_lexemeId_fkey" FOREIGN KEY ("lexemeId") REFERENCES "YcLexeme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcPronunciationObservation" ADD CONSTRAINT "YcPronunciationObservation_speakerClusterId_fkey" FOREIGN KEY ("speakerClusterId") REFERENCES "YcSpeakerCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "YcPronunciationRule" ADD CONSTRAINT "YcPronunciationRule_lexemeId_fkey" FOREIGN KEY ("lexemeId") REFERENCES "YcLexeme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcReviewItem" ADD CONSTRAINT "YcReviewItem_lexemeId_fkey" FOREIGN KEY ("lexemeId") REFERENCES "YcLexeme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "YcProcessingJob" ADD CONSTRAINT "YcProcessingJob_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "YcSourceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcBudget" ADD CONSTRAINT "YcBudget_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "YcSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcSourceHealth" ADD CONSTRAINT "YcSourceHealth_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "YcSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcBenchmarkRun" ADD CONSTRAINT "YcBenchmarkRun_profileVersionId_fkey" FOREIGN KEY ("profileVersionId") REFERENCES "YcVoiceProfileVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YcBenchmarkResult" ADD CONSTRAINT "YcBenchmarkResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "YcBenchmarkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
