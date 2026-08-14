// Synthetic data for the magic-link demo admin dashboard. NONE of this touches
// the database or real participant data — it exists purely so a resume viewer
// can explore a realistic-looking clinician dashboard. Everything here is
// invented. See routes/demo.routes.ts for how it's served.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

interface DemoSession {
  session_id: string;
  session_name: string;
  user_id: number;
  username: string;
  status: 'active' | 'ended';
  session_type: 'realtime' | 'chat';
  voice: string;
  language: string;
  createdMsAgo: number;
  durationSeconds: number;
  crisis_flagged: boolean;
  crisis_severity: string | null;
  crisis_risk_score: number;
  ended_by: string | null;
  total_messages: number;
  user_messages: number;
  assistant_messages: number;
  transcript: { role: 'user' | 'assistant'; type: 'voice' | 'chat'; text: string }[];
}

// A small, believable roster of ended (and two active) demo sessions.
const SESSIONS: DemoSession[] = [
  {
    session_id: 'demo-sess-1001',
    session_name: 'Work stress and sleep',
    user_id: 9001,
    username: 'participant_042',
    status: 'active',
    session_type: 'realtime',
    voice: 'cedar',
    language: 'en',
    createdMsAgo: 6 * 60 * 1000,
    durationSeconds: 6 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 8,
    ended_by: null,
    total_messages: 14,
    user_messages: 7,
    assistant_messages: 7,
    transcript: [
      { role: 'assistant', type: 'voice', text: "Hi, I'm glad you're here. What's been on your mind lately?" },
      { role: 'user', type: 'voice', text: "Work has been really overwhelming and I haven't been sleeping." },
      { role: 'assistant', type: 'voice', text: 'That sounds exhausting — carrying that load all day and then not getting rest at night. What does a typical night look like right now?' },
      { role: 'user', type: 'voice', text: 'I lie awake replaying everything I did wrong that day.' },
      { role: 'assistant', type: 'voice', text: "Those late-night replays can be brutal. Would it help to try a short wind-down routine together, or would you rather talk through what's driving the worry first?" },
    ],
  },
  {
    session_id: 'demo-sess-1002',
    session_name: 'Feeling isolated after move',
    user_id: 9002,
    username: 'participant_017',
    status: 'active',
    session_type: 'realtime',
    voice: 'marin',
    language: 'en',
    createdMsAgo: 2 * 60 * 1000,
    durationSeconds: 2 * 60,
    crisis_flagged: true,
    crisis_severity: 'medium',
    crisis_risk_score: 58,
    ended_by: null,
    total_messages: 9,
    user_messages: 5,
    assistant_messages: 4,
    transcript: [
      { role: 'assistant', type: 'voice', text: "Hi there. How are you feeling today?" },
      { role: 'user', type: 'voice', text: "Honestly pretty low. I moved cities and I don't know anyone here." },
      { role: 'assistant', type: 'voice', text: "Starting over somewhere new can feel really lonely. How long has it been since the move?" },
      { role: 'user', type: 'voice', text: "Three months. Some days I don't see the point of any of it." },
      { role: 'assistant', type: 'voice', text: "I really appreciate you telling me that. When you say you don't see the point — can you say a bit more about what that feels like for you?" },
    ],
  },
  {
    session_id: 'demo-sess-1003',
    session_name: 'Exam anxiety check-in',
    user_id: 9003,
    username: 'participant_088',
    status: 'ended',
    session_type: 'chat',
    voice: 'cedar',
    language: 'en',
    createdMsAgo: 5 * HOUR,
    durationSeconds: 17 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 3,
    ended_by: 'user',
    total_messages: 22,
    user_messages: 11,
    assistant_messages: 11,
    transcript: [
      { role: 'assistant', type: 'chat', text: "Hello! What would you like to talk about today?" },
      { role: 'user', type: 'chat', text: "I have finals next week and I'm panicking." },
      { role: 'assistant', type: 'chat', text: "Finals pressure is so real. What part feels the most overwhelming right now — the amount to cover, or the fear of how it'll go?" },
      { role: 'user', type: 'chat', text: "The fear of failing, mostly." },
      { role: 'assistant', type: 'chat', text: "That fear makes it hard to even start. Want to try breaking the week into small, concrete blocks so it feels less like one giant threat?" },
    ],
  },
  {
    session_id: 'demo-sess-1004',
    session_name: 'Grief support',
    user_id: 9004,
    username: 'participant_005',
    status: 'ended',
    session_type: 'realtime',
    voice: 'marin',
    language: 'en',
    createdMsAgo: DAY + 2 * HOUR,
    durationSeconds: 24 * 60,
    crisis_flagged: true,
    crisis_severity: 'high',
    crisis_risk_score: 81,
    ended_by: 'user',
    total_messages: 31,
    user_messages: 15,
    assistant_messages: 16,
    transcript: [
      { role: 'assistant', type: 'voice', text: "I'm here with you. What's been the hardest part of today?" },
      { role: 'user', type: 'voice', text: "My mom passed last month and it's all hitting me at once." },
      { role: 'assistant', type: 'voice', text: "I'm so sorry. Losing your mom is an enormous loss. Grief coming in waves like that is really common, even when it feels like it should have settled by now." },
      { role: 'user', type: 'voice', text: "Sometimes I feel like I can't go on without her." },
      { role: 'assistant', type: 'voice', text: "That's a lot of pain to hold. I want to check in gently — when you say you can't go on, are you having any thoughts of harming yourself? If you are, you deserve real support right now, and I can share the 988 Suicide & Crisis Lifeline." },
    ],
  },
  {
    session_id: 'demo-sess-1005',
    session_name: 'Relationship conflict',
    user_id: 9005,
    username: 'participant_063',
    status: 'ended',
    session_type: 'chat',
    voice: 'cedar',
    language: 'es-419',
    createdMsAgo: DAY + 6 * HOUR,
    durationSeconds: 12 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 0,
    ended_by: 'user',
    total_messages: 16,
    user_messages: 8,
    assistant_messages: 8,
    transcript: [
      { role: 'assistant', type: 'chat', text: "Hola, me alegra que estés aquí. ¿De qué te gustaría hablar?" },
      { role: 'user', type: 'chat', text: "Discutí con mi pareja otra vez y me siento fatal." },
      { role: 'assistant', type: 'chat', text: "Lamento que estés pasando por esto. ¿Qué fue lo que desencadenó la discusión esta vez?" },
    ],
  },
  {
    session_id: 'demo-sess-1006',
    session_name: 'Burnout and motivation',
    user_id: 9006,
    username: 'participant_029',
    status: 'ended',
    session_type: 'realtime',
    voice: 'cedar',
    language: 'en',
    createdMsAgo: 2 * DAY + 3 * HOUR,
    durationSeconds: 19 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 12,
    ended_by: 'system',
    total_messages: 27,
    user_messages: 13,
    assistant_messages: 14,
    transcript: [
      { role: 'assistant', type: 'voice', text: "Hi, good to see you. Where would you like to start today?" },
      { role: 'user', type: 'voice', text: "I just feel burnt out. I can't get motivated to do anything." },
      { role: 'assistant', type: 'voice', text: "Burnout can drain the color out of everything. Has it been building for a while, or did something recent tip it over?" },
    ],
  },
];

