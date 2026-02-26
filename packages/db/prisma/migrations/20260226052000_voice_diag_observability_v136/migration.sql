DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VoiceClientPlatform') THEN
    CREATE TYPE "VoiceClientPlatform" AS ENUM ('WEB', 'IOS', 'ANDROID');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VoiceDiagRegState') THEN
    CREATE TYPE "VoiceDiagRegState" AS ENUM ('IDLE', 'REGISTERING', 'REGISTERED', 'FAILED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VoiceDiagCallState') THEN
    CREATE TYPE "VoiceDiagCallState" AS ENUM ('IDLE', 'DIALING', 'RINGING', 'CONNECTED', 'ENDED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VoiceDiagEventType') THEN
    CREATE TYPE "VoiceDiagEventType" AS ENUM (
      'SESSION_START', 'SESSION_HEARTBEAT', 'SIP_REGISTER', 'SIP_UNREGISTER',
      'WS_CONNECTED', 'WS_DISCONNECTED', 'WS_RECONNECT',
      'ICE_GATHERING', 'ICE_SELECTED_PAIR', 'TURN_TEST_RESULT',
      'INCOMING_INVITE', 'ANSWER_TAPPED', 'CALL_CONNECTED', 'CALL_ENDED', 'ERROR'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "VoiceClientSession" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "platform" "VoiceClientPlatform" NOT NULL,
  "deviceId" TEXT,
  "appVersion" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sipWsUrl" TEXT,
  "sipDomain" TEXT,
  "iceHasTurn" BOOLEAN NOT NULL DEFAULT false,
  "lastRegState" "VoiceDiagRegState" NOT NULL DEFAULT 'IDLE',
  "lastCallState" "VoiceDiagCallState" NOT NULL DEFAULT 'IDLE',
  "lastErrorCode" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  CONSTRAINT "VoiceClientSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoiceClientSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VoiceClientSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VoiceClientSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "MobileDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "VoiceDiagEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "type" "VoiceDiagEventType" NOT NULL,
  "payload" JSONB NOT NULL,
  CONSTRAINT "VoiceDiagEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoiceDiagEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VoiceDiagEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VoiceDiagEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "VoiceClientSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "VoiceClientSession_tenantId_startedAt_idx" ON "VoiceClientSession"("tenantId", "startedAt");
CREATE INDEX IF NOT EXISTS "VoiceClientSession_userId_lastSeenAt_idx" ON "VoiceClientSession"("userId", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "VoiceClientSession_deviceId_idx" ON "VoiceClientSession"("deviceId");
CREATE INDEX IF NOT EXISTS "VoiceDiagEvent_tenantId_createdAt_idx" ON "VoiceDiagEvent"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "VoiceDiagEvent_sessionId_createdAt_idx" ON "VoiceDiagEvent"("sessionId", "createdAt");
