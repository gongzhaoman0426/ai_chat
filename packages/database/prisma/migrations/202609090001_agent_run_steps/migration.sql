ALTER TABLE "AiRun" ADD COLUMN "traceVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "AiRunStep" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "parentId" TEXT,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "toolName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'running',
  "input" JSONB NOT NULL,
  "output" JSONB NOT NULL,
  "metadata" JSONB NOT NULL,
  "error" TEXT,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" DATETIME,
  CONSTRAINT "AiRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AiRunStep_runId_sequence_key" ON "AiRunStep"("runId", "sequence");
CREATE INDEX "AiRunStep_runId_parentId_idx" ON "AiRunStep"("runId", "parentId");
