// Response and filter types for the main /admin/api/analytics dashboard fetch,
// shared by Analytics.tsx and the analytics filter bar (ai-therapist-120).

export interface AnalyticsMetrics {
  total_sessions: number;
  avg_messages_per_session: number;
  avg_duration_seconds: number;
}

export interface AnalyticsBreakdown {
  voice_messages: number;
  chat_messages: number;
  user_messages: number;
  assistant_messages: number;
}

export interface DailyTrendItem {
  date: string;
  session_count: number;
}

export interface UserSessionItem {
  userid: string | number;
  username: string | null;
  session_count: number;
}

export interface TimeDistributionItem {
  time_period: string;
  session_count: number;
}

export interface DurationDistributionItem {
  duration_category: string;
  session_count: number;
}

export interface DurationTrendItem {
  date: string;
  avg_duration_seconds: number;
}

export interface LanguageDistributionItem {
  language: string;
  session_count: number;
  percentage: number;
}

export interface VoiceDistributionItem {
  voice: string;
  session_count: number;
  percentage: number;
}

export interface CompletionPatternItem {
  ended_by: string;
  session_count: number;
  percentage: number;
}

export interface AbandonmentStats {
  abandonment_rate_percentage: number;
  abandoned_sessions: number;
  completed_sessions: number;
}

export interface SessionDepthItem {
  user_type: string;
  avg_messages: string | number;
  session_count: number;
}

export interface EngagementPace {
  avg_messages_per_minute: string | number | null;
}

// Real turn latency from the turn_latency table (telemetry pass 3): ground
// truth captured server-side, not the old message-flush-cadence math.
// Realtime channel only — chat turns (where ttfa == total tool-loop wall
// time) are reported separately so they don't inflate the TTFA KPI.
export interface ResponseTimes {
  measured_turns: number;
  p50_ttfa_ms: string | number | null;
  p95_ttfa_ms: string | number | null;
  p50_total_ms: string | number | null;
  p95_total_ms: string | number | null;
}

// Chat is non-streaming: only the full turn wall time is meaningful.
export interface ChatResponseTimes {
  measured_turns: number;
  p50_total_ms: string | number | null;
  p95_total_ms: string | number | null;
}

export interface SidebandReliability {
  realtime_sessions: number;
  attached_sessions: number;
  error_sessions: number;
  attach_success_rate: string | number | null;
}

export interface TurnTaking {
  user_to_assistant_ratio: string | number | null;
  total_user_messages: number;
  total_assistant_messages: number;
}

export interface AnalyticsData {
  metrics: AnalyticsMetrics;
  breakdown: AnalyticsBreakdown;
  daily_trend?: DailyTrendItem[];
  user_sessions?: UserSessionItem[];
  time_distribution?: TimeDistributionItem[];
  duration_distribution?: DurationDistributionItem[];
  duration_trend?: DurationTrendItem[];
  language_distribution?: LanguageDistributionItem[];
  voice_distribution?: VoiceDistributionItem[];
  completion_patterns?: CompletionPatternItem[];
  abandonment_stats?: AbandonmentStats;
  session_depth?: SessionDepthItem[];
  engagement_pace?: EngagementPace;
  response_times?: ResponseTimes;
  chat_response_times?: ChatResponseTimes;
  turn_taking?: TurnTaking;
  sideband_reliability?: SidebandReliability;
}

export interface AnalyticsFilterState {
  startDate: string;
  endDate: string;
  voices: string[];
  languages: string[];
  sessionTypes: string[];
  statuses: string[];
  endedBy: string[];
  crisisFlagged: string;
}
