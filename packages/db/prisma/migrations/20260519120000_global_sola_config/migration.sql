-- CreateTable: platform-wide Cardknox/SOLA gateway defaults
CREATE TABLE "GlobalSolaConfig" (
    "id"        TEXT NOT NULL DEFAULT 'default',
    "ifieldsKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "GlobalSolaConfig_pkey" PRIMARY KEY ("id")
);
