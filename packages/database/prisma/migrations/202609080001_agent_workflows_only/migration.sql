-- Workflows are Agent capabilities, not alternate reply entry points.
-- Preserve the selected Agent and invalidate only scopes whose routing changes.
UPDATE "Store" SET "replyConfigEpoch" = "replyConfigEpoch" + 1
WHERE EXISTS (
  SELECT 1 FROM "AgentBinding"
  WHERE "scopeKey" = 'store:' || "Store"."id" AND "entryWorkflowRef" IS NOT NULL
) OR (
  NOT EXISTS (SELECT 1 FROM "AgentBinding" WHERE "scopeKey" = 'store:' || "Store"."id")
  AND EXISTS (
    SELECT 1 FROM "AgentBinding" WHERE "scopeKey" = 'global' AND "entryWorkflowRef" IS NOT NULL
  )
);
UPDATE "AgentBinding" SET "revision" = "revision" + 1 WHERE "entryWorkflowRef" IS NOT NULL;
ALTER TABLE "AgentBinding" DROP COLUMN "entryWorkflowRef";