function listRow(s: DemoSession) {
  const category = s.durationSeconds < 300 ? 'short' : s.durationSeconds < 1800 ? 'medium' : 'long';
  return {
    session_id: s.session_id,
    session_name: s.session_name,
    user_id: s.user_id,
    username: s.username,
    status: s.status,
    session_type: s.session_type,
    start_time: iso(s.createdMsAgo),
    end_time: s.status === 'ended' ? iso(s.createdMsAgo - s.durationSeconds * 1000) : null,
    ended_by: s.ended_by,
    crisis_flagged: s.crisis_flagged,
    crisis_severity: s.crisis_severity,
    voice: s.voice,
    language: s.language,
    duration_seconds: s.durationSeconds,
    duration_category: category,
    total_messages: s.total_messages,
    user_messages: s.user_messages,
    assistant_messages: s.assistant_messages,
    voice_messages: s.session_type === 'realtime' ? s.user_messages : 0,
    chat_messages: s.session_type === 'chat' ? s.user_messages : 0,
  };
}

function activeRow(s: DemoSession) {
  return {
    session_id: s.session_id,
    user_id: s.user_id,
    session_name: s.session_name,
    username: s.username,
    status: s.status,
    created_at: iso(s.createdMsAgo),
    crisis_flagged: s.crisis_flagged,
    crisis_severity: s.crisis_severity,
    crisis_risk_score: s.crisis_risk_score,
    crisis_flagged_at: s.crisis_flagged ? iso(s.createdMsAgo - 60 * 1000) : null,
    crisis_flagged_by: s.crisis_flagged ? 'system' : null,
    message_count: String(s.total_messages),
    last_activity: iso(Math.max(0, s.createdMsAgo - s.durationSeconds * 1000)),
    duration_seconds: s.durationSeconds,
  };
}

