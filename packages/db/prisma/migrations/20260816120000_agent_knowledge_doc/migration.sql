-- Standing knowledge the assistant reads before answering: one system document
-- plus one per company. Published from docs/agent-knowledge/*.md by the api at
-- boot; the agent reads these rows, so knowledge edits never need an agent
-- rebuild.
CREATE TABLE "AgentKnowledgeDoc" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "tenantId" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internalBody" TEXT,
    "checksum" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'repo',
    "sourcePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentKnowledgeDoc_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentKnowledgeDoc_slug_key" ON "AgentKnowledgeDoc"("slug");
CREATE INDEX "AgentKnowledgeDoc_scope_tenantId_idx" ON "AgentKnowledgeDoc"("scope", "tenantId");
