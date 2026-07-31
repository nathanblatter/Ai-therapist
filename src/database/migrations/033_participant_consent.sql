-- Migration: Participant consent records (IRB requirement).
-- Description: Track acceptance of the pre-session consent screen (recording,
-- transcription, live admin monitoring, data retention, crisis-protocol
-- disclosure) per therapy session and, for logged-in users, per user as well.
-- Date: 2026-07-30

CREATE TABLE IF NOT EXISTS participant_consents (
    consent_id BIGSERIAL PRIMARY KEY,
    -- NULL when acceptance happens before a session exists yet (recorded again
    -- against the session once one is created); set for the durable per-session
    -- record.
    session_id UUID REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    -- Present for logged-in users so consent can be looked up across sessions.
    user_id INTEGER REFERENCES users(userid) ON DELETE SET NULL,
    consent_version VARCHAR(32) NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Snapshot of features.session_recording_enabled at the moment consent was
    -- shown, so the copy the participant actually saw is auditable even if the
    -- flag changes later.
    recording_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_participant_consents_session_id ON participant_consents(session_id);
CREATE INDEX IF NOT EXISTS idx_participant_consents_user_id ON participant_consents(user_id);

COMMENT ON TABLE participant_consents IS 'IRB consent acceptance records: recording, transcription, live monitoring, retention, crisis-protocol disclosure';
COMMENT ON COLUMN participant_consents.session_id IS 'The therapy session this acceptance gated; NULL for the initial pre-session acceptance before a session_id exists';
COMMENT ON COLUMN participant_consents.consent_version IS 'Version string of the consent copy shown (bump when the copy materially changes)';
COMMENT ON COLUMN participant_consents.recording_enabled IS 'Snapshot of features.session_recording_enabled at accept time';
