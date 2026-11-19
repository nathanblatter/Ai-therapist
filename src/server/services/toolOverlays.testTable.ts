// The overlay table the tests hold every channel to (typed chat, GPT-Live,
// Grok): what the participant's screen does for each overlay tool, by how its
// call ended. Test-only; the policy itself is shared/toolOverlayPolicy.ts.
export type ExpectedOverlay = 'shown' | 'hidden' | 'unconfirmed';
export type OutcomeCase = 'success' | 'refused' | 'error' | 'timeout';

export const OUTCOME_CASES: OutcomeCase[] = ['success', 'refused', 'error', 'timeout'];

export const OVERLAY_ARGS: Record<string, Record<string, unknown>> = {
  show_resource_card: { resource_type: 'suicide' },
  start_thought_record: {},
  show_journaling_prompt: { prompt: 'What would you say?' },
  display_session_recap: { focus: 'sleep', takeaway: 'one step' },
  start_breathing_exercise: { duration_seconds: 60 },
  start_grounding_exercise: {},
  start_body_scan: { duration_seconds: 120 },
  start_values_sort: {},
  start_fear_ladder: {},
  administer_scale: { scale: 'phq2' },
  create_custom_worksheet: { template_id: 3, title: 'My plan', sections: [{ type: 'text', label: 'One' }] },
  create_safety_plan: { warning_signs: ['cannot sleep'], coping_strategies: ['walk'] },
};

const ON_SUCCESS: Record<OutcomeCase, ExpectedOverlay> = {
  success: 'shown',
  refused: 'hidden',
  error: 'hidden',
  timeout: 'hidden',
};

export const EXPECTED_OVERLAY: Record<string, Record<OutcomeCase, ExpectedOverlay>> = {
  show_resource_card: { success: 'shown', refused: 'shown', error: 'shown', timeout: 'shown' },
  start_thought_record: ON_SUCCESS,
  show_journaling_prompt: ON_SUCCESS,
  display_session_recap: ON_SUCCESS,
  start_breathing_exercise: ON_SUCCESS,
  start_grounding_exercise: ON_SUCCESS,
  start_body_scan: ON_SUCCESS,
  start_values_sort: ON_SUCCESS,
  start_fear_ladder: ON_SUCCESS,
  administer_scale: ON_SUCCESS,
  create_custom_worksheet: ON_SUCCESS,
  create_safety_plan: { success: 'shown', refused: 'hidden', error: 'unconfirmed', timeout: 'unconfirmed' },
};

/** The overlays the typed-chat client renders (PR #84); the rest are voice-only. */
export const CHAT_OVERLAY_TOOLS = [
  'show_resource_card',
  'start_thought_record',
  'show_journaling_prompt',
  'display_session_recap',
  'administer_scale',
  'create_custom_worksheet',
  'create_safety_plan',
];

/** What the registry's executeTool resolves with, for a handler success or a refusal. */
export const REGISTRY_RESULT: Record<'success' | 'refused', unknown> = {
  success: { success: true, guidance: "It is on the participant's screen." },
  // The handler returned an error envelope: validation, the scale cadence, or
  // the admin kill switch.
  refused: { error: 'scale_recently_administered', guidance: 'Continue without it.' },
};