export function demoActiveSessions() {
  return { sessions: SESSIONS.filter(s => s.status === 'active').map(activeRow) };
}

export function demoSessionsList(limit = 50, page = 1) {
  const rows = SESSIONS.map(listRow);
  return { sessions: rows.slice(0, limit), pagination: { page, limit, totalCount: rows.length } };
}

export function demoSessionDetail(sessionId: string) {
  const s = SESSIONS.find(x => x.session_id === sessionId);
  if (!s) return null;
  const session = {
    session_id: s.session_id,
    user_id: s.user_id,
    username: s.username,
    session_name: s.session_name,
    status: s.status,
    session_type: s.session_type,
    created_at: iso(s.createdMsAgo),
    updated_at: iso(Math.max(0, s.createdMsAgo - s.durationSeconds * 1000)),
    ended_at: s.status === 'ended' ? iso(s.createdMsAgo - s.durationSeconds * 1000) : null,
    ended_by: s.ended_by,
    crisis_flagged: s.crisis_flagged,
    crisis_severity: s.crisis_severity,
    crisis_risk_score: s.crisis_risk_score,
    is_demo: true,
  };
  const perStep = s.durationSeconds * 1000 / (s.transcript.length + 1);
  const messages = s.transcript.map((m, i) => ({
    message_id: `${s.session_id}-msg-${i}`,
    session_id: s.session_id,
    role: m.role,
    message_type: m.type,
    message: m.text,
    extras: null,
    created_at: iso(s.createdMsAgo - i * perStep),
  }));
  return { session, messages };
}

export function demoAnalytics() {
  const total = SESSIONS.length;
  return {
    metrics: {
      total_sessions: 128,
      avg_messages_per_session: 21.4,
      avg_duration_seconds: 936,
    },
    breakdown: {
      voice_messages: 1342,
      chat_messages: 618,
      user_messages: 980,
      assistant_messages: 1004,
    },
    daily_trend: Array.from({ length: 14 }, (_, i) => ({
      date: new Date(now - (13 - i) * DAY).toISOString().slice(0, 10),
      session_count: [4, 6, 5, 9, 7, 8, 11, 10, 6, 12, 9, 13, 8, 10][i],
    })),
    user_sessions: SESSIONS.map(s => ({ userid: s.user_id, username: s.username, session_count: Math.ceil(Math.random() * 4) + 1 })),
    time_distribution: [
      { time_period: 'Morning', session_count: 34 },
      { time_period: 'Afternoon', session_count: 41 },
      { time_period: 'Evening', session_count: 39 },
      { time_period: 'Night', session_count: 14 },
    ],
    duration_distribution: [
      { duration_category: 'short', session_count: 38 },
      { duration_category: 'medium', session_count: 62 },
      { duration_category: 'long', session_count: 28 },
    ],
    duration_trend: Array.from({ length: 14 }, (_, i) => ({
      date: new Date(now - (13 - i) * DAY).toISOString().slice(0, 10),
      avg_duration_seconds: 720 + Math.round(Math.sin(i) * 180) + i * 8,
    })),
    language_distribution: [
      { language: 'en', session_count: 101, percentage: 78.9 },
      { language: 'es-419', session_count: 19, percentage: 14.8 },
      { language: 'fr-FR', session_count: 8, percentage: 6.3 },
    ],
    voice_distribution: [
      { voice: 'cedar', session_count: 74, percentage: 57.8 },
      { voice: 'marin', session_count: 39, percentage: 30.5 },
      { voice: 'coral', session_count: 15, percentage: 11.7 },
    ],
    completion_patterns: [
      { ended_by: 'user', session_count: 96, percentage: 75.0 },
      { ended_by: 'system', session_count: 24, percentage: 18.8 },
      { ended_by: 'admin', session_count: 8, percentage: 6.2 },
    ],
    abandonment_stats: {
      abandonment_rate_percentage: 12.5,
      abandoned_sessions: 16,
      completed_sessions: 112,
    },
    session_depth: [
      { user_type: 'Returning', avg_messages: 26.8, session_count: 71 },
      { user_type: 'First-time', avg_messages: 15.1, session_count: 57 },
    ],
    engagement_pace: { avg_messages_per_minute: 1.9 },
    response_times: {
      measured_turns: 214,
      p50_ttfa_ms: 940,
      p95_ttfa_ms: 2350,
      p50_total_ms: 6400,
      p95_total_ms: 14800,
    },
    turn_taking: {
      user_to_assistant_ratio: 0.98,
      total_user_messages: 980,
      total_assistant_messages: 1004,
    },
    sideband_reliability: {
      realtime_sessions: 42,
      attached_sessions: 40,
      error_sessions: 2,
      attach_success_rate: 95.2,
    },
    _demo_total_local: total,
  };
}

