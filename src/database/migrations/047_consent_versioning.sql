-- Migration: Consent document versioning + re-consent (ai-therapist-94)
-- Date: 2026-07-31
--
-- Makes the consent copy itself a versioned, hash-verified DB record so the
-- IRB can audit exactly what text each participant accepted. Replaces the
-- hardcoded CURRENT_CONSENT_VERSION constant as the source of truth: the
-- active document is the newest row with effective_at <= now().

CREATE TABLE IF NOT EXISTS consent_documents (
    document_id   BIGSERIAL PRIMARY KEY,
    version       VARCHAR(32) NOT NULL UNIQUE,      -- e.g. '2026-07-30.1'
    body          TEXT NOT NULL,                    -- markdown consent copy shown to participants
    body_hash     TEXT NOT NULL,                    -- hex sha256 of body (integrity check)
    effective_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by  VARCHAR(255) NOT NULL,            -- admin username; 'system-backfill' for v1
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_consent_documents_effective_at
    ON consent_documents(effective_at DESC);

COMMENT ON TABLE consent_documents IS 'Versioned IRB consent copy; active version = newest effective_at <= now()';
COMMENT ON COLUMN consent_documents.body_hash IS 'hex sha256(body); stored on each acceptance so what was shown is provable';

-- Tie each acceptance to the exact document text via its hash.
ALTER TABLE participant_consents ADD COLUMN IF NOT EXISTS body_hash TEXT;
COMMENT ON COLUMN participant_consents.body_hash IS 'sha256 of the consent body accepted (matches consent_documents.body_hash)';

-- Backfill v1 = the stable copy that shipped 2026-07-30 (extracted verbatim
-- from ConsentScreen.tsx as of that date). The conditional recording-disclosure
-- bullet stays client-rendered (it varies with features.session_recording_enabled)
-- and is deliberately NOT part of the hashed document body — see spec §1.5.
INSERT INTO consent_documents (version, body, body_hash, effective_at, published_by)
VALUES (
    '2026-07-30.1',
    $consent$## Before we begin

Please review and accept to start your session.

- **Transcription.** What you say is transcribed to text so the assistant can respond and so your session can be reviewed as part of this study.
- **Live monitoring.** A researcher or therapist may be monitoring sessions in real time and can send messages into your conversation if needed.
- **Data retention.** Session content is retained only as long as needed for the study and is redacted of identifying details before long-term storage. Raw content is automatically deleted after the retention period.
- **Crisis protocol.** If anything you say suggests you may be in danger, our system may show you crisis resources (e.g. the 988 Suicide & Crisis Lifeline), and in some cases a member of our team may be notified so they can reach out to you directly.$consent$,
    encode(sha256(convert_to($consent$## Before we begin

Please review and accept to start your session.

- **Transcription.** What you say is transcribed to text so the assistant can respond and so your session can be reviewed as part of this study.
- **Live monitoring.** A researcher or therapist may be monitoring sessions in real time and can send messages into your conversation if needed.
- **Data retention.** Session content is retained only as long as needed for the study and is redacted of identifying details before long-term storage. Raw content is automatically deleted after the retention period.
- **Crisis protocol.** If anything you say suggests you may be in danger, our system may show you crisis resources (e.g. the 988 Suicide & Crisis Lifeline), and in some cases a member of our team may be notified so they can reach out to you directly.$consent$, 'UTF8')), 'hex'),
    '2026-07-30T00:00:00Z',
    'system-backfill'
)
ON CONFLICT (version) DO NOTHING;

-- Stamp existing acceptances (all are version 2026-07-30.1) with the v1 hash.
UPDATE participant_consents pc
SET body_hash = cd.body_hash
FROM consent_documents cd
WHERE cd.version = pc.consent_version
  AND pc.body_hash IS NULL;
