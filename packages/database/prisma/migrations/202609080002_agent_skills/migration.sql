-- Add a local skill library. Existing Agent drafts/revisions remain untouched.
CREATE TABLE "SkillDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "references" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "SkillDefinition_status_updatedAt_idx" ON "SkillDefinition"("status", "updatedAt");
