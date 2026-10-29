-- Daily reply and learning calls are unlimited. Preserve other policy settings
-- and all historical runs, jobs, learning evaluations and approvals.
ALTER TABLE "ReplyPolicy" DROP COLUMN "maxCallsPerDay";
ALTER TABLE "LearningPolicy" DROP COLUMN "maxCallsPerDay";
