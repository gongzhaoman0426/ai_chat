-- Skill scripts are versioned with the rest of the Skill content.
-- Existing AgentRevision JSON/hashes must remain unchanged.
ALTER TABLE "SkillDefinition" ADD COLUMN "scripts" JSONB NOT NULL DEFAULT '{}';
