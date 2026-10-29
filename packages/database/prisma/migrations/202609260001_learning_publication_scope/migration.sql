-- NULL preserves the source-store publication behavior of existing approvals.
ALTER TABLE "KnowledgeReview" ADD COLUMN "publicationScope" JSONB;
