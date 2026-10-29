-- Preserve all IDs and existing platform values; equal external IDs on different platforms are distinct stores.
DROP INDEX "Store_externalId_key";
CREATE UNIQUE INDEX "Store_platform_externalId_key" ON "Store"("platform", "externalId");
ALTER TABLE "Conversation" ADD COLUMN "platformContext" JSONB NOT NULL DEFAULT '{}';
INSERT OR IGNORE INTO "AppSetting" ("key", "value") SELECT replace("key", 'pdd.connection:', 'platform.connection:'), "value" FROM "AppSetting" WHERE "key" LIKE 'pdd.connection:%';
INSERT OR IGNORE INTO "AppSetting" ("key", "value") SELECT replace("key", 'pdd.autoconnect:', 'platform.autoconnect:'), "value" FROM "AppSetting" WHERE "key" LIKE 'pdd.autoconnect:%';
DELETE FROM "AppSetting" WHERE "key" LIKE 'pdd.connection:%' OR "key" LIKE 'pdd.autoconnect:%';
