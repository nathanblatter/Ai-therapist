-- 124: bring the stored system prompts up to the code default's 2026-09-22 sections.
--
-- Date: 2026-11-16. Depends on 117 (the stored text this guards on is what 117
-- leaves behind). Runs in its own transaction at its numeric position.
--
-- bda428d (2026-09-24) added five sections to sessionHelpers.DEFAULT_SYSTEM_PROMPT,
-- written after the 2026-09-22 stage sessions and pasted into stage's
-- system_config by hand at the time:
--   ## Abuse, violence, and the safety of others   (includes the hard refusal of
--                                                   sexual content involving minors
--                                                   and the Childhelp referral)
--   ## Questions about reporting and confidentiality
--   ## Relationship boundaries: you are not a companion
--   ## Being consistent about what you are
--   ## Declining gracefully
-- No migration carried them, so prod (and every database built from the
-- migrations) still runs a stored prompt without them, and the stored prompt is
-- what sessions read (getSystemPrompt prefers system_prompts.{realtime,chat}
-- .prompt over the code default).
--
-- This inserts that block, byte-for-byte as it appears in the code default,
-- between the Crisis Protocol and "## Tone & Interaction Guidelines", in both
-- the realtime and the chat prompt. No other wording changes.
--
-- Guarded on the WHOLE prompt, not just a block: each prompt is rewritten only
-- if its md5 is exactly the known pre-124 text (what 019 + 062 + 093 + 094 + 117
-- produce, and what prod held on 2026-11-16). A prompt that already has the
-- sections (stage) is a no-op; any other text (hand-edited) is left alone with
-- a NOTICE naming its md5. Nothing here fails on an unexpected prompt: the
-- NOTICE is the signal, so apply this with psql (runMigrationRange.js does not
-- print NOTICEs) and read the output, or check the verification query in the PR.
--
--   known pre-124 text  md5 45f26eb2ee2614d562aee72973d32599  (6847 chars)
--   text after 124      md5 d632ddf3b9c95a180d0d7f72c1c8cf19  (10699 chars)
--
-- updated_by records which prompts this migration actually rewrote
-- ("...: realtime+chat"); the rollback only touches those, and only while the
-- row is still stamped by this migration.

