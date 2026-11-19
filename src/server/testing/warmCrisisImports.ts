// The crisis path loads several modules lazily (dynamic import(), to keep the
// participant's reply off their load time and to avoid import cycles). The
// first such import in a test file is real module loading, which completes on
// real I/O, not on the fake clock. A test that advances fake timers by a fixed
// amount and then awaits the result could therefore finish advancing before
// the first assessor attempt had even started, so its retry wait was
// scheduled after the advance and never fired: the test timed out, but only
// when it happened to be the first in its file to reach the assessor
// (ai-therapist-370, found with shuffled test order).
//
// Call this in beforeAll in such files: once loaded, later dynamic imports of
// the same modules resolve from the module cache without waiting on I/O, which
// is the state every test but the first one already ran in. Mocks registered
// with vi.mock in the test file apply here too, as they do to any importer.
export async function warmCrisisPathImports(): Promise<void> {
  await Promise.all([
    import('../utils/safetyIdentifier.js'),
    import('../utils/sessionHelpers.js'),
    import('../utils/adminBroadcast.js'),
    import('../db/index.js'),
    import('../services/crisisAlert.service.js'),
    import('../services/moderation.service.js'),
    import('../services/adverseEvent.service.js'),
    import('../services/crisisDetection.service.js'),
    import('../services/riskAssessorHealth.service.js'),
  ]);
}
