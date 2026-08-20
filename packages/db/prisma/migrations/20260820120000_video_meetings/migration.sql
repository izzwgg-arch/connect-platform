-- Loopcom Meetings (2026-08-20): one row per meeting link.
-- Matches Prisma's generated DDL for the VideoMeeting model exactly.
CREATE TABLE "VideoMeeting" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "VideoMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoMeeting_code_key" ON "VideoMeeting"("code");

-- CreateIndex
CREATE INDEX "VideoMeeting_tenantId_createdAt_idx" ON "VideoMeeting"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "VideoMeeting_createdByUserId_createdAt_idx" ON "VideoMeeting"("createdByUserId", "createdAt");

-- AddForeignKey (⛔ Cascade on purpose — the ConnectChatThread lesson: a tenant
-- relation without onDelete defaults to Restrict and makes every tenant erase
-- fail on a foreign key.)
ALTER TABLE "VideoMeeting" ADD CONSTRAINT "VideoMeeting_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
