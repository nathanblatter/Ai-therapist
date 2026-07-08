// Brief validated screening instruments for the administer_scale tool.
// PHQ-2 and GAD-2 are public domain (Kroenke, Spitzer, Williams). Each item is
// answered 0-3 ("not at all" … "nearly every day", over the last two weeks);
// the score is the item sum (0-6), with >=3 the conventional screen-positive
// cutoff. These are SCREENERS, not diagnoses — the tool description and the
// admin display both say so.
export interface ScaleDefinition {
  id: string;
  name: string;
  intro: string;
  items: string[];
  options: { label: string; value: number }[];
  max_score: number;
  cutoff: number;
}

const RESPONSE_OPTIONS = [
  { label: 'Not at all', value: 0 },
  { label: 'Several days', value: 1 },
  { label: 'More than half the days', value: 2 },
  { label: 'Nearly every day', value: 3 },
];

export const SCALES: Record<string, ScaleDefinition> = {
  phq2: {
    id: 'phq2',
    name: 'PHQ-2 (mood check)',
    intro: 'Over the last two weeks, how often have you been bothered by the following?',
    items: [
      'Little interest or pleasure in doing things',
      'Feeling down, depressed, or hopeless',
    ],
    options: RESPONSE_OPTIONS,
    max_score: 6,
    cutoff: 3,
  },
  gad2: {
    id: 'gad2',
    name: 'GAD-2 (anxiety check)',
    intro: 'Over the last two weeks, how often have you been bothered by the following?',
    items: [
      'Feeling nervous, anxious, or on edge',
      'Not being able to stop or control worrying',
    ],
    options: RESPONSE_OPTIONS,
    max_score: 6,
    cutoff: 3,
  },
};
