CREATE TABLE "PlatformEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "buyerId" TEXT NOT NULL,
  "operation" TEXT NOT NULL, "subjectId" TEXT, "queryKey" TEXT NOT NULL,
  "input" JSONB NOT NULL, "result" JSONB NOT NULL, "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformEvidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlatformEvidence_runId_queryKey_key" ON "PlatformEvidence"("runId", "queryKey");
CREATE INDEX "PlatformEvidence_storeId_conversationId_observedAt_idx" ON "PlatformEvidence"("storeId", "conversationId", "observedAt");
CREATE TABLE "PlatformAction" (
  "id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL, "storeId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "buyerId" TEXT NOT NULL,
  "operation" TEXT NOT NULL, "targetId" TEXT NOT NULL, "sourceEvidenceId" TEXT NOT NULL,
  "dedupKey" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'prepared',
  "input" JSONB NOT NULL, "preview" JSONB NOT NULL, "result" JSONB NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PlatformAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PlatformAction_dedupKey_key" ON "PlatformAction"("dedupKey");
CREATE INDEX "PlatformAction_storeId_status_createdAt_idx" ON "PlatformAction"("storeId", "status", "createdAt");
