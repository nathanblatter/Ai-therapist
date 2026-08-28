-- Migration 078: consent_documents.audience + seeded clinical care-team
-- consent doc (caseworker portal, docs/caseworker-portal.md sections 1 and 6).
-- The clinical doc copy is the verbatim draft pending Nathan's review (spec
-- section 6); publishing a reviewed version supersedes it the normal way.
-- Date: 2026-08-27

BEGIN;

ALTER TABLE consent_documents
  ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'research'
  CHECK (audience IN ('research','clinical'));

-- Replace the 047 effective_at index with an audience-composite one
-- (047's index name verified: idx_consent_documents_effective_at).
DROP INDEX IF EXISTS idx_consent_documents_effective_at;
CREATE INDEX IF NOT EXISTS idx_consent_documents_effective
  ON consent_documents(audience, effective_at DESC);

-- Seed the clinical care-team consent doc (spec section 6 verbatim),
-- body_hash computed the same way the 047 seed does.
INSERT INTO consent_documents (version, body, body_hash, effective_at, published_by, audience)
VALUES (
  '2026-08-27.c1',
  $consent$## Before we begin

Please review and accept before starting your session.

- **What this is.** This app provides AI-assisted support sessions as part of the care you receive from your provider. It is not a replacement for your therapist and does not provide medical diagnoses.
- **Transcription.** What you say is transcribed to text so the assistant can respond and so your care team can review your sessions.
- **Your care team.** Your therapist can see your full sessions, including transcripts. If a care coordinator (caseworker) is part of your care team, they can see summaries and signals only — AI-written session summaries, mood and questionnaire trends, safety plans, check-ins, and safety alerts — never your word-for-word conversation.
- **Live monitoring.** A member of your care team may monitor sessions in real time and can send messages into your conversation if needed.
- **Crisis protocol.** If anything you say suggests you may be in danger, the system may show you crisis resources (e.g. the 988 Suicide & Crisis Lifeline), and a member of your care team may be notified so they can reach out to you directly.
- **Data handling.** Your session content is stored securely, is visible only to your care team as described above, and is retained according to your provider's records policy. Identifying details are redacted before any long-term storage.
- **Messaging.** If you and your care team use in-app messages, those messages are automatically screened for safety concerns and may trigger the same crisis protocol.

You can ask your provider any questions about this before accepting.$consent$,
  encode(sha256(convert_to($consent$## Before we begin

Please review and accept before starting your session.

- **What this is.** This app provides AI-assisted support sessions as part of the care you receive from your provider. It is not a replacement for your therapist and does not provide medical diagnoses.
- **Transcription.** What you say is transcribed to text so the assistant can respond and so your care team can review your sessions.
- **Your care team.** Your therapist can see your full sessions, including transcripts. If a care coordinator (caseworker) is part of your care team, they can see summaries and signals only — AI-written session summaries, mood and questionnaire trends, safety plans, check-ins, and safety alerts — never your word-for-word conversation.
- **Live monitoring.** A member of your care team may monitor sessions in real time and can send messages into your conversation if needed.
- **Crisis protocol.** If anything you say suggests you may be in danger, the system may show you crisis resources (e.g. the 988 Suicide & Crisis Lifeline), and a member of your care team may be notified so they can reach out to you directly.
- **Data handling.** Your session content is stored securely, is visible only to your care team as described above, and is retained according to your provider's records policy. Identifying details are redacted before any long-term storage.
- **Messaging.** If you and your care team use in-app messages, those messages are automatically screened for safety concerns and may trigger the same crisis protocol.

You can ask your provider any questions about this before accepting.$consent$, 'UTF8')), 'hex'),
  CURRENT_TIMESTAMP,
  'system-seed-078',
  'clinical'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