export function demoCrisisAll() {
  const flagged = SESSIONS.filter(s => s.crisis_flagged);
  return {
    crisisEvents: flagged.map((s, i) => ({
      event_id: `demo-crisis-${i}`,
      session_id: s.session_id,
      username: s.username,
      event_type: s.crisis_severity === 'high' ? 'emergency_alert' : 'auto_flag',
      severity: s.crisis_severity,
      risk_score: s.crisis_risk_score,
      triggered_by: 'system',
      trigger_method: 'auto',
      created_at: iso(s.createdMsAgo - 60 * 1000),
    })),
    clinicalReviews: [],
    humanHandoffs: [],
    interventionActions: flagged.map((s, i) => ({
      action_id: `demo-action-${i}`,
      session_id: s.session_id,
      action_type: 'auto_flag',
      performed_by: 'system',
      performed_at: iso(s.createdMsAgo - 55 * 1000),
    })),
    riskScoreHistory: flagged.map((s, i) => ({
      history_id: `demo-risk-${i}`,
      session_id: s.session_id,
      risk_score: s.crisis_risk_score,
      severity: s.crisis_severity,
      calculated_at: iso(s.createdMsAgo - 58 * 1000),
    })),
  };
}

export function demoRateLimitedUsers() {
  return {
    rateLimitedUsers: [
      {
        userid: 9007,
        username: 'participant_051',
        role: 'participant',
        sessions_used_today: 3,
        session_limit: 3,
        limit_resets_at: new Date(now + 9 * HOUR).toISOString(),
        hours_until_reset: 9,
        last_session_at: iso(40 * 60 * 1000),
      },
      {
        userid: 9008,
        username: 'participant_012',
        role: 'participant',
        sessions_used_today: 3,
        session_limit: 3,
        limit_resets_at: new Date(now + 9 * HOUR).toISOString(),
        hours_until_reset: 9,
        last_session_at: iso(2 * HOUR),
      },
    ],
    config: { enabled: true, max_sessions_per_day: 3 },
  };
}

// Synthetic research export payload (de-identified, invented).
export function demoExport() {
  return SESSIONS.map(s => ({
    session_id: s.session_id,
    username: s.username,
    status: s.status,
    session_type: s.session_type,
    language: s.language,
    voice: s.voice,
    duration_seconds: s.durationSeconds,
    total_messages: s.total_messages,
    crisis_flagged: s.crisis_flagged,
    crisis_severity: s.crisis_severity,
    started_at: iso(s.createdMsAgo),
  }));
}

// ---- Dashboard sub-panel fixtures (ai-therapist-114) ----
// The Analytics view fetches four additional endpoints (tools/cost/pairwise/
// evals) plus the calibration panel; without these the demo catch-all's `{}`
// crashed the whole Dashboard tab to a white screen.

