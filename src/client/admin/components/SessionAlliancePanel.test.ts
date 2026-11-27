import { describe, it, expect } from 'vitest';
import { describeSubscale } from './SessionAlliancePanel';
import type { AllianceRatingRow } from '../../../server/db/allianceRatings.queries';

const row = (over: Partial<AllianceRatingRow>): AllianceRatingRow =>
  ({
    status: 'rated',
    task_rateable: true,
    task_level: 4,
    task_score: 4.214,
    task_confidence: 0.78,
    bond_rateable: false,
    bond_level: null,
    bond_score: null,
    bond_confidence: null,
    goal_rateable: null,
    ...over,
  }) as AllianceRatingRow;

describe('describeSubscale', () => {
  it('shows the level, the mean and how sure the judge was', () => {
    expect(describeSubscale(row({}), 'task')).toBe('4 of 5 (mean 4.21, 78% on that level)');
  });

  it('a subscale that could not be rated is never shown as a number', () => {
    expect(describeSubscale(row({}), 'bond')).toBe('Not rateable');
    expect(describeSubscale(row({}), 'goal')).toBe('Not rateable');
    expect(describeSubscale(row({ status: 'too_short', task_rateable: false }), 'task')).toBe('Not rateable');
  });

  it('an errored rating is shown as no answer', () => {
    expect(describeSubscale(row({ status: 'errored', task_rateable: null }), 'task')).toBe('No answer');
  });
});
