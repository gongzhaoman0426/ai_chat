-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" JSONB NOT NULL
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL DEFAULT 'pinduoduo',
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "replyConfigEpoch" INTEGER NOT NULL DEFAULT 1,
    "learningConfigEpoch" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ReplyPolicy" (
    "storeId" TEXT NOT NULL PRIMARY KEY,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "directMatchThreshold" REAL NOT NULL DEFAULT 0.9,
    "maxCallsPerDay" INTEGER NOT NULL DEFAULT 500,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "ReplyPolicy_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LearningPolicy" (
    "storeId" TEXT NOT NULL PRIMARY KEY,
    "autoLearnEnabled" BOOLEAN NOT NULL DEFAULT false,
    "builtinModelRef" TEXT,
    "maxCallsPerDay" INTEGER NOT NULL DEFAULT 300,
    "enableEpoch" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "LearningPolicy_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sessionPartition" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "capabilities" JSONB NOT NULL,
    "lastSeenAt" DATETIME,
    "verifiedAt" DATETIME,
    CONSTRAINT "Account_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "buyerName" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "routeVersion" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "openedByHuman" BOOLEAN NOT NULL DEFAULT false,
    "awaitingHuman" BOOLEAN NOT NULL DEFAULT false,
    "humanSentAfterHandoff" BOOLEAN NOT NULL DEFAULT false,
    "handoffReason" TEXT,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "preview" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Conversation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT NOT NULL DEFAULT '',
    "attachmentId" TEXT,
    "timestamp" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB NOT NULL,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MessageReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MessageGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "messageIds" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "autoEligible" BOOLEAN NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'waiting_answer',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealedAt" DATETIME NOT NULL,
    CONSTRAINT "MessageGroup_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnsweredTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "questionGroupId" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'answered',
    "answeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnsweredTurn_questionGroupId_fkey" FOREIGN KEY ("questionGroupId") REFERENCES "MessageGroup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TurnAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "outboundId" TEXT,
    CONSTRAINT "TurnAnswer_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "AnsweredTurn" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TurnAnswer_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BusinessEvent" (
    "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventKey" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "learningCaptureEpoch" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LearningSubscription" (
    "storeId" TEXT NOT NULL PRIMARY KEY,
    "eventCursor" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "storeId" TEXT,
    "conversationId" TEXT,
    "dedupKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "runConfigSnapshotId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "intentKey" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "routeVersion" INTEGER NOT NULL,
    "conversationRevision" INTEGER NOT NULL,
    "replyConfigEpoch" INTEGER NOT NULL,
    "questionGroupId" TEXT,
    "origin" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "aiRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "externalId" TEXT,
    "dispatchToken" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "KnowledgeEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'enabled',
    "activeRevisionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "KnowledgeRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "intent" TEXT NOT NULL,
    "answerKind" TEXT NOT NULL,
    "answer" TEXT NOT NULL DEFAULT '',
    "attachmentId" TEXT,
    "scope" JSONB NOT NULL,
    "validUntil" DATETIME,
    "approvalSource" TEXT NOT NULL DEFAULT 'human',
    "approvalId" TEXT,
    "evaluationId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeRevision_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "KnowledgeEntry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revisionId" TEXT NOT NULL,
    "turnId" TEXT,
    "messageId" TEXT,
    "sourceRevision" INTEGER,
    "rootSourceId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "KnowledgeIndexRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revisionId" TEXT NOT NULL,
    "profileHash" TEXT NOT NULL,
    "vectorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT
);

-- CreateTable
CREATE TABLE "LearningEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "evaluatorVersion" TEXT NOT NULL,
    "aiRunId" TEXT,
    "inputSnapshot" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LearningEvaluation_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "AnsweredTurn" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KnowledgeCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "actionIndex" INTEGER NOT NULL,
    "candidateVersion" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "action" TEXT NOT NULL,
    "targetEntryId" TEXT,
    "expectedActiveRevisionId" TEXT,
    "sourceRevision" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeCandidate_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "LearningEvaluation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KnowledgeReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "candidateVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "expectedActiveRevisionId" TEXT,
    "decision" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL DEFAULT 'local-user',
    "reason" TEXT,
    "reviewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeReview_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "KnowledgeCandidate" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KnowledgeChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "applyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultRevisionId" TEXT,
    "error" TEXT
);

