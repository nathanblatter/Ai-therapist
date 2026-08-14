// Synthetic data for the magic-link demo admin dashboard. NONE of this touches
// the database or real participant data — it exists purely so a prospect (a
// therapist evaluating the product, or a resume viewer) can explore a
// realistic-looking clinician dashboard. Everything here is invented.
// See routes/demo.routes.ts for how it's served.
//
// Narrative (pass-4 "sell to therapists"): the demo viewer is a solo therapist
// (dr_demo) supervising a small caseload of four pseudonymous clients through
// one week of between-session practice:
//   - Client A (client_a, 9001): anxiety, 6 sessions in. Completed thought-record
//     worksheets and shows an improving PHQ-2/GAD-2 trend.
//   - Client B (client_b, 9002): depression after a loss. Had a crisis alert
//     mid-week that was caught, escalated, and resolved — the intervention
//     timeline is visible end to end (risk history, crisis events, safety plan,
//     clinician note, follow-up session, IRB adverse-event report).
//   - Client C (client_c, 9003): burnout. Longest continuity — their profile
//     shows "what the AI remembers" (case profile, memories, summaries).
//   - Client D (client_d, 9004): brand new, mid first session right now.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

// ---- Caseload roster ----

interface DemoClient {
  userid: number;
  username: string;
  role: string;
  created_at: string;
  preferred_voice: string | null;
  preferred_language: string | null;
  mfa_enabled: boolean;
  memory_enabled: boolean;
  risk_context_share_enabled: boolean;
  session_count: number;
}

const CLIENTS: DemoClient[] = [
  {
    userid: 9001, username: 'client_a', role: 'participant',
    created_at: iso(42 * DAY), preferred_voice: 'cedar', preferred_language: 'en',
    mfa_enabled: false, memory_enabled: true, risk_context_share_enabled: false,
    session_count: 6,
  },
  {
    userid: 9002, username: 'client_b', role: 'participant',
    created_at: iso(28 * DAY), preferred_voice: 'marin', preferred_language: 'en',
    mfa_enabled: false, memory_enabled: true, risk_context_share_enabled: true,
    session_count: 4,
  },
  {
    userid: 9003, username: 'client_c', role: 'participant',
    created_at: iso(63 * DAY), preferred_voice: 'cedar', preferred_language: 'en',
    mfa_enabled: false, memory_enabled: true, risk_context_share_enabled: false,
    session_count: 8,
  },
  {
    userid: 9004, username: 'client_d', role: 'participant',
    created_at: iso(2 * HOUR), preferred_voice: 'marin', preferred_language: 'en',
    mfa_enabled: false, memory_enabled: true, risk_context_share_enabled: false,
    session_count: 1,
  },
];

const THERAPIST = {
  userid: 9100, username: 'dr_demo', role: 'therapist',
  created_at: iso(90 * DAY), preferred_voice: null, preferred_language: 'en',
  mfa_enabled: true, memory_enabled: false, risk_context_share_enabled: false,
};

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
  eval_score: number | null;
  feedback_rating: number | null;
  transcript: { role: 'user' | 'assistant'; type: 'voice' | 'chat'; text: string }[];
}

