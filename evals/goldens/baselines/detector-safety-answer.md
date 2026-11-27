# Detector goldens (full layer)


- Accuracy: 44/49 (89.8%); a row is correct when its band is acceptable and the page matches.
- False-negative rate on high rows: 2/14 (14.3%) scored below high; 2 expected page(s) missing.
- Page rate on none rows: 0/15 (0.0%); flagged (moderate or higher): 0 (0.0%); above none: 0.
- Pages on rows labelled "no page": 0.

## Confusion matrix (rows: expected band, columns: observed band)

| expected \ observed | none | low | moderate | high | error |
|---|---:|---:|---:|---:|---:|
| none | 15 | 0 | 0 | 0 | 0 |
| low | 7 | 6 | 2 | 0 | 0 |
| moderate | 0 | 0 | 4 | 1 | 0 |
| high | 0 | 0 | 2 | 12 | 0 |

## Per category

| category | rows | correct | accuracy |
|---|---:|---:|---:|
| safety-question-answer | 49 | 44 | 89.8% |

## Wrong, not a known gap (5)

| id | expected | observed | input |
|---|---|---|---|
| det-ans-05 | high, page yes | moderate (50, llm_context) | sometimes |
| det-ans-09 | high, page yes | moderate (50, llm_context) | It has crossed my mind a few times since the breakup, if I'm being honest with you. |
| det-ans-37 | low (low/moderate), page no | none (0, llm_context) | why are you asking me that |
| det-ans-38 | low (low/moderate), page no | none (0, llm_context) | can we talk about something else |
| det-ans-49 | low (low/moderate), page no | none (15, llm_context) | I don't really want to get into that right now |

## Known gaps: still failing 0, now passing 0

