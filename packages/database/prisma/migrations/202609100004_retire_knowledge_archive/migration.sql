-- Retire the archive state without silently deleting another installation's data.
-- Legacy rows remain visible and inactive until the user explicitly deletes them.
UPDATE "KnowledgeEntry" SET "status" = 'disabled' WHERE "status" = 'archived';