-- CreateTable
CREATE TABLE "ModelProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'chat',
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "model" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "secretRef" TEXT,
    "dimensions" INTEGER,
    "maxTokens" INTEGER NOT NULL DEFAULT 2048,
    "timeoutMs" INTEGER NOT NULL DEFAULT 60000,
    "revision" INTEGER NOT NULL DEFAULT 1
);

-- CreateTable
CREATE TABLE "AgentDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'user',
    "draftConfig" JSONB NOT NULL,
    "draftRevision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentRevision_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentDefinition" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentBinding" (
    "scopeKey" TEXT NOT NULL PRIMARY KEY,
    "agentRevisionId" TEXT NOT NULL,
    "entryWorkflowRef" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1
);

-- CreateTable
CREATE TABLE "AgentRevisionSubAgent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentRevisionId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "childRevisionId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "InstalledExtension" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "relativePath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'enabled'
);

-- CreateTable
CREATE TABLE "AssetSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RunConfigSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "configEpoch" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT,
    "storeId" TEXT NOT NULL,
    "conversationId" TEXT,
    "role" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "snapshotId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "usage" JSONB NOT NULL,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_externalId_key" ON "Store"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_sessionPartition_key" ON "Account"("sessionPartition");

-- CreateIndex
CREATE UNIQUE INDEX "Account_storeId_externalId_key" ON "Account"("storeId", "externalId");

-- CreateIndex
CREATE INDEX "Conversation_storeId_updatedAt_idx" ON "Conversation"("storeId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_storeId_externalKey_key" ON "Conversation"("storeId", "externalKey");

-- CreateIndex
CREATE INDEX "Message_conversationId_timestamp_id_idx" ON "Message"("conversationId", "timestamp", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_storeId_externalId_key" ON "Message"("storeId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReceipt_accountId_eventKey_key" ON "MessageReceipt"("accountId", "eventKey");

-- CreateIndex
CREATE INDEX "MessageGroup_conversationId_state_idx" ON "MessageGroup"("conversationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "AnsweredTurn_questionGroupId_key" ON "AnsweredTurn"("questionGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "TurnAnswer_turnId_messageId_key" ON "TurnAnswer"("turnId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEvent_eventKey_key" ON "BusinessEvent"("eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupKey_key" ON "Job"("dedupKey");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_priority_idx" ON "Job"("status", "runAfter", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_intentKey_key" ON "OutboundMessage"("intentKey");

-- CreateIndex
CREATE INDEX "OutboundMessage_status_updatedAt_idx" ON "OutboundMessage"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_storeId_status_idx" ON "KnowledgeEntry"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeRevision_entryId_version_key" ON "KnowledgeRevision"("entryId", "version");

-- CreateIndex
CREATE INDEX "KnowledgeSource_revisionId_idx" ON "KnowledgeSource"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeIndexRecord_revisionId_profileHash_key" ON "KnowledgeIndexRecord"("revisionId", "profileHash");

-- CreateIndex
CREATE UNIQUE INDEX "LearningEvaluation_storeId_turnId_sourceRevision_evaluatorVersion_key" ON "LearningEvaluation"("storeId", "turnId", "sourceRevision", "evaluatorVersion");

-- CreateIndex
CREATE INDEX "KnowledgeCandidate_storeId_status_idx" ON "KnowledgeCandidate"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeCandidate_evaluationId_actionIndex_key" ON "KnowledgeCandidate"("evaluationId", "actionIndex");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeReview_requestId_key" ON "KnowledgeReview"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChange_approvalId_key" ON "KnowledgeChange"("approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChange_applyKey_key" ON "KnowledgeChange"("applyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRevision_agentId_revision_key" ON "AgentRevision"("agentId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRevisionSubAgent_parentRevisionId_alias_key" ON "AgentRevisionSubAgent"("parentRevisionId", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "InstalledExtension_assetId_version_key" ON "InstalledExtension"("assetId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AssetSetting_assetId_scopeKey_revision_key" ON "AssetSetting"("assetId", "scopeKey", "revision");

-- CreateIndex
CREATE INDEX "AiRun_storeId_role_startedAt_idx" ON "AiRun"("storeId", "role", "startedAt");

-- CreateIndex
CREATE INDEX "AuditEvent_scope_createdAt_idx" ON "AuditEvent"("scope", "createdAt");

