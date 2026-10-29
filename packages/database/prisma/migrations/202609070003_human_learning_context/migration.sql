-- Existing turns remain explicit. Do not replay historical human messages.
ALTER TABLE "AnsweredTurn" ADD COLUMN "associationMode" TEXT NOT NULL DEFAULT 'explicit';
ALTER TABLE "AnsweredTurn" ADD COLUMN "contextMessageIds" JSONB NOT NULL DEFAULT '[]';
