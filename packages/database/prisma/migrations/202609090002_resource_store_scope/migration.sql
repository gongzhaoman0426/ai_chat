PRAGMA defer_foreign_keys=ON;

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_KnowledgeEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'enabled',
    "activeRevisionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_KnowledgeEntry" ("id", "storeId", "status", "activeRevisionId", "createdAt", "updatedAt") SELECT "id", "storeId", "status", "activeRevisionId", "createdAt", "updatedAt" FROM "KnowledgeEntry";

DROP TABLE "KnowledgeEntry";

ALTER TABLE "new_KnowledgeEntry" RENAME TO "KnowledgeEntry";

CREATE TABLE "new_Attachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT,
    "relativePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "new_Attachment" ("id", "storeId", "relativePath", "mimeType", "size", "hash", "name", "createdAt") SELECT "id", "storeId", "relativePath", "mimeType", "size", "hash", "name", "createdAt" FROM "Attachment";

DROP TABLE "Attachment";

ALTER TABLE "new_Attachment" RENAME TO "Attachment";

CREATE INDEX "KnowledgeEntry_storeId_status_idx" ON "KnowledgeEntry"("storeId", "status");

CREATE TABLE "ResourceScope" (
    "kind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'all',
    "storeIds" JSONB NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY ("kind", "resourceId")
);

PRAGMA foreign_keys=ON;

PRAGMA defer_foreign_keys=OFF;
