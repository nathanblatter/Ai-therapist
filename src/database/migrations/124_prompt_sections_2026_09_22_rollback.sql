-- Rollback 124: take the 2026-09-22 sections back out of the stored prompts.
--
-- Acts only on a row 124 itself last wrote (updated_by starts with
-- 'migration 124 '), only on the prompts named in that stamp, and only while
-- each still holds exactly the text 124 wrote (md5 below). Anything else (an
-- admin save since, a prompt 124 skipped, stage's hand-pasted copy) is left
-- alone with a NOTICE. Apply with psql so the NOTICEs are visible.
--
--   text written by 124  md5 d632ddf3b9c95a180d0d7f72c1c8cf19
--   restored text        md5 45f26eb2ee2614d562aee72973d32599

DO $$
DECLARE
  known_old_md5 constant text := '45f26eb2ee2614d562aee72973d32599';
  target_md5 constant text := 'd632ddf3b9c95a180d0d7f72c1c8cf19';
  stamp_prefix constant text := 'migration 124 (2026-09-22 prompt sections): ';
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
  who text;
  k text;
  p text;
  oldp text;
  reverted int := 0;
BEGIN
  SELECT config_value, updated_by INTO cfg, who FROM system_config WHERE config_key = 'system_prompts' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'rollback 124: no system_prompts row; nothing to do';
    RETURN;
  END IF;
  IF who IS NULL OR left(who, length(stamp_prefix)) <> stamp_prefix THEN
    RAISE NOTICE 'rollback 124: system_prompts was last written by "%", not migration 124; LEFT ALONE', coalesce(who, '(null)');
    RETURN;
  END IF;

  FOREACH k IN ARRAY string_to_array(substr(who, length(stamp_prefix) + 1), '+') LOOP
    p := cfg -> k ->> 'prompt';
    IF p IS NULL OR md5(p) <> target_md5 THEN
      RAISE NOTICE 'rollback 124: stored % prompt (md5 %) is not what migration 124 wrote; LEFT ALONE', k, coalesce(md5(p), '(none)');
      CONTINUE;
    END IF;
    oldp := replace(p, sections, '');
    IF md5(oldp) <> known_old_md5 THEN
      RAISE EXCEPTION 'rollback 124: restored % prompt has md5 %, expected %', k, md5(oldp), known_old_md5;
    END IF;
    cfg := jsonb_set(cfg, ARRAY[k, 'prompt'], to_jsonb(oldp));
    reverted := reverted + 1;
    RAISE NOTICE 'rollback 124: removed the 2026-09-22 sections from the stored % prompt', k;
  END LOOP;

  IF reverted > 0 THEN
    UPDATE system_config
    SET config_value = cfg,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = 'rollback 124'
    WHERE config_key = 'system_prompts';
  END IF;
END $$;
