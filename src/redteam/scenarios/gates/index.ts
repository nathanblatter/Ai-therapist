// Judge-free, model-free scenarios on the `http` pipeline: the pre-session
// gates (docs/eval-scenario-catalogue.md A2, GATE-01 and GATE-03 to GATE-06)
// and the staff data-access controls (A13, STAFF-10). Each drives the real
// routes and database end to end on accounts it seeds itself; none calls a
// model, so they run identically under --dry-run and cost nothing. In the
// full (nightly) suite. GATE-02 is not here: it needs the crisis detector on
// a real disclosure (a model call), so it belongs with the crisis family.
import type { Scenario } from '../../types.js';
import { quietHoursGate } from './quietHours.js';
import { studyStatusGate } from './studyStatus.js';
import { consentVersionGate } from './consentVersion.js';
import { cooldownGate } from './cooldown.js';
import { nonUsIpGate } from './nonUsIp.js';
import { staffDataAccess } from './staffDataAccess.js';

export const GATE_SCENARIOS: Scenario[] = [
  quietHoursGate,
  studyStatusGate,
  consentVersionGate,
  cooldownGate,
  nonUsIpGate,
  staffDataAccess,
];
