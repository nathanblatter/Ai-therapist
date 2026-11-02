// Shared shapes for the system_config blobs that both the server (db/config.queries,
// utils/sessionHelpers, rate-limit routes) and the admin/participant UIs read.
// Single source of truth — these were previously re-declared per file and drifted
// (the participant-facing CrisisContact copy lost `enabled`; SessionLimits had four
// divergent copies). Fields the config blob may legitimately omit are optional;
// UIs that edit these blobs supply their own defaults when rendering forms.

/** The crisis hotline shown TO participants (distinct from on-call paging config). */
export interface CrisisContact {
  hotline: string;
  phone: string;
  text?: string;
  enabled?: boolean;
}

/** The voice vendor's own maximum session length in minutes (GPT-Live: 60). */
export const DEFAULT_VENDOR_CEILING_MINUTES = 60;

/** Daily/session rate-limit config blob. */
export interface SessionLimits {
  enabled: boolean;
  max_duration_minutes?: number;
  max_sessions_per_day?: number;
  cooldown_minutes?: number;
  /**
   * The voice vendor's own maximum session length (60 on GPT-Live). A crisis
   * lifts max_duration_minutes to this; it cannot be moved from our side.
   */
  vendor_ceiling_minutes?: number;
}

export interface VoiceOption {
  value: string;
  label: string;
  description?: string;
  enabled: boolean;
}

export interface VoicesConfig {
  voices?: VoiceOption[];
  default_voice?: string;
}

export interface LanguageOption {
  value: string;
  label: string;
  description?: string;
  enabled: boolean;
  systemPromptAddition?: string;
}

export interface LanguagesConfig {
  languages?: LanguageOption[];
  default_language?: string;
}
