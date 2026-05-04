-- Tenant-scoped outbound route prefixes used by Connect dialers.
CREATE TABLE "OutboundRoute" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT,
    "callerIdName" TEXT,
    "callerIdNumber" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundRoute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserOutboundRoutePermission" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "outboundRouteId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserOutboundRoutePermission_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutboundRoute_tenantId_idx" ON "OutboundRoute"("tenantId");
CREATE INDEX "OutboundRoute_tenantId_isActive_idx" ON "OutboundRoute"("tenantId", "isActive");
CREATE INDEX "OutboundRoute_tenantId_sortOrder_idx" ON "OutboundRoute"("tenantId", "sortOrder");

CREATE UNIQUE INDEX "UserOutboundRoutePermission_userId_outboundRouteId_key" ON "UserOutboundRoutePermission"("userId", "outboundRouteId");
CREATE INDEX "UserOutboundRoutePermission_tenantId_idx" ON "UserOutboundRoutePermission"("tenantId");
CREATE INDEX "UserOutboundRoutePermission_tenantId_userId_idx" ON "UserOutboundRoutePermission"("tenantId", "userId");
CREATE INDEX "UserOutboundRoutePermission_tenantId_outboundRouteId_idx" ON "UserOutboundRoutePermission"("tenantId", "outboundRouteId");

ALTER TABLE "OutboundRoute" ADD CONSTRAINT "OutboundRoute_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserOutboundRoutePermission" ADD CONSTRAINT "UserOutboundRoutePermission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserOutboundRoutePermission" ADD CONSTRAINT "UserOutboundRoutePermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserOutboundRoutePermission" ADD CONSTRAINT "UserOutboundRoutePermission_outboundRouteId_fkey" FOREIGN KEY ("outboundRouteId") REFERENCES "OutboundRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