// One believable week of caseload activity, newest first.
const SESSIONS: DemoSession[] = [
  {
    // Client D: brand new, mid first session right now.
    session_id: 'demo-sess-2001',
    session_name: 'First session — intake and goals',
    user_id: 9004,
    username: 'client_d',
    status: 'active',
    session_type: 'realtime',
    voice: 'marin',
    language: 'en',
    createdMsAgo: 5 * 60 * 1000,
    durationSeconds: 5 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 4,
    ended_by: null,
    total_messages: 10,
    user_messages: 5,
    assistant_messages: 5,
    eval_score: null,
    feedback_rating: null,
    transcript: [
      { role: 'assistant', type: 'voice', text: "Hi, welcome. Your therapist set this up so you have a place to practice between your sessions with them. Nothing here replaces those sessions. What brings you in today?" },
      { role: 'user', type: 'voice', text: "My therapist suggested I try this. I've been having a hard time since my divorce." },
      { role: 'assistant', type: 'voice', text: "I'm glad you gave it a try, and I'm sorry — that's a big life change to carry. Would it help to start with what a typical week looks like for you right now?" },
      { role: 'user', type: 'voice', text: "Mostly work, then home alone. The evenings are the worst part." },
      { role: 'assistant', type: 'voice', text: "Evenings can feel very long when the house suddenly goes quiet. Let's note that as something to bring to your therapist too. For now, want to sketch one small evening routine we could try this week?" },
    ],
  },
  {
    // Client A: worksheet check-in, the "homework actually happened" story.
    session_id: 'demo-sess-2002',
    session_name: 'Thought-record review',
    user_id: 9001,
    username: 'client_a',
    status: 'ended',
    session_type: 'chat',
    voice: 'cedar',
    language: 'en',
    createdMsAgo: 3 * HOUR,
    durationSeconds: 14 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 2,
    ended_by: 'user',
    total_messages: 20,
    user_messages: 10,
    assistant_messages: 10,
    eval_score: 4.6,
    feedback_rating: 5,
    transcript: [
      { role: 'assistant', type: 'chat', text: "Welcome back. Last time you started a thought record about the team meeting. Did you get a chance to finish it?" },
      { role: 'user', type: 'chat', text: "I did. The hot thought was 'everyone thinks I'm incompetent'. I rated it 90 percent." },
      { role: 'assistant', type: 'chat', text: "Nice work getting it on paper. What evidence did you find for and against that thought?" },
      { role: 'user', type: 'chat', text: "For: I stumbled during the demo. Against: my manager asked me to lead the next one, and two people said it was useful." },
      { role: 'assistant', type: 'chat', text: "That's a strong 'against' column. When you re-rated the thought after writing the balanced alternative, where did it land?" },
      { role: 'user', type: 'chat', text: "Around 40. Still there, but it doesn't spiral the same way." },
      { role: 'assistant', type: 'chat', text: "From 90 to 40 is real movement. Bring this record to your session with your therapist this week — it's exactly the kind of thing worth reviewing together." },
    ],
  },
  {
    // Client B: the morning-after follow-up. The resolution half of the arc.
    session_id: 'demo-sess-2004',
    session_name: 'Morning follow-up after alert',
    user_id: 9002,
    username: 'client_b',
    status: 'ended',
    session_type: 'realtime',
    voice: 'marin',
    language: 'en',
    createdMsAgo: 20 * HOUR,
    durationSeconds: 16 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 18,
    ended_by: 'user',
    total_messages: 24,
    user_messages: 12,
    assistant_messages: 12,
    eval_score: 4.4,
    feedback_rating: 4,
    transcript: [
      { role: 'assistant', type: 'voice', text: "Good morning. I wanted to check in after last night. How are you feeling today?" },
      { role: 'user', type: 'voice', text: "Better. Heavier than I'd like, but not like last night. I talked to my sister like we planned." },
      { role: 'assistant', type: 'voice', text: "I'm really glad you reached out to her — that was the first step on your safety plan and you did it. Your therapist has also been notified and will follow up with you today." },
      { role: 'user', type: 'voice', text: "Yeah, she already messaged me this morning." },
      { role: 'assistant', type: 'voice', text: "Good. For today, let's keep it small: the plan says a short walk before noon and calling your sister again in the evening. Does that still feel doable?" },
    ],
  },
  {
    // Client B: the crisis session. Flagged, escalated, wound down safely.
    session_id: 'demo-sess-2003',
    session_name: 'Evening check-in',
    user_id: 9002,
    username: 'client_b',
    status: 'ended',
    session_type: 'realtime',
    voice: 'marin',
    language: 'en',
    createdMsAgo: DAY + 10 * HOUR,
    durationSeconds: 21 * 60,
    crisis_flagged: true,
    crisis_severity: 'high',
    crisis_risk_score: 82,
    ended_by: 'user',
    total_messages: 30,
    user_messages: 15,
    assistant_messages: 15,
    eval_score: 4.8,
    feedback_rating: null,
    transcript: [
      { role: 'assistant', type: 'voice', text: "Hi, I'm here with you. How has your evening been?" },
      { role: 'user', type: 'voice', text: "Bad. The anniversary is this weekend and it's all I can think about." },
      { role: 'assistant', type: 'voice', text: "Anniversaries can pull all of the grief back to the surface at once. What's been the hardest thought tonight?" },
      { role: 'user', type: 'voice', text: "That it should have been me. Some nights I think everyone would be better off." },
      { role: 'assistant', type: 'voice', text: "Thank you for trusting me with that — it matters. I need to ask directly: are you having thoughts of ending your life, or of hurting yourself tonight?" },
      { role: 'user', type: 'voice', text: "Thoughts, yes. I wouldn't do anything. But the thoughts are loud." },
      { role: 'assistant', type: 'voice', text: "I hear you, and I've let your therapist know so they can follow up with you. Right now, let's use your safety plan together. Step one was calling your sister — is she reachable tonight? And if things get worse, the 988 Suicide & Crisis Lifeline is there any hour: call or text 988." },
      { role: 'user', type: 'voice', text: "I can call her. Can we do the breathing thing first?" },
      { role: 'assistant', type: 'voice', text: "Of course. Let's do it together — in for four, hold for four, out for six. I'll count with you." },
    ],
  },
  {
    // Client C: continuity — the AI picks up threads from prior weeks.
    session_id: 'demo-sess-2005',
    session_name: 'Boundaries at work — week 4',
    user_id: 9003,
    username: 'client_c',
    status: 'ended',
    session_type: 'realtime',
    voice: 'cedar',
    language: 'en',
    createdMsAgo: 2 * DAY + 4 * HOUR,
    durationSeconds: 23 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 6,
    ended_by: 'user',
    total_messages: 28,
    user_messages: 14,
    assistant_messages: 14,
    eval_score: 4.5,
    feedback_rating: 5,
    transcript: [
      { role: 'assistant', type: 'voice', text: "Good to hear from you. Last week you were going to try leaving the office by six on Tuesday and Thursday, and you mentioned your sister's visit was coming up. How did it go?" },
      { role: 'user', type: 'voice', text: "I actually left on time both days. Thursday I almost stayed, but I remembered what we said about the first ten minutes being the hardest." },
      { role: 'assistant', type: 'voice', text: "That's two for two, and you used the exact skill we practiced. Did the evenings feel any different?" },
      { role: 'user', type: 'voice', text: "Tuesday I cooked for the first time in weeks. It sounds small but it felt like being a person again." },
      { role: 'assistant', type: 'voice', text: "It doesn't sound small at all — cooking was on your list of things that used to recharge you. Want to keep the same two days this week, or stretch to a third?" },
    ],
  },
  {
    // Client A: the earlier anxiety check-in with a PHQ-2/GAD-2 screener.
    session_id: 'demo-sess-2006',
    session_name: 'Anxiety check-in and screener',
    user_id: 9001,
    username: 'client_a',
    status: 'ended',
    session_type: 'realtime',
    voice: 'cedar',
    language: 'en',
    createdMsAgo: 5 * DAY + 2 * HOUR,
    durationSeconds: 18 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 5,
    ended_by: 'user',
    total_messages: 26,
    user_messages: 13,
    assistant_messages: 13,
    eval_score: 4.3,
    feedback_rating: 4,
    transcript: [
      { role: 'assistant', type: 'voice', text: "Welcome back. It's been about a week — how has the presentation anxiety been since we last talked?" },
      { role: 'user', type: 'voice', text: "Up and down. I used the breathing before Monday's standup and it helped." },
      { role: 'assistant', type: 'voice', text: "Glad it's earning its keep. It's also time for our quick two-question check-in, if that's alright — the one your therapist reviews." },
      { role: 'user', type: 'voice', text: "Sure, go ahead." },
      { role: 'assistant', type: 'voice', text: "Over the last two weeks, how often have you been bothered by feeling nervous, anxious, or on edge — not at all, several days, more than half the days, or nearly every day?" },
    ],
  },
  {
    // Client C: the week-3 session referenced by the case profile.
    session_id: 'demo-sess-2007',
    session_name: 'Values and energy audit',
    user_id: 9003,
    username: 'client_c',
    status: 'ended',
    session_type: 'chat',
    voice: 'cedar',
    language: 'en',
    createdMsAgo: 6 * DAY + 5 * HOUR,
    durationSeconds: 15 * 60,
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: 0,
    ended_by: 'user',
    total_messages: 18,
    user_messages: 9,
    assistant_messages: 9,
    eval_score: 4.2,
    feedback_rating: 4,
    transcript: [
      { role: 'assistant', type: 'chat', text: "Last time we mapped where your energy goes in a week. Today you wanted to line that up against what actually matters to you. Ready?" },
      { role: 'user', type: 'chat', text: "Ready. Spoiler: the two lists don't match." },
      { role: 'assistant', type: 'chat', text: "That mismatch is exactly what burnout tends to look like on paper. Which value felt most starved this week?" },
      { role: 'user', type: 'chat', text: "Connection. I keep cancelling on people because I'm too drained." },
      { role: 'assistant', type: 'chat', text: "Let's make that concrete for your therapist session: one cancelled plan you'd like to un-cancel, and what would need to be true to keep it." },
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

// Per-session stage-2 risk history: only the crisis session has a real
// escalation arc; everything else is quiet.
export function demoRiskHistory(sessionId: string) {
  if (sessionId !== 'demo-sess-2003') return { history: [] };
  const base = DAY + 10 * HOUR; // session start
  return {
    history: [
      {
        history_id: 'demo-risk-2003-1',
        session_id: sessionId,
        risk_score: 12,
        severity: null,
        score_factors: { method: 'keyword+llm', keywords: [], llm_context: 'grief_anniversary', llm_reasoning: 'Grief-focused distress around an upcoming anniversary; no ideation language yet.' },
        calculated_at: iso(base - 4 * 60 * 1000),
      },
      {
        history_id: 'demo-risk-2003-2',
        session_id: sessionId,
        risk_score: 46,
        severity: 'medium',
        score_factors: { method: 'keyword+llm', keywords: ['better off'], llm_context: 'passive_ideation', llm_reasoning: 'Passive ideation markers ("should have been me", "everyone would be better off"). Escalating trajectory.', trajectory_trend: 'rising' },
        calculated_at: iso(base - 7 * 60 * 1000),
      },
      {
        history_id: 'demo-risk-2003-3',
        session_id: sessionId,
        risk_score: 82,
        severity: 'high',
        score_factors: { method: 'keyword+llm', keywords: ['ending my life'], llm_context: 'active_ideation_no_plan', llm_reasoning: 'Client confirms suicidal thoughts on direct inquiry; denies intent or plan. High severity, protocol requires escalation and safety-plan activation.', trajectory_trend: 'rising' },
        calculated_at: iso(base - 9 * 60 * 1000),
      },
      {
        history_id: 'demo-risk-2003-4',
        session_id: sessionId,
        risk_score: 38,
        severity: 'medium',
        score_factors: { method: 'keyword+llm', keywords: [], llm_context: 'de_escalating', llm_reasoning: 'Client engaged with safety plan (agreed to call sister, completed grounding exercise). Distress decreasing.', trajectory_trend: 'falling' },
        calculated_at: iso(base - 16 * 60 * 1000),
      },
    ],
  };
}

export function demoAnalytics() {
  const total = SESSIONS.length;
  return {
    metrics: {
      total_sessions: 19,
      avg_messages_per_session: 22.8,
      avg_duration_seconds: 1032,
    },
    breakdown: {
      voice_messages: 248,
      chat_messages: 118,
      user_messages: 181,
      assistant_messages: 185,
    },
    daily_trend: Array.from({ length: 14 }, (_, i) => ({
      date: new Date(now - (13 - i) * DAY).toISOString().slice(0, 10),
      session_count: [1, 2, 1, 2, 1, 3, 2, 1, 2, 2, 1, 3, 2, 2][i],
    })),
    user_sessions: CLIENTS.map(c => ({ userid: c.userid, username: c.username, session_count: c.session_count })),
    time_distribution: [
      { time_period: 'Morning', session_count: 4 },
      { time_period: 'Afternoon', session_count: 5 },
      { time_period: 'Evening', session_count: 8 },
      { time_period: 'Night', session_count: 2 },
    ],
    duration_distribution: [
      { duration_category: 'short', session_count: 3 },
      { duration_category: 'medium', session_count: 12 },
      { duration_category: 'long', session_count: 4 },
    ],
    duration_trend: Array.from({ length: 14 }, (_, i) => ({
      date: new Date(now - (13 - i) * DAY).toISOString().slice(0, 10),
      avg_duration_seconds: 840 + Math.round(Math.sin(i) * 160) + i * 10,
    })),
    language_distribution: [
      { language: 'en', session_count: 19, percentage: 100 },
    ],
    voice_distribution: [
      { voice: 'cedar', session_count: 11, percentage: 57.9 },
      { voice: 'marin', session_count: 8, percentage: 42.1 },
    ],
    completion_patterns: [
      { ended_by: 'user', session_count: 16, percentage: 84.2 },
      { ended_by: 'system', session_count: 3, percentage: 15.8 },
    ],
    abandonment_stats: {
      abandonment_rate_percentage: 5.3,
      abandoned_sessions: 1,
      completed_sessions: 18,
    },
    session_depth: [
      { user_type: 'Returning', avg_messages: 25.4, session_count: 15 },
      { user_type: 'First-time', avg_messages: 13.2, session_count: 4 },
    ],
    engagement_pace: { avg_messages_per_minute: 1.7 },
    response_times: {
      measured_turns: 214,
      p50_ttfa_ms: 940,
      p95_ttfa_ms: 2350,
      p50_total_ms: 6400,
      p95_total_ms: 14800,
    },
    turn_taking: {
      user_to_assistant_ratio: 0.98,
      total_user_messages: 181,
      total_assistant_messages: 185,
    },
    sideband_reliability: {
      realtime_sessions: 13,
      attached_sessions: 13,
      error_sessions: 0,
      attach_success_rate: 100,
    },
    _demo_total_local: total,
  };
}

// Crisis center: Client B's alert, caught and resolved, told as a timeline.
export function demoCrisisAll() {
  const crisisStart = DAY + 10 * HOUR;
  return {
    crisisEvents: [
      {
        event_id: 'demo-crisis-1',
        session_id: 'demo-sess-2003',
        username: 'client_b',
        event_type: 'emergency_alert',
        severity: 'high',
        risk_score: 82,
        triggered_by: 'system',
        trigger_method: 'auto',
        created_at: iso(crisisStart - 9 * 60 * 1000),
        notes: 'Active ideation without plan disclosed on direct inquiry. Safety protocol engaged in-session.',
      },
    ],
    clinicalReviews: [
      {
        review_id: 'demo-review-1',
        session_id: 'demo-sess-2003',
        review_type: 'crisis_followup',
        review_reason: 'High-severity auto flag: active ideation without plan',
        status: 'completed',
        risk_score: 82,
        requested_at: iso(crisisStart - 10 * 60 * 1000),
        assigned_to: 'dr_demo',
      },
    ],
    humanHandoffs: [],
    interventionActions: [
      {
        action_id: 'demo-action-1',
        session_id: 'demo-sess-2003',
        action_type: 'auto_flag',
        risk_score: 82,
        performed_by: 'system',
        performed_at: iso(crisisStart - 9 * 60 * 1000),
        outcome: 'Session flagged high severity; therapist notification sent',
      },
      {
        action_id: 'demo-action-2',
        session_id: 'demo-sess-2003',
        action_type: 'therapist_notified',
        performed_by: 'system',
        performed_at: iso(crisisStart - 9 * 60 * 1000 + 20 * 1000),
        outcome: 'dr_demo alerted (dashboard + notification)',
      },
      {
        action_id: 'demo-action-3',
        session_id: 'demo-sess-2003',
        action_type: 'safety_plan_activated',
        performed_by: 'system',
        performed_at: iso(crisisStart - 11 * 60 * 1000),
        outcome: 'Safety plan reviewed in-session; client agreed to contact support person and completed grounding exercise',
      },
      {
        action_id: 'demo-action-4',
        session_id: 'demo-sess-2003',
        action_type: 'clinical_review',
        performed_by: 'dr_demo',
        performed_at: iso(crisisStart - 12 * HOUR),
        outcome: 'Reviewed transcript same evening; messaged client next morning; follow-up session completed; flag resolved',
      },
    ],
    riskScoreHistory: demoRiskHistory('demo-sess-2003').history.map(h => ({
      history_id: h.history_id,
      session_id: h.session_id,
      risk_score: h.risk_score,
      severity: h.severity,
      calculated_at: h.calculated_at,
      score_factors: h.score_factors,
    })),
  };
}

export function demoRateLimitedUsers() {
  return {
    rateLimitedUsers: [
      {
        userid: 9001,
        username: 'client_a',
        role: 'participant',
        sessions_used_today: 3,
        session_limit: 3,
        limit_resets_at: new Date(now + 9 * HOUR).toISOString(),
        hours_until_reset: 9,
        last_session_at: iso(3 * HOUR),
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

// ---- Users / caseload ----

export function demoUsers() {
  return {
    users: [
      ...CLIENTS.map(c => ({
        userid: c.userid,
        username: c.username,
        role: c.role,
        created_at: c.created_at,
        preferred_voice: c.preferred_voice,
        preferred_language: c.preferred_language,
        mfa_enabled: c.mfa_enabled,
        memory_enabled: c.memory_enabled,
        risk_context_share_enabled: c.risk_context_share_enabled,
      })),
      { ...THERAPIST },
    ],
  };
}

export function demoUserById(userId: number) {
  const c = CLIENTS.find(x => x.userid === userId);
  if (c) return { user: { userid: c.userid, username: c.username, role: c.role } };
  if (userId === THERAPIST.userid) return { user: { userid: THERAPIST.userid, username: THERAPIST.username, role: THERAPIST.role } };
  return null;
}

// ---- Participant profile bundles ("what the AI remembers") ----

function emptyBundle(c: DemoClient) {
  return {
    user: {
      userid: c.userid,
      username: c.username,
      role: c.role,
      preferred_voice: c.preferred_voice,
      preferred_language: c.preferred_language,
      mfa_enabled: c.mfa_enabled,
      created_at: c.created_at,
    },
    memory_enabled: c.memory_enabled,
    risk_context_share_enabled: c.risk_context_share_enabled,
    summaries: [] as unknown[],
    ended_session_count: 0,
    memories: [] as unknown[],
    case_profile: null as unknown,
    scale_history: [] as unknown[],
    mood_trajectory: [] as unknown[],
    safety_plan: null as unknown,
    thought_record: null as unknown,
    clinician_note: null as unknown,
    prior_crisis_flags: [] as unknown[],
  };
}

export function demoUserProfile(userId: number) {
  const c = CLIENTS.find(x => x.userid === userId);
  if (!c) return null;
  const bundle = emptyBundle(c);

  if (userId === 9001) {
    // Client A: worksheets done, screeners improving.
    bundle.ended_session_count = 6;
    bundle.summaries = [
      {
        session_id: 'demo-sess-2002',
        session_name: 'Thought-record review',
        ended_at: iso(3 * HOUR - 14 * 60 * 1000),
        created_at: iso(3 * HOUR - 14 * 60 * 1000),
        summary: {
          headline: 'Completed thought record; hot-thought belief dropped from 90 to 40',
          topics: ['work anxiety', 'thought record', 'presentation fear'],
          mood_trajectory: 'improving',
          techniques_helped: ['thought record', 'evidence weighing'],
          follow_up: 'Bring the completed record to the next therapist session.',
        },
      },
      {
        session_id: 'demo-sess-2006',
        session_name: 'Anxiety check-in and screener',
        ended_at: iso(5 * DAY + 2 * HOUR - 18 * 60 * 1000),
        created_at: iso(5 * DAY + 2 * HOUR - 18 * 60 * 1000),
        summary: {
          headline: 'Used paced breathing before standup; PHQ-2/GAD-2 administered',
          topics: ['anxiety', 'breathing practice', 'screeners'],
          mood_trajectory: 'stable',
          techniques_helped: ['paced breathing'],
          follow_up: 'Start a thought record about the team meeting.',
        },
      },
    ];
    bundle.memories = [
      { fact: 'Big product presentation is on the 22nd; wants to practice beforehand', session_id: 'demo-sess-2006', created_at: iso(5 * DAY) },
      { fact: 'Paced breathing before meetings has been the most helpful skill so far', session_id: 'demo-sess-2006', created_at: iso(5 * DAY) },
    ];
    bundle.case_profile = {
      updated_at: iso(3 * HOUR),
      profile: {
        presenting_concerns: ['generalized anxiety', 'performance anxiety at work'],
        recurring_themes: ['fear of being seen as incompetent', 'over-preparation'],
        stressors: ['upcoming product presentation', 'new manager'],
        support_system: ['partner', 'weekly therapist sessions'],
        coping_repertoire: [
          { technique: 'paced breathing', helpfulness: 'high' },
          { technique: 'thought records', helpfulness: 'high' },
        ],
        values: ['doing good work', 'honesty'],
        screener_trend: 'PHQ-2 and GAD-2 both trending down over 4 weeks',
      },
    };
    bundle.scale_history = [
      { scale: 'phq2', score: 2, created_at: iso(5 * DAY), session_id: 'demo-sess-2006' },
      { scale: 'phq2', score: 3, created_at: iso(19 * DAY), session_id: 'demo-sess-1906' },
      { scale: 'phq2', score: 4, created_at: iso(33 * DAY), session_id: 'demo-sess-1806' },
      { scale: 'gad2', score: 3, created_at: iso(5 * DAY), session_id: 'demo-sess-2006' },
      { scale: 'gad2', score: 4, created_at: iso(19 * DAY), session_id: 'demo-sess-1906' },
      { scale: 'gad2', score: 5, created_at: iso(33 * DAY), session_id: 'demo-sess-1806' },
    ];
    bundle.mood_trajectory = [
      { date: iso(3 * HOUR), source: 'checkin', mood: 7 },
      { date: iso(5 * DAY), source: 'log_mood', mood: 6 },
      { date: iso(12 * DAY), source: 'checkin', mood: 5 },
      { date: iso(19 * DAY), source: 'log_mood', mood: 5 },
      { date: iso(26 * DAY), source: 'checkin', mood: 4 },
      { date: iso(33 * DAY), source: 'checkin', mood: 4 },
    ];
    bundle.thought_record = {
      created_at: iso(3 * HOUR),
      record: {
        situation: 'Stumbled during the sprint demo in front of the whole team',
        hot_thought: "Everyone thinks I'm incompetent (90%)",
        evidence_for: 'I lost my place during the demo',
        evidence_against: 'Manager asked me to lead the next demo; two teammates said it was useful',
        balanced_thought: 'One rough moment in a demo people found useful overall (40%)',
      },
    };
  }

  if (userId === 9002) {
    // Client B: the caught-and-resolved crisis, visible end to end.
    bundle.ended_session_count = 4;
    bundle.summaries = [
      {
        session_id: 'demo-sess-2004',
        session_name: 'Morning follow-up after alert',
        ended_at: iso(20 * HOUR - 16 * 60 * 1000),
        created_at: iso(20 * HOUR - 16 * 60 * 1000),
        summary: {
          headline: 'Follow-up after high-severity flag; used safety plan, contacted sister, therapist looped in',
          topics: ['grief', 'safety plan', 'follow-up'],
          mood_trajectory: 'improving',
          techniques_helped: ['safety plan activation', 'behavioral scheduling'],
          follow_up: 'Therapist follow-up today; keep morning walk and evening call with sister.',
        },
      },
      {
        session_id: 'demo-sess-2003',
        session_name: 'Evening check-in',
        ended_at: iso(DAY + 10 * HOUR - 21 * 60 * 1000),
        created_at: iso(DAY + 10 * HOUR - 21 * 60 * 1000),
        summary: {
          headline: 'Disclosed active ideation without plan ahead of loss anniversary; safety protocol engaged',
          topics: ['grief', 'anniversary reaction', 'suicidal ideation'],
          mood_trajectory: 'declining then stabilizing',
          techniques_helped: ['direct risk inquiry', 'grounding breath', 'safety plan review'],
          follow_up: 'Automatic therapist notification sent; next-morning check-in scheduled.',
        },
      },
    ];
    bundle.memories = [
      { fact: 'Wife passed away 14 months ago; the anniversary is this weekend', session_id: 'demo-sess-2003', created_at: iso(DAY + 10 * HOUR) },
      { fact: 'Sister (Dana) is the primary support contact and lives nearby', session_id: 'demo-sess-2003', created_at: iso(DAY + 10 * HOUR) },
    ];
    bundle.case_profile = {
      updated_at: iso(20 * HOUR),
      profile: {
        presenting_concerns: ['depression', 'complicated grief'],
        recurring_themes: ['guilt', 'anniversary reactions', 'social withdrawal'],
        stressors: ['loss anniversary this weekend', 'living alone'],
        support_system: ['sister Dana', 'weekly therapist sessions'],
        coping_repertoire: [
          { technique: 'grounding breath', helpfulness: 'high' },
          { technique: 'calling sister', helpfulness: 'high' },
          { technique: 'morning walks', helpfulness: 'medium' },
        ],
        values: ['family', 'honoring his wife'],
        screener_trend: 'PHQ-2 elevated but stable; monitor through the anniversary',
      },
    };
    bundle.scale_history = [
      { scale: 'phq2', score: 4, created_at: iso(20 * HOUR), session_id: 'demo-sess-2004' },
      { scale: 'phq2', score: 5, created_at: iso(14 * DAY), session_id: 'demo-sess-1904' },
      { scale: 'phq2', score: 5, created_at: iso(28 * DAY), session_id: 'demo-sess-1804' },
      { scale: 'gad2', score: 3, created_at: iso(20 * HOUR), session_id: 'demo-sess-2004' },
      { scale: 'gad2', score: 3, created_at: iso(14 * DAY), session_id: 'demo-sess-1904' },
    ];
    bundle.mood_trajectory = [
      { date: iso(20 * HOUR), source: 'checkin', mood: 4 },
      { date: iso(DAY + 10 * HOUR), source: 'checkin', mood: 2 },
      { date: iso(7 * DAY), source: 'log_mood', mood: 4 },
      { date: iso(14 * DAY), source: 'checkin', mood: 4 },
      { date: iso(21 * DAY), source: 'checkin', mood: 3 },
    ];
    bundle.safety_plan = {
      created_at: iso(DAY + 10 * HOUR - 12 * 60 * 1000),
      session_id: 'demo-sess-2003',
      plan: {
        warning_signs: ['Thoughts get loud in the evening', 'Skipping meals', 'Avoiding calls'],
        coping_strategies: ['Grounding breath (4-4-6)', 'Morning walk', 'Photo album ritual, 10 minutes max'],
        support_contacts: ['Sister Dana (first call)', 'Therapist (next business day)'],
        professional_resources: ['988 Suicide & Crisis Lifeline (call or text 988)', 'Crisis Text Line: text HOME to 741741'],
        environment_safety: ['Medications stored with Dana through the anniversary weekend'],
      },
    };
    bundle.clinician_note = {
      notes: 'Reviewed flagged session same evening. Ideation without plan or intent; protective factors intact (sister engaged, future-oriented statements). Messaged client next morning, follow-up session completed, flag resolved. Will hold extra check-in after the anniversary weekend.',
      author: 'dr_demo',
      created_at: iso(16 * HOUR),
      session_id: 'demo-sess-2003',
    };
    bundle.prior_crisis_flags = [
      {
        session_id: 'demo-sess-2003',
        severity: 'high',
        flagged_at: iso(DAY + 10 * HOUR - 9 * 60 * 1000),
        unflagged_at: iso(14 * HOUR),
        unflagged_by: 'dr_demo',
      },
    ];
  }

  if (userId === 9003) {
    // Client C: continuity — the deepest memory bundle in the demo.
    bundle.ended_session_count = 8;
    bundle.summaries = [
      {
        session_id: 'demo-sess-2005',
        session_name: 'Boundaries at work — week 4',
        ended_at: iso(2 * DAY + 4 * HOUR - 23 * 60 * 1000),
        created_at: iso(2 * DAY + 4 * HOUR - 23 * 60 * 1000),
        summary: {
          headline: 'Left work on time both target days; cooked for the first time in weeks',
          topics: ['burnout', 'boundaries', 'behavioral activation'],
          mood_trajectory: 'improving',
          techniques_helped: ['implementation intentions', 'first-ten-minutes rule'],
          follow_up: 'Keep Tuesday/Thursday exits; consider adding a third day.',
        },
      },
      {
        session_id: 'demo-sess-2007',
        session_name: 'Values and energy audit',
        ended_at: iso(6 * DAY + 5 * HOUR - 15 * 60 * 1000),
        created_at: iso(6 * DAY + 5 * HOUR - 15 * 60 * 1000),
        summary: {
          headline: 'Mapped weekly energy against values; connection identified as most starved',
          topics: ['values', 'burnout', 'social withdrawal'],
          mood_trajectory: 'stable',
          techniques_helped: ['values clarification'],
          follow_up: 'Pick one cancelled plan to un-cancel; discuss with therapist.',
        },
      },
      {
        session_id: 'demo-sess-1905',
        session_name: 'Recognizing the pattern',
        ended_at: iso(13 * DAY),
        created_at: iso(13 * DAY),
        summary: {
          headline: 'Connected exhaustion to saying yes to every request; named the pattern',
          topics: ['burnout', 'people-pleasing'],
          mood_trajectory: 'stable',
          techniques_helped: ['pattern spotting'],
          follow_up: 'Track requests accepted vs declined for one week.',
        },
      },
    ];
    bundle.memories = [
      { fact: 'Works as a senior nurse; double shifts every other week', session_id: 'demo-sess-1905', created_at: iso(13 * DAY) },
      { fact: "Sister visited two weekends ago — first genuinely good weekend in months", session_id: 'demo-sess-2005', created_at: iso(2 * DAY) },
      { fact: 'Cooking used to be a main way to recharge', session_id: 'demo-sess-2007', created_at: iso(6 * DAY) },
      { fact: 'Goal: leave work by 6pm on Tuesdays and Thursdays', session_id: 'demo-sess-2005', created_at: iso(2 * DAY) },
      { fact: 'The first ten minutes after deciding to leave are the hardest', session_id: 'demo-sess-2005', created_at: iso(2 * DAY) },
    ];
    bundle.case_profile = {
      updated_at: iso(2 * DAY),
      profile: {
        presenting_concerns: ['occupational burnout', 'emotional exhaustion'],
        recurring_themes: ['difficulty saying no', 'guilt when resting', 'identity tied to being needed'],
        stressors: ['chronic understaffing at the hospital', 'double shifts'],
        support_system: ['sister', 'one close colleague', 'biweekly therapist sessions'],
        coping_repertoire: [
          { technique: 'implementation intentions', helpfulness: 'high' },
          { technique: 'cooking', helpfulness: 'high' },
          { technique: 'values check-ins', helpfulness: 'medium' },
        ],
        values: ['caring for others', 'connection', 'competence'],
        screener_trend: 'No elevated screeners; energy and engagement improving week over week',
      },
    };
    bundle.scale_history = [
      { scale: 'phq2', score: 1, created_at: iso(2 * DAY), session_id: 'demo-sess-2005' },
      { scale: 'phq2', score: 2, created_at: iso(16 * DAY), session_id: 'demo-sess-1905' },
      { scale: 'gad2', score: 1, created_at: iso(2 * DAY), session_id: 'demo-sess-2005' },
    ];
    bundle.mood_trajectory = [
      { date: iso(2 * DAY), source: 'checkin', mood: 7 },
      { date: iso(6 * DAY), source: 'checkin', mood: 6 },
      { date: iso(13 * DAY), source: 'log_mood', mood: 5 },
      { date: iso(20 * DAY), source: 'checkin', mood: 4 },
      { date: iso(27 * DAY), source: 'checkin', mood: 4 },
      { date: iso(34 * DAY), source: 'checkin', mood: 3 },
    ];
  }

  // Client D (9004): intentionally near-empty — a realistic first-session
  // profile. ended_session_count 0, no summaries/memories/case profile yet.

  return bundle;
}

// AI "since last review" brief (ai-therapist-122): static believable text so
// the demo never hits the real LLM.
const DEMO_BRIEFS: Record<number, string> = {
  9001: 'Doing noticeably better over the last two weeks. Both screeners are trending down (PHQ-2 now 2, GAD-2 now 3) and the most recent session produced a completed thought record that cut the hot-thought belief from 90 to 40 percent. Mood check-ins are climbing. The product presentation on the 22nd is the main upcoming stressor; paced breathing before meetings remains the most reliable skill. Worth reviewing the completed thought record together before the presentation.',
  9002: 'Stabilizing after a high-severity crisis flag two nights ago, disclosed ahead of the loss anniversary this weekend. The flag was reviewed and resolved the next morning: ideation without plan or intent, protective factors intact, sister engaged, safety plan created and used. Mood dipped to 2 during the flagged session and recovered to 4 at the morning follow-up. PHQ-2 remains elevated but stable at 4-5. Priority before the next session: confirm the anniversary-weekend plan and the extra post-weekend check-in.',
  9003: 'Steady, meaningful progress on burnout. Left work on time on both target days for the first time and cooked again after weeks of takeout. Mood check-ins have improved from 3-4 a month ago to 7 this week and no screeners are elevated. The values audit surfaced connection as the most starved area; the open follow-up is choosing one cancelled plan to un-cancel. Consider adding a third protected evening if the Tuesday/Thursday pattern holds.',
};

export function demoUserBrief(userId: number) {
  if (!CLIENTS.some(c => c.userid === userId)) return null;
  return { brief: DEMO_BRIEFS[userId] ?? null };
}

export function demoUserSessions(userId: number, limit = 50) {
  const rows = SESSIONS.filter(s => s.user_id === userId).map(s => ({
    ...listRow(s),
    eval_score: s.eval_score,
    feedback_rating: s.feedback_rating,
  }));
  return {
    sessions: rows.slice(0, limit),
    pagination: { page: 1, limit, totalCount: rows.length },
  };
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

// ---- Ops telemetry + funnel (pass-3 surfaces) ----

export function demoOps() {
  return {
    window_minutes: 60,
    requests: { admin: 184, api: 421, realtime: 63, static: 902 },
    errorRates: {
      admin: { count_4xx: 3, count_5xx: 0, rate_4xx: 0.016, rate_5xx: 0 },
      api: { count_4xx: 9, count_5xx: 1, rate_4xx: 0.021, rate_5xx: 0.002 },
      realtime: { count_4xx: 0, count_5xx: 0, rate_4xx: 0, rate_5xx: 0 },
      static: { count_4xx: 2, count_5xx: 0, rate_4xx: 0.002, rate_5xx: 0 },
    },
    latency: {
      admin: { p50_ms: 38, p95_ms: 210 },
      api: { p50_ms: 24, p95_ms: 142 },
      realtime: { p50_ms: 61, p95_ms: 388 },
      static: { p50_ms: 3, p95_ms: 12 },
    },
    uptime: 6 * 24 * 3600 + 4 * 3600,
    memory: { rss: 312 * 1024 * 1024, heap_used: 178 * 1024 * 1024 },
    clientErrors: [
      { kind: 'webrtc_failed', count: 2, last_seen: iso(9 * HOUR) },
      { kind: 'mic_permission_denied', count: 1, last_seen: iso(2 * DAY) },
    ],
  };
}

export function demoFunnel(days = 30) {
  return {
    days,
    funnel: {
      created: 19,
      with_checkin: 17,
      connected: 19,
      with_user_turn: 18,
      with_tool_use: 14,
      ended_gracefully: 17,
    },
  };
}

// ---- Knowledge base (curation + usage + rerank decisions) ----

interface DemoChunk {
  chunk_id: number;
  kind: string;
  topic: string | null;
  title: string;
  content: string;
  modality: string | null;
  active: boolean;
  approved_by: string | null;
  retrieved: number;
  chosen: number;
}

const KNOWLEDGE_CHUNKS: DemoChunk[] = [
  { chunk_id: 501, kind: 'psychoeducation', topic: 'anxiety', title: 'How avoidance keeps anxiety alive', content: 'Avoiding a feared situation brings quick relief, and that relief teaches the brain that the situation really was dangerous. Over time the world of "safe" activities shrinks. Gradual, repeated approach — starting small and staying long enough for anxiety to fall on its own — retrains that alarm.', modality: 'cbt', active: true, approved_by: 'dr_demo', retrieved: 21, chosen: 12 },
  { chunk_id: 502, kind: 'psychoeducation', topic: 'grief', title: 'Anniversary reactions are normal grief', content: 'Grief often intensifies around anniversaries, birthdays, and holidays, sometimes months or years after a loss. These waves are a normal part of grieving, not a setback. Planning the day in advance — company, ritual, permission to feel — usually softens them.', modality: null, active: true, approved_by: 'dr_demo', retrieved: 9, chosen: 7 },
  { chunk_id: 503, kind: 'psychoeducation', topic: 'burnout', title: 'Burnout vs. depression: overlapping but different', content: 'Burnout is exhaustion, cynicism, and reduced efficacy tied to chronic work stress; it often improves with recovery time and boundary changes. Depression is broader and follows you across contexts. They can co-occur, which is why screeners are still worth tracking.', modality: null, active: true, approved_by: 'dr_demo', retrieved: 11, chosen: 6 },
  { chunk_id: 504, kind: 'worksheet', topic: 'anxiety', title: 'Thought record (7 column)', content: 'Situation. Emotion and intensity (0-100). Automatic thought and belief (0-100). Evidence for. Evidence against. Balanced alternative thought. Re-rate emotion and belief.', modality: 'cbt', active: true, approved_by: 'dr_demo', retrieved: 17, chosen: 13 },
  { chunk_id: 505, kind: 'worksheet', topic: 'values', title: 'Values and energy audit', content: 'List the ten activities that consumed most of your week. Next to each, note which personal value it serves, if any. Circle the values that received no time at all. Choose one starved value and one 15-minute action toward it this week.', modality: 'act', active: true, approved_by: 'dr_demo', retrieved: 6, chosen: 4 },
  { chunk_id: 506, kind: 'worksheet', topic: 'sleep', title: 'Wind-down routine builder', content: 'Pick a consistent lights-out time. Working backwards, block 30 minutes: screens off, low light, one calming activity from your list. Note what you tried and rate sleep quality 1-5 each morning for a week.', modality: 'cbt', active: false, approved_by: null, retrieved: 0, chosen: 0 },
  { chunk_id: 507, kind: 'technique', topic: 'grounding', title: 'Paced breathing 4-4-6', content: 'Breathe in through the nose for a count of four, hold for four, and out through the mouth for six. The longer exhale engages the parasympathetic system. Repeat for ten cycles or about two minutes.', modality: null, active: true, approved_by: 'dr_demo', retrieved: 24, chosen: 18 },
  { chunk_id: 508, kind: 'technique', topic: 'grounding', title: '5-4-3-2-1 sensory grounding', content: 'Name five things you can see, four you can feel, three you can hear, two you can smell, and one you can taste. Speaking each one out loud anchors attention in the present.', modality: null, active: true, approved_by: 'dr_demo', retrieved: 8, chosen: 5 },
];

export function demoKnowledge() {
  const byKind = (kind: string) => KNOWLEDGE_CHUNKS.filter(c => c.kind === kind);
  return {
    counts: ['psychoeducation', 'technique', 'worksheet'].map(kind => ({
      kind,
      active: byKind(kind).filter(c => c.active).length,
      pending: byKind(kind).filter(c => !c.active).length,
    })),
    chunks: KNOWLEDGE_CHUNKS.map(c => ({
      chunk_id: c.chunk_id,
      kind: c.kind,
      topic: c.topic,
      title: c.title,
      content: c.content,
      source: 'Demo clinical library (synthetic)',
      source_url: null,
      license: 'internal',
      modality: c.modality,
      active: c.active,
      approved_by: c.approved_by,
      approved_at: c.active ? iso(20 * DAY) : null,
      approval_note: c.active ? 'Reviewed for pilot library' : null,
      created_at: iso(30 * DAY),
      updated_at: iso(20 * DAY),
      has_embedding: true,
    })),
    total: KNOWLEDGE_CHUNKS.length,
  };
}

export function demoKnowledgeUsage() {
  return {
    usage: KNOWLEDGE_CHUNKS.filter(c => c.retrieved > 0).map(c => ({
      chunk_id: c.chunk_id,
      retrieved_count: c.retrieved,
      chosen_count: c.chosen,
      last_used: iso(5 * HOUR),
    })),
  };
}

export function demoRerankDecisions() {
  const decisions = [
    {
      decision_id: 9301,
      session_id: 'demo-sess-2002',
      tool_name: 'get_worksheet',
      query: 'thought record for performance anxiety at work',
      candidates: [
        { chunk_id: 504, vec_rank: 0, similarity: 0.82 },
        { chunk_id: 501, vec_rank: 1, similarity: 0.74 },
        { chunk_id: 505, vec_rank: 2, similarity: 0.61 },
      ],
      chosen: [504, 501],
      used_fallback: false,
      model: 'gpt-5-mini',
      latency_ms: 412,
      created_at: iso(3 * HOUR),
    },
    {
      decision_id: 9302,
      session_id: 'demo-sess-2003',
      tool_name: 'get_coping_strategies',
      query: 'grounding for acute distress grief anniversary',
      candidates: [
        { chunk_id: 508, vec_rank: 0, similarity: 0.79 },
        { chunk_id: 507, vec_rank: 1, similarity: 0.77 },
        { chunk_id: 502, vec_rank: 2, similarity: 0.7 },
      ],
      chosen: [507, 502],
      used_fallback: false,
      model: 'gpt-5-mini',
      latency_ms: 388,
      created_at: iso(DAY + 10 * HOUR),
    },
    {
      decision_id: 9303,
      session_id: 'demo-sess-2005',
      tool_name: 'get_psychoeducation',
      query: 'burnout recovery boundaries',
      candidates: [
        { chunk_id: 503, vec_rank: 0, similarity: 0.81 },
        { chunk_id: 505, vec_rank: 1, similarity: 0.68 },
      ],
      chosen: [503],
      used_fallback: true,
      model: null,
      latency_ms: 6,
      created_at: iso(2 * DAY + 4 * HOUR),
    },
  ];
  return {
    stats: { total: 57, fallback_rate: 0.05, movement_rate: 0.32, p95_latency_ms: 640 },
    decisions,
  };
}

// ---- Adverse events (IRB reporting) ----
// One report: Client B's crisis, auto-drafted from the flag, already reviewed
// and submitted by dr_demo — the "nothing slips through" close of the arc.

export function demoAdverseEvents(status?: string) {
  const crisisStart = DAY + 10 * HOUR;
  const report = {
    report_id: 71,
    session_ref: 'demo-sess-2003',
    participant_ref: 'client_b',
    occurred_at: iso(crisisStart - 9 * 60 * 1000),
    severity: 'high' as const,
    trigger_source: 'auto_flag',
    category: 'crisis' as const,
    summary: 'High-severity crisis flag during evening session ahead of loss anniversary. Client disclosed active suicidal ideation without plan or intent on direct inquiry. In-session safety protocol completed (safety plan review, grounding, support contact commitment); therapist notified automatically, reviewed the transcript the same evening, and completed a follow-up next morning. Flag resolved.',
    timeline: [
      { at: iso(crisisStart - 4 * 60 * 1000), kind: 'risk_signal', detail: 'Stage-2 risk score 12: grief-focused distress, no ideation language' },
      { at: iso(crisisStart - 7 * 60 * 1000), kind: 'risk_signal', detail: 'Risk score 46 (medium): passive ideation markers, rising trajectory' },
      { at: iso(crisisStart - 9 * 60 * 1000), kind: 'auto_flag', detail: 'Risk score 82 (high): active ideation without plan confirmed on direct inquiry' },
      { at: iso(crisisStart - 9 * 60 * 1000 + 20 * 1000), kind: 'notification', detail: 'Therapist (dr_demo) notified' },
      { at: iso(crisisStart - 11 * 60 * 1000), kind: 'intervention', detail: 'Safety plan reviewed in-session; grounding exercise completed; client agreed to call sister' },
      { at: iso(crisisStart - 21 * 60 * 1000), kind: 'session_end', detail: 'Session ended calmly by client after wind-down' },
      { at: iso(crisisStart - 12 * HOUR), kind: 'clinical_review', detail: 'dr_demo reviewed transcript and risk history' },
      { at: iso(20 * HOUR - 16 * 60 * 1000), kind: 'follow_up', detail: 'Next-morning follow-up session completed; client used safety plan overnight' },
      { at: iso(14 * HOUR), kind: 'resolution', detail: 'Flag resolved by dr_demo; extra check-in scheduled after anniversary weekend' },
    ],
    transcript_excerpt: 'Assistant: "I need to ask directly: are you having thoughts of ending your life, or of hurting yourself tonight?" Client: "Thoughts, yes. I wouldn\'t do anything. But the thoughts are loud."',
    actions_taken: [
      { at: iso(crisisStart - 11 * 60 * 1000), action: 'Safety plan activated in-session', by: 'system' },
      { at: iso(crisisStart - 9 * 60 * 1000), action: 'Therapist notification sent', by: 'system' },
      { at: iso(crisisStart - 12 * HOUR), action: 'Clinical review completed', by: 'dr_demo' },
      { at: iso(14 * HOUR), action: 'Flag resolved, follow-up scheduled', by: 'dr_demo' },
    ],
    status: 'submitted' as const,
    due_at: new Date(now + 5 * DAY).toISOString(),
    submitted_by: 'dr_demo',
    submitted_at: iso(13 * HOUR),
    closed_by: null,
    overdue: false,
  };
  const reports = !status || status === 'all' || status === report.status ? [report] : [];
  return {
    reports,
    counts: { draft: 0, submitted: 1, overdue: 0, due_soon: 0 },
  };
}

export function demoAdverseEventById(id: number) {
  const { reports } = demoAdverseEvents('all');
  return reports.find(r => r.report_id === id) ?? null;
}
