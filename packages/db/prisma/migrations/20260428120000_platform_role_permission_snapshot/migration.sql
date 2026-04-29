-- Singleton JSON snapshot for portal role → permission[] overrides (SUPER_ADMIN UI).
CREATE TABLE "PlatformRolePermissionSnapshot" (
    "id" TEXT NOT NULL,
    "roles" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformRolePermissionSnapshot_pkey" PRIMARY KEY ("id")
);
