-- 24/7 call-quality learning store (hourly aggregates). Additive only.
CREATE TABLE "CallQualityHourly" (
    "id" TEXT NOT NULL,
    "hourStart" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "direction" TEXT,
    "audioCodec" TEXT,
    "networkType" TEXT,
    "usedRelay" BOOLEAN NOT NULL DEFAULT false,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "poorCalls" INTEGER NOT NULL DEFAULT 0,
    "avgRttMs" DOUBLE PRECISION,
    "maxRttMs" INTEGER,
    "avgJitterMs" DOUBLE PRECISION,
    "avgLossPct" DOUBLE PRECISION,
    "maxLossPct" DOUBLE PRECISION,
    "avgTxLossPct" DOUBLE PRECISION,
    "maxTxLossPct" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallQualityHourly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallQualityHourly_hourStart_tenantId_userId_direction_audioCodec_networkType_usedRelay_key"
  ON "CallQualityHourly"("hourStart", "tenantId", "userId", "direction", "audioCodec", "networkType", "usedRelay");
CREATE INDEX "CallQualityHourly_tenantId_hourStart_idx" ON "CallQualityHourly"("tenantId", "hourStart");
CREATE INDEX "CallQualityHourly_hourStart_idx" ON "CallQualityHourly"("hourStart");
