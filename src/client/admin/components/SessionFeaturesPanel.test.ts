import { describe, it, expect } from 'vitest';
import { describeGroup, summaryLine, type SessionFeaturesRead } from './SessionFeaturesPanel';
import type { FeatureSummaryItem } from '../../../server/services/sessionFeatures';

const item = (name: string, state: string, p: number | null = 0.9): FeatureSummaryItem => ({
  name,
  label: name.replace(/_/g, ' '),
  definition: 'x',
  state,
  p,
});

const read = (over: Partial<SessionFeaturesRead>): SessionFeaturesRead => ({
  status: 'extracted',
  stale: false,
  feature_set_version: 'features-v1',
  model: 'gpt-6-luna',
  extracted_at: '2026-11-27T00:00:00Z',
  transcript_truncated: false,
  unknown_count: 0,
  groups: [],
  ...over,
});

describe('describeGroup', () => {
  it('lists what is present and the chosen options, and leaves absent variables out', () => {
    expect(
      describeGroup([
        item('topic_sleep', 'present'),
        item('topic_family', 'absent', 0.02),
        item('followup_status', 'not_done', 0.85),
      ]),
    ).toEqual({ found: ['topic sleep', 'followup status: not done'], noAnswer: [] });
  });

  it('never shows uncertain, unknown or not-stored as absent', () => {
    const { found, noAnswer } = describeGroup([
      item('topic_family', 'uncertain', 0.5),
      item('topic_substance_use', 'unknown', null),
      item('topic_new_variable', 'not_stored', null),
      item('rupture_outcome', 'uncertain', 0.4),
    ]);
    expect(found).toEqual([]);
    expect(noAnswer).toEqual([
      'topic family (uncertain)',
      'topic substance use (unknown)',
      'topic new variable (not stored)',
      'rupture outcome (uncertain)',
    ]);
  });
});

describe('summaryLine', () => {
  it('counts present variables and those with no answer', () => {
    const groups = [
      {
        group: 'topics' as const,
        title: 'Topics',
        items: [item('topic_sleep', 'present'), item('topic_family', 'uncertain'), item('topic_finances', 'absent')],
      },
      { group: 'coping' as const, title: 'Coping', items: [item('coping_journaling', 'present')] },
    ];
    expect(summaryLine(read({ groups }))).toBe('2 present · 1 not determined');
    expect(summaryLine(read({ groups: [groups[1]] }))).toBe('1 present');
  });

  it('says so when the session was not coded', () => {
    expect(summaryLine(read({ status: 'too_short' }))).toBe('Too short to code');
    expect(summaryLine(read({ status: 'errored' }))).toBe('Judge gave no answer');
  });
});
