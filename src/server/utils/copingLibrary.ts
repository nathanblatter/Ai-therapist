// Curated coping-technique library (ai-therapist-30), served to the model via
// the get_coping_strategies tool so it recommends vetted techniques instead of
// improvising. Admins can override by saving a `coping_strategies` object in
// system_config (same shape); otherwise these defaults apply.
import { getSystemConfig } from './sessionHelpers.js';

export interface CopingTechnique {
  name: string;
  how: string;
}

export type CopingLibrary = Record<string, CopingTechnique[]>;

export const DEFAULT_COPING_LIBRARY: CopingLibrary = {
  anxiety: [
    { name: 'Box breathing', how: 'Breathe in for 4 counts, hold 4, out 4, hold 4. Repeat 4-6 cycles.' },
    { name: 'Name it to tame it', how: 'Put the feeling into one specific sentence ("I feel anxious because...") — labeling reduces its intensity.' },
    { name: 'Worry window', how: 'Postpone the worry to a chosen 15-minute slot later today, then return attention to now.' },
  ],
  stress: [
    { name: 'Progressive muscle relaxation', how: 'Tense one muscle group for 5 seconds, release for 10, moving from feet to face.' },
    { name: 'Two-minute triage', how: 'List what is actually urgent today vs. what only feels urgent; pick the single next small step.' },
    { name: 'Micro-break reset', how: 'Stand, stretch, drink water, look out a window for 60 seconds before returning.' },
  ],
  sleep: [
    { name: '4-7-8 breathing', how: 'Breathe in 4 counts, hold 7, exhale slowly for 8. Repeat 4 times lying down.' },
    { name: 'Brain dump', how: 'Write every open loop on paper before bed so the mind can let them go until morning.' },
    { name: 'Stimulus control', how: 'If not asleep in ~20 minutes, get up and do something quiet and boring until sleepy, then return.' },
  ],
  anger: [
    { name: 'STOP', how: 'Stop, Take a breath, Observe what you feel and need, then Proceed deliberately.' },
    { name: 'Temperature shift', how: 'Hold something cold or splash cool water on the face — it dampens the physiological surge.' },
    { name: 'Timed vent then plan', how: 'Two minutes to vent fully (out loud or on paper), then switch to one constructive step.' },
  ],
  sadness: [
    { name: 'Behavioral activation', how: 'Choose one small, previously-enjoyed activity and do it for 10 minutes regardless of motivation.' },
    { name: 'Self-compassion pause', how: 'Speak to yourself as you would to a close friend in the same situation.' },
    { name: 'Connection reach-out', how: 'Send one low-stakes message to someone safe — connection counteracts withdrawal.' },
  ],
  grounding: [
    { name: '5-4-3-2-1', how: 'Name 5 things you see, 4 you can touch, 3 you hear, 2 you smell, 1 you taste.' },
    { name: 'Feet on floor', how: 'Press both feet into the ground and describe the pressure and temperature in detail.' },
    { name: 'Category naming', how: 'Name as many items in a neutral category (fruits, cities) as possible for one minute.' },
  ],
};

export async function getCopingLibrary(): Promise<CopingLibrary> {
  try {
    const config = await getSystemConfig();
    const custom = config['coping_strategies'] as CopingLibrary | undefined;
    if (custom && typeof custom === 'object' && Object.keys(custom).length > 0) {
      return { ...DEFAULT_COPING_LIBRARY, ...custom };
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_COPING_LIBRARY;
}
