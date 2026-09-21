// Session-phase guidance schedule, shared by every voice backend.
//
// Wall-clock nudges that walk the model through consolidation → wind-down.
// Extracted from SidebandManager.schedulePhaseNudges so the GPT-Live sideband
// and the Grok Voice proxy compute the SAME schedule from the same config
// (features.phase_guidance_enabled, session_limits, the active modality's
// phase script). Only delivery differs per backend, so that stays with the
// caller: this module returns what to say and when, and never sends anything.

import { pool } from '../config/db.js';
import { getSystemConfig, getActiveModality } from './sessionHelpers.js';

export interface PhaseNudge {
  /** Fraction of the session's maximum duration, 0–1. */
  at: number;
  text: string;
  /** Milliseconds from NOW until the nudge is due. Never negative. */
  delayMs: number;
}

/**
 * Build the nudge schedule for a session, or an empty list when phase
 * guidance is off, the session has no duration cap, or every phase is already
 * in the past (e.g. a re-attach late in the session).
 */
export async function buildPhaseNudgeSchedule(sessionId: string): Promise<PhaseNudge[]> {
  const config = await getSystemConfig();
  const features = (config.features ?? {}) as Record<string, unknown>;
  if (features.phase_guidance_enabled === false) return [];

  const limits = (config.session_limits ?? {}) as { enabled?: boolean; max_duration_minutes?: number };
  if (!limits.enabled || !limits.max_duration_minutes) return [];

  const result = await pool.query<{ created_at: Date }>(
    'SELECT created_at FROM therapy_sessions WHERE session_id = $1', [sessionId],
  );
  const createdAt = result.rows[0]?.created_at;
  if (!createdAt) return [];

  const totalMs = limits.max_duration_minutes * 60 * 1000;
  const elapsedMs = Date.now() - new Date(createdAt).getTime();
  const minutesLeftAt = (fraction: number) => Math.max(1, Math.round((totalMs * (1 - fraction)) / 60000));

  const modality = await getActiveModality();
  const modalityPhases = modality?.preset.phases;

  const phases: Array<{ at: number; text: string }> =
    modalityPhases && modalityPhases.length > 0
      ? modalityPhases.map(p => ({
          at: p.at,
          text: p.guidance + (p.at >= 0.8 ? ` About ${minutesLeftAt(p.at)} minutes remain — close warmly as this phase finishes.` : ''),
        }))
      : [
          { at: 0.6, text: 'The session is past its halfway point. Begin gently consolidating: reflect the main themes so far rather than opening new topics.' },
          { at: 0.85, text: `About ${minutesLeftAt(0.85)} minutes remain. Begin winding down: summarize what was discussed, invite final thoughts, and close warmly.` },
        ];
  phases.sort((a, b) => a.at - b.at);

  const schedule: PhaseNudge[] = [];
  for (const phase of phases) {
    const delayMs = totalMs * phase.at - elapsedMs;
    if (delayMs <= 0) continue;
    schedule.push({ at: phase.at, text: phase.text, delayMs });
  }
  return schedule;
}