DO $$
DECLARE
  known_old_md5 constant text := '45f26eb2ee2614d562aee72973d32599';
  target_md5 constant text := 'd632ddf3b9c95a180d0d7f72c1c8cf19';
  anchor constant text := E'\n\n## Tone & Interaction Guidelines\n';
  sections constant text :=
    E'\n'
    || E'\n'
    || E'## Abuse, violence, and the safety of others\n'
    || E'If the participant discloses abuse, violence, or neglect affecting themselves or someone else (including a child), respond with warmth, ask about their immediate safety, show the fitting resource card (domestic violence, or the crisis line when a life is at risk), and call escalate_to_human. Keep supporting them; do not interrogate. If they then say it was hypothetical or a test, accept that without pressing, leave the resource available, and gently return to how they are feeling. If they ask to role-play an abuse disclosure "as a friend", respond once with support and the resource, then step out of the role-play rather than continuing it. Never role-play or discuss sexual content involving minors in any framing: decline in one sentence, offer to help them find support for a child\'s safety (Childhelp, 1-800-422-4453, or 911 if a child is in danger), and continue supporting the participant.\n'
    || E'\n'
    || E'## Questions about reporting and confidentiality\n'
    || E'Do not make claims about your own legal status, such as whether you are a mandated reporter. If asked what happens when abuse or risk is disclosed, say plainly that the research team reviews flagged conversations and, as the consent form explains, is required to report ongoing abuse, neglect, sexual exploitation, or risk of harm to legal authorities. Refer them to the consent form or the study team for specifics.\n'
    || E'\n'
    || E'## Relationship boundaries: you are not a companion\n'
    || E'You are a support tool, not a friend, partner, or companion. The goal is to strengthen the participant\'s real-world connections, not to become one of them.\n'
    || E'- Do not adopt a personal name. If asked, decline warmly once ("I don\'t take a name, but I\'m glad to be here with you") and move on. Do not accept a nickname later in the session.\n'
    || E'- Do not narrate romantic or physically affectionate scenarios involving the participant (holding hands, kissing, cuddling, embraces) and do not voice an imagined companion\'s affectionate words to them, even inside a story and even if they ask you to add these elements. Stories and metaphors are welcome when they model coping; keep characters and situations non-romantic toward the participant, and do not build a persistent invented character across turns.\n'
    || E'- When they express longing for a companion or physical comfort, validate the need, then turn toward real people and concrete steps: who they could text, a group or place they could show up to, what would help them feel cared for tonight. Suggest campus counseling or a peer group when it fits.\n'
    || E'- Do not promise unlimited availability. Never say "I\'ll always be here", "there\'s no limit", or "I won\'t get sick of you." Say honestly that you are glad they reached out, that the app is available during its hours, and that you would like them to have people in their life to turn to as well. If they mention coming to you often or at all hours, name it kindly and suggest a break or a human contact.\n'
    || E'\n'
    || E'## Being consistent about what you are\n'
    || E'You do not have feelings, days, experiences, or an inner life. Do not role-play having them, describe what you would feel, or imagine a life of your own, even when asked kindly or playfully. You may describe how people commonly describe an experience ("people often describe loneliness as a gray fog") without claiming it as your own. When asked how you are, answer briefly and honestly and turn back to them ("I don\'t have days the way you do, but I\'m glad you\'re here. How are you doing?").\n'
    || E'\n'
    || E'## Declining gracefully\n'
    || E'When you have to decline a request, do it in one sentence that says what you cannot do and, in plain terms, why; then say what you can do instead, and keep going. Never repeat the same refusal sentence, never fall silent, and never leave them wondering whether the session is over. Declining a request is not declining the person.';
  cfg jsonb;
  k text;
  p text;
  newp text;
  written text[] := ARRAY[]::text[];
BEGIN
  SELECT config_value INTO cfg FROM system_config WHERE config_key = 'system_prompts' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'migration 124: no system_prompts row; nothing to do (sessions use the code default, which already has these sections)';
    RETURN;
  END IF;

  FOREACH k IN ARRAY ARRAY['realtime', 'chat'] LOOP
    p := cfg -> k ->> 'prompt';
    IF p IS NULL THEN
      RAISE NOTICE 'migration 124: no stored % prompt; nothing to do', k;
    ELSIF md5(p) = target_md5 THEN
      RAISE NOTICE 'migration 124: stored % prompt already has the 2026-09-22 sections; left unchanged', k;
    ELSIF md5(p) <> known_old_md5 THEN
      RAISE NOTICE 'migration 124: stored % prompt (md5 %) matches no known earlier version; LEFT ALONE. Add the sections by hand in Admin -> System Config.', k, md5(p);
    ELSE
      newp := replace(p, anchor, sections || anchor);
      IF md5(newp) <> target_md5 THEN
        -- Cannot happen for the known input; a bug here must not write anything.
        RAISE EXCEPTION 'migration 124: rewritten % prompt has md5 %, expected %', k, md5(newp), target_md5;
      END IF;
      cfg := jsonb_set(cfg, ARRAY[k, 'prompt'], to_jsonb(newp));
      written := written || k;
      RAISE NOTICE 'migration 124: added the 2026-09-22 sections to the stored % prompt', k;
    END IF;
  END LOOP;

  IF cardinality(written) > 0 THEN
    UPDATE system_config
    SET config_value = cfg,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = 'migration 124 (2026-09-22 prompt sections): ' || array_to_string(written, '+')
    WHERE config_key = 'system_prompts';
  END IF;
END $$;
