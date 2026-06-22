-- Add explicit shared/personal mailbox mode for users assigned to the same SMS DID.
-- Existing assignments keep today's behavior: shared restricted inbox.
ALTER TABLE "TenantSmsNumberUser"
ADD COLUMN "inboxMode" VARCHAR(16) NOT NULL DEFAULT 'SHARED';

CREATE INDEX "TenantSmsNumberUser_tenantSmsNumberId_inboxMode_idx"
ON "TenantSmsNumberUser"("tenantSmsNumberId", "inboxMode");