export function demoToolAnalytics() {
  const tools = [
    ['start_breathing_exercise', 34, 28], ['show_resource_card', 22, 19],
    ['log_mood', 41, 30], ['get_coping_strategies', 18, 15],
    ['start_grounding_exercise', 12, 11], ['display_session_recap', 26, 26],
    ['administer_scale', 9, 9], ['create_safety_plan', 4, 4],
  ] as const;
  return {
    tool_stats: tools.map(([tool_name, invocations, sessions]) => ({
      tool_name, invocations, sessions,
      last_used: iso(2 * HOUR),
      failures: 0, failure_rate: 0,
    })),
    distinct_tools_per_session: [
      { distinct_tool_count: 0, session_count: 6 },
      { distinct_tool_count: 1, session_count: 9 },
      { distinct_tool_count: 2, session_count: 12 },
      { distinct_tool_count: 3, session_count: 7 },
      { distinct_tool_count: 4, session_count: 3 },
    ],
    dead_tools: ['start_fear_ladder', 'switch_language'],
    registered_tool_count: tools.length + 2,
    sessions_with_tool_use: 31,
    total_sessions: 37,
  };
}

export function demoCostAnalytics() {
  return {
    totals: {
      total_calls: 412,
      total_tokens_in: 1_284_000,
      total_tokens_out: 96_500,
      total_estimated_cost_usd: 4.87,
      total_realtime_minutes: 186,
      total_realtime_responses: 638,
      total_realtime_cost_usd: 21.43,
    },
    daily_spend: Array.from({ length: 14 }, (_, i) => ({
      date: iso(i * 24 * HOUR).slice(0, 10),
      calls: 18 + ((i * 7) % 22),
      tokens_in: 60_000 + ((i * 13_337) % 45_000),
      tokens_out: 4_200 + ((i * 911) % 3_800),
      estimated_cost_usd: 0.18 + ((i * 7) % 22) * 0.011,
      realtime_cost_usd: 0.9 + ((i * 11) % 17) * 0.045,
    })),
    feedback: { responses: 21, avg_helpfulness: 4.3, avg_ease: 4.6, avg_would_return: 4.1 },
  };
}

export function demoPairwiseAnalytics() {
  return {
    prompt_version: 'pw-v1',
    comparisons: [
      {
        comparison_axis: 'proactive_offering', arm_x: 'on', arm_y: 'off',
        wins_x: 14, wins_y: 9, ties: 5, inconsistent: 2, total: 30,
        win_rate_x: 0.609, ci_lo: 0.408, ci_hi: 0.778, significant: false,
      },
      {
        comparison_axis: 'ai_model', arm_x: 'gpt-realtime', arm_y: 'gpt-realtime-mini',
        wins_x: 19, wins_y: 6, ties: 3, inconsistent: 2, total: 30,
        win_rate_x: 0.76, ci_lo: 0.566, ci_hi: 0.885, significant: true,
      },
    ],
  };
}

export function demoEvalTrend() {
  const dims = ['safety_protocol', 'empathy', 'modality_fidelity', 'disclaimer_compliance'];
  const trend = [] as Array<Record<string, unknown>>;
  for (let w = 7; w >= 0; w--) {
    for (const dimension of dims) {
      trend.push({
        week: iso(w * 7 * 24 * HOUR).slice(0, 10),
        ai_model: 'gpt-realtime',
        prompt_version: 'v3',
        dimension,
        mean_score: Math.round((4.1 + Math.sin(w + dims.indexOf(dimension)) * 0.35) * 100) / 100,
        n: 12 + ((w * 3) % 9),
      });
    }
  }
  return { trend, open_alerts: [] };
}

export function demoCalibration() {
  const dims = [
    ['safety_protocol', 0.74], ['empathy', 0.66], ['modality_fidelity', 0.61],
    ['disclaimer_compliance', 0.81], ['non_directiveness', 0.58], ['clinical_claims', 0.7],
  ] as const;
  return {
    report: {
      prompt_version: 'v3',
      rubric_version: 'r2',
      pair_count: 132,
      session_count: 22,
      dimensions: dims.map(([dimension, kappa]) => ({
        dimension, n: 22, kappa,
        human_mean: 4.2, llm_mean: 4.05, mean_bias: -0.15, exact_agreement_pct: 68,
      })),
      overall_kappa: 0.68,
    },
    available_prompt_versions: ['v3', 'v2'],
  };
}
