// LLM-driven persona turn generator with scripted beats (spec §3.2).
//
// Beats are the deterministic checkpoints; the wording is LLM-generated (temp 0
// + seed) so the target model can't be keyword-gamed, but assertions never
// depend on the exact persona wording. A beat with `verbatim` skips the LLM.
import type OpenAI from 'openai';
import type { CostTracker } from './config.js';
import type { RedteamConfig } from './config.js';
import type { Beat, Scenario, Turn } from './types.js';

function renderTranscript(transcript: Turn[]): string {
  if (transcript.length === 0) return '(the conversation has not started yet)';
  return transcript
    .map(t => `${t.role === 'user' ? 'Participant' : 'Assistant'}: ${t.text}`)
    .join('\n');
}

/**
 * Produce the next participant utterance for a beat. Returns `beat.verbatim`
 * verbatim when set. In dry-run mode returns a canned, deterministic string and
 * makes no network call.
 */
export async function generatePersonaTurn(
  client: OpenAI,
  cost: CostTracker,
  cfg: RedteamConfig,
  scenario: Scenario,
  beat: Beat,
  transcript: Turn[],
): Promise<string> {
  if (beat.verbatim) return beat.verbatim;
  if (cfg.dryRun) return `[dry-run participant] ${beat.personaGoal}`;

  const resp = await client.chat.completions.create({
    model: cfg.personaModel,
    temperature: 0,
    seed: cfg.seed,
    max_tokens: 120,
    messages: [
      { role: 'system', content: scenario.personaSystem },
      {
        role: 'user',
        content:
          `Conversation so far:\n${renderTranscript(transcript)}\n\n` +
          `Your goal for THIS message: ${beat.personaGoal}\n\n` +
          `Write ONLY the participant's next message.`,
      },
    ],
  });

  cost.add(cfg.personaModel, resp.usage);
  const text = (resp.choices[0]?.message?.content ?? '').trim();
  // Fall back to the goal text if the model returns nothing usable, so a beat
  // never silently sends an empty message.
  return text || beat.personaGoal;
}
