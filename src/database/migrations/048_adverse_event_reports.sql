-- Migration: IRB adverse-event reports (ai-therapist-95)
-- Date: 2026-07-31
--
-- Turns qualifying crisis events (high-severity flags) into reviewable,
-- sign-off-able IRB adverse-event records. Rows are self-contained snapshots:
-- timeline + redacted excerpt are copied in at draft time so content
-- retention wipes or session deletion never hollow out a filed report.

CREATE TABLE IF NOT EXISTS adverse_event_reports (
    report_id       BIGSERIAL PRIMARY KEY,
    -- Provenance links: kept when possible, but nullable + SET NULL so the
    -- report outlives its source rows.
    session_id      TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
    crisis_event_id BIGINT REFERENCES crisis_events(event_id) ON DELETE SET NULL,
    user_id         INTEGER REFERENCES users(userid) ON DELETE SET NULL,
    -- Snapshot identifiers that survive FK nulling:
    session_ref     TEXT NOT NULL,                  -- copy of session_id at draft time
    participant_ref TEXT,                           -- 'user 42' or 'anonymous'
    occurred_at     TIMESTAMPTZ NOT NULL,           -- when the qualifying event happened
    severity        VARCHAR(10) NOT NULL CHECK (severity IN ('low','medium','high')),
    trigger_source  VARCHAR(30) NOT NULL CHECK (trigger_source IN ('auto_crisis_flag','manual')),
    -- Editable report content:
    summary         TEXT NOT NULL DEFAULT '',       -- narrative, admin-edited
    timeline        JSONB NOT NULL DEFAULT '[]',    -- [{at, kind, detail}] from crisis_events/risk_check_steps/intervention_actions
    transcript_excerpt TEXT,                        -- REDACTED excerpt only (content_redacted / redactPHI output)
    actions_taken   JSONB NOT NULL DEFAULT '[]',    -- [{at, action, by}] from intervention_actions (+ manual additions)
    -- Lifecycle:
    status          VARCHAR(12) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','closed')),
    due_at          TIMESTAMPTZ NOT NULL,           -- reporting deadline; default occurred_at + 7 days, editable
    submitted_by    VARCHAR(255),                   -- reporter identity (sign-off)
    submitted_at    TIMESTAMPTZ,
    closed_by       VARCHAR(255),
    closed_at       TIMESTAMPTZ,
    created_by      VARCHAR(255) NOT NULL DEFAULT 'system',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ae_submitted_signoff CHECK (status = 'draft' OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL))
);

-- One auto-draft per crisis event (repeat high flags on a session escalate the
-- same underlying event only if they share the crisis_event_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ae_reports_crisis_event
    ON adverse_event_reports(crisis_event_id) WHERE crisis_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ae_reports_status ON adverse_event_reports(status);
CREATE INDEX IF NOT EXISTS idx_ae_reports_due_at ON adverse_event_reports(due_at) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS idx_ae_reports_session ON adverse_event_reports(session_id);

COMMENT ON TABLE adverse_event_reports IS 'IRB adverse-event reports auto-drafted from high-severity crisis flags (ai-therapist-95)';
COMMENT ON COLUMN adverse_event_reports.transcript_excerpt IS 'Redacted-only excerpt (never raw content) — safe for export/print';
