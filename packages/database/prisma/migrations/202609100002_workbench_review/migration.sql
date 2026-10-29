ALTER TABLE "PlatformAction" ADD COLUMN "reviewedAt" DATETIME;
ALTER TABLE "PlatformAction" ADD COLUMN "reviewNote" TEXT;
CREATE INDEX "PlatformAction_conversationId_createdAt_idx" ON "PlatformAction"("conversationId", "createdAt");
