-- CreateEnum
CREATE TYPE "LoopcomDirectParticipantState" AS ENUM ('ACTIVE', 'REQUEST_PENDING', 'DECLINED');

-- CreateEnum
CREATE TYPE "LoopcomDirectMessageKind" AS ENUM ('TEXT', 'CALL_EVENT');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "loopcomDirectEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "LoopcomDirectIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "findable" BOOLEAN NOT NULL DEFAULT true,
    "requireRequests" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoopcomDirectIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoopcomDirectVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sendCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoopcomDirectVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoopcomDirectThread" (
    "id" TEXT NOT NULL,
    "pairKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoopcomDirectThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoopcomDirectParticipant" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "LoopcomDirectParticipantState" NOT NULL DEFAULT 'ACTIVE',
    "lastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoopcomDirectParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoopcomDirectMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "kind" "LoopcomDirectMessageKind" NOT NULL DEFAULT 'TEXT',
    "body" TEXT NOT NULL,
    "meetingCode" TEXT,
    "callSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoopcomDirectMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoopcomDirectBlock" (
    "id" TEXT NOT NULL,
    "blockerUserId" TEXT NOT NULL,
    "blockedUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoopcomDirectBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoopcomDirectIdentity_userId_key" ON "LoopcomDirectIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LoopcomDirectIdentity_phoneE164_key" ON "LoopcomDirectIdentity"("phoneE164");

-- CreateIndex
CREATE INDEX "LoopcomDirectIdentity_phoneE164_findable_idx" ON "LoopcomDirectIdentity"("phoneE164", "findable");

-- CreateIndex
CREATE INDEX "LoopcomDirectVerification_userId_createdAt_idx" ON "LoopcomDirectVerification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoopcomDirectThread_pairKey_key" ON "LoopcomDirectThread"("pairKey");

-- CreateIndex
CREATE INDEX "LoopcomDirectParticipant_userId_state_idx" ON "LoopcomDirectParticipant"("userId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "LoopcomDirectParticipant_threadId_userId_key" ON "LoopcomDirectParticipant"("threadId", "userId");

-- CreateIndex
CREATE INDEX "LoopcomDirectMessage_threadId_createdAt_idx" ON "LoopcomDirectMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "LoopcomDirectBlock_blockedUserId_idx" ON "LoopcomDirectBlock"("blockedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "LoopcomDirectBlock_blockerUserId_blockedUserId_key" ON "LoopcomDirectBlock"("blockerUserId", "blockedUserId");

-- AddForeignKey
ALTER TABLE "LoopcomDirectIdentity" ADD CONSTRAINT "LoopcomDirectIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopcomDirectIdentity" ADD CONSTRAINT "LoopcomDirectIdentity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopcomDirectParticipant" ADD CONSTRAINT "LoopcomDirectParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "LoopcomDirectThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopcomDirectParticipant" ADD CONSTRAINT "LoopcomDirectParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopcomDirectMessage" ADD CONSTRAINT "LoopcomDirectMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "LoopcomDirectThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

