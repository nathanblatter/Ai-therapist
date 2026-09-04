// Drift guard: the definition hash must be stable across key order and
// cosmetic churn, and change when scoring-relevant structure changes.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: vi.fn() }));

import { computeSurveyDefinitionHash } from './qualtricsDriftGuard.service.js';

const BASE = {
  Questions: {
    QID1: {
      QuestionType: 'Matrix',
      QuestionText: 'Over the last two weeks...',
      Choices: { '1': { Display: 'Item A' }, '2': { Display: 'Item B' } },
      Answers: { '1': { Display: 'Not at all' }, '4': { Display: 'Nearly every day' } },
      RecodeValues: null,
      Validation: { huge: 'cosmetic-blob' },
    },
  },
  SurveyFlow: {
    Flow: [
      { Type: 'Standard', ID: 'BL_1' },
      { Type: 'EmbeddedData', EmbeddedData: [{ Field: 'sid' }] },
    ],
  },
};

describe('computeSurveyDefinitionHash', () => {
  it('is stable across object key order and cosmetic properties', () => {
    const reordered = {
      SurveyFlow: BASE.SurveyFlow,
      Questions: {
        QID1: {
          Validation: { different: 'cosmetic' },
          RecodeValues: null,
          Answers: BASE.Questions.QID1.Answers,
          Choices: { '2': { Display: 'Item B' }, '1': { Display: 'Item A' } },
          QuestionText: 'Over the last two weeks...',
          QuestionType: 'Matrix',
        },
      },
    };
    expect(computeSurveyDefinitionHash(reordered)).toBe(computeSurveyDefinitionHash(BASE));
  });

  it('changes when question text, choices, recodes, or embedded data change', () => {
    const base = computeSurveyDefinitionHash(BASE);
    const textChanged = structuredClone(BASE);
    textChanged.Questions.QID1.QuestionText = 'Reworded question';
    expect(computeSurveyDefinitionHash(textChanged)).not.toBe(base);

    const choiceAdded = structuredClone(BASE);
    (choiceAdded.Questions.QID1.Choices as Record<string, unknown>)['3'] = { Display: 'Item C' };
    expect(computeSurveyDefinitionHash(choiceAdded)).not.toBe(base);

    const recoded = structuredClone(BASE);
    (recoded.Questions.QID1 as Record<string, unknown>).RecodeValues = { '1': '0' };
    expect(computeSurveyDefinitionHash(recoded)).not.toBe(base);

    const sidDropped = structuredClone(BASE);
    sidDropped.SurveyFlow.Flow = [{ Type: 'Standard', ID: 'BL_1' }];
    expect(computeSurveyDefinitionHash(sidDropped)).not.toBe(base);
  });
});
