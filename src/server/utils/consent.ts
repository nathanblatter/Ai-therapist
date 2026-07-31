// Single source of truth for the current consent copy version. Bump this any
// time the consent screen's disclosures materially change (e.g. a new data use,
// a new retention window) so old acceptances stop satisfying requireConsent and
// participants are re-prompted. Purely additive/wording tweaks don't need a bump.
export const CURRENT_CONSENT_VERSION = '2026-07-30.1';
