-- CreateTable
CREATE TABLE "WorkbenchSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "routeVersion" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PlatformAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "sessionId" TEXT,
    "requestId" TEXT,
    "storeId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "sourceEvidenceId" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "input" JSONB NOT NULL,
    "preview" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlatformAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlatformAction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PlatformAction" ("accountId", "buyerId", "conversationId", "createdAt", "dedupKey", "id", "input", "operation", "preview", "result", "runId", "sourceEvidenceId", "status", "storeId", "targetId", "updatedAt") SELECT "accountId", "buyerId", "conversationId", "createdAt", "dedupKey", "id", "input", "operation", "preview", "result", "runId", "sourceEvidenceId", "status", "storeId", "targetId", "updatedAt" FROM "PlatformAction";
DROP TABLE "PlatformAction";
ALTER TABLE "new_PlatformAction" RENAME TO "PlatformAction";
CREATE UNIQUE INDEX "PlatformAction_requestId_key" ON "PlatformAction"("requestId");
CREATE UNIQUE INDEX "PlatformAction_dedupKey_key" ON "PlatformAction"("dedupKey");
CREATE INDEX "PlatformAction_storeId_status_createdAt_idx" ON "PlatformAction"("storeId", "status", "createdAt");
CREATE TABLE "new_PlatformEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "sessionId" TEXT,
    "storeId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "subjectId" TEXT,
    "queryKey" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformEvidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlatformEvidence_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PlatformEvidence" ("accountId", "buyerId", "conversationId", "id", "input", "observedAt", "operation", "queryKey", "result", "runId", "storeId", "subjectId") SELECT "accountId", "buyerId", "conversationId", "id", "input", "observedAt", "operation", "queryKey", "result", "runId", "storeId", "subjectId" FROM "PlatformEvidence";
DROP TABLE "PlatformEvidence";
ALTER TABLE "new_PlatformEvidence" RENAME TO "PlatformEvidence";
CREATE INDEX "PlatformEvidence_storeId_conversationId_observedAt_idx" ON "PlatformEvidence"("storeId", "conversationId", "observedAt");
CREATE UNIQUE INDEX "PlatformEvidence_runId_queryKey_key" ON "PlatformEvidence"("runId", "queryKey");
CREATE UNIQUE INDEX "PlatformEvidence_sessionId_queryKey_key" ON "PlatformEvidence"("sessionId", "queryKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "WorkbenchSession_conversationId_expiresAt_idx" ON "WorkbenchSession"("conversationId", "expiresAt");

