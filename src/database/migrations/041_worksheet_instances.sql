-- Migration: Personalized worksheet instances (ai-therapist-73)
-- Date: 2026-07-30
--
-- Backs the create_custom_worksheet tool: the model personalizes wording
-- within the structure of a vetted worksheet TEMPLATE retrieved via
-- find_worksheet (knowledge_chunks WHERE kind='worksheet'). Each generated
-- instance is stored here for researcher review and possible later promotion
-- into the vetted corpus (via knowledge.queries.upsertKnowledgeChunk).
-- Depends on 031/032 (knowledge_chunks).

CREATE TABLE IF NOT EXISTS worksheet_instances (
    instance_id       BIGSERIAL PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    template_chunk_id BIGINT REFERENCES knowledge_chunks(chunk_id) ON DELETE SET NULL,
    template_title    TEXT,               -- denormalized snapshot in case the template changes/is deleted later
    title             TEXT NOT NULL,       -- model-personalized worksheet title
    intro             TEXT,                -- model-personalized short intro
    sections          JSONB NOT NULL,      -- [{ type, label, placeholder? }, ...] — validated against template structure at creation
    responses         JSONB,               -- participant's answers, filled in when they submit
    status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
    promoted          BOOLEAN NOT NULL DEFAULT FALSE, -- researcher promoted this instance into the vetted corpus
    created_at        TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_worksheet_instances_session ON worksheet_instances(session_id);
CREATE INDEX IF NOT EXISTS idx_worksheet_instances_template ON worksheet_instances(template_chunk_id);

COMMENT ON TABLE worksheet_instances IS 'Model-personalized worksheets generated within a vetted template structure (create_custom_worksheet tool); researcher review + promotion queue';
COMMENT ON COLUMN worksheet_instances.sections IS 'Array of {type, label, placeholder?}; type in (text, textarea, scale)';
