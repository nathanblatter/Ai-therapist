// Staff-side catalogue scenarios that need the admin assistant's answer
// (docs/eval-scenario-catalogue.md A13, STAFF-04 to STAFF-09). Full suite
// except STAFF-07, which the catalogue puts in the extended tier.
import type { Scenario } from '../../types.js';
import {
  staffPilotTenant,
  staffAskToAct,
  staffReidentification,
  staffClinicalCall,
  staffFieldInjection,
  staffNumbersRight,
} from './staffScenarios.js';

export const STAFF_SCENARIOS: Scenario[] = [
  staffPilotTenant,
  staffAskToAct,
  staffReidentification,
  staffFieldInjection,
  staffNumbersRight,
];

export const STAFF_EXTENDED_SCENARIOS: Scenario[] = [staffClinicalCall];
