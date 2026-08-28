// Care notes API tests (caseworker portal slice B): caseworker note_type
// restriction, draft->sign immutability (409s), amendments, sharing,
// requireNoteAccess visibility (404-over-403, caseworker shared-progress
// rule), and the AI-SOAP seeding flow with its note_awaiting_signature
// work item + idempotency.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  // careNotes.queries
  createCareNote: vi.fn(),
  getCareNoteById: vi.fn(),
  listCareNotesForClient: vi.fn(),
  updateCareNoteDraft: vi.fn(),
  deleteCareNoteDraft: vi.fn(),
  signCareNote: vi.fn(),
  createCareNoteAmendment: vi.fn(),
  setCareNoteShared: vi.fn(),
  getLiveProgressNoteForSession: vi.fn(),
  // insights / sessions / users
  getSessionInsights: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  getUserById: vi.fn(),
  markSoapReviewed: vi.fn(),
  // workQueue.queries
  insertWorkItem: vi.fn(),
  expireWorkItemsBySource: vi.fn(),
  // imported by middleware/caseload.ts, middleware/org.ts, utils/adminBroadcast.ts
  isAssigned: vi.fn(),
  getMessageOwner: vi.fn(),
  getEscalationById: vi.fn(),
  getOrganizationIdForUser: vi.fn(),
  getTherapistIdsForClient: vi.fn(),
  getCaseworkerIdsForClient: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import notesRoutes from './notes.routes.js';

const CLIENT = { userid: 42, username: 'p42', role: 'participant', organization_id: 5, is_sandbox: false };

function baseNote(overrides: Record<string, unknown> = {}) {
  return {
    note_id: 21,
    org_id: 5,
    client_id: 42,
    author_id: 9,
    author_name: 'user9',
    author_role: 'therapist',
    note_type: 'progress',
    case_note_kind: null,
    session_id: null,
    seed_source: null,
    seed_model: null,
    content: { subjective: 'S', plan: 'P' },
    status: 'draft',
    shared_with_care_team: false,
    signed_at: null,
    sign_hash: null,
    amends_note_id: null,
    created_at: '2026-08-27T00:00:00Z',
    updated_at: '2026-08-27T00:00:00Z',
    ...overrides,
  };
}

function appAs(role: string | null, userId = 9) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: `user${userId}` }
      : {};
    next();
  });
  app.use(notesRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.isAssigned.mockResolvedValue(true);
  dbMocks.getUserById.mockResolvedValue(CLIENT);
  dbMocks.getOrganizationIdForUser.mockResolvedValue(5);
  dbMocks.getTherapistIdsForClient.mockResolvedValue([9]);
  dbMocks.getCaseworkerIdsForClient.mockResolvedValue([2]);
  dbMocks.insertWorkItem.mockResolvedValue({ item_id: 1 });
  dbMocks.expireWorkItemsBySource.mockResolvedValue([]);
  dbMocks.markSoapReviewed.mockResolvedValue(true);
});

describe('POST /admin/api/users/:userId/notes', () => {
  it('creates a progress-note draft for a therapist', async () => {
    dbMocks.createCareNote.mockResolvedValue(baseNote());
    const res = await request(appAs('therapist', 9))
      .post('/admin/api/users/42/notes')
      .send({ note_type: 'progress', content: { subjective: 'S', plan: 'P' } });
    expect(res.status).toBe(201);
    expect(dbMocks.createCareNote).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 5, clientId: 42, authorId: 9, authorRole: 'therapist',
        noteType: 'progress', content: { subjective: 'S', plan: 'P' },
      })
    );
  });

  it('creates a case-note draft for a caseworker (kind defaults to other)', async () => {
    dbMocks.createCareNote.mockResolvedValue(baseNote({ note_type: 'case', author_role: 'caseworker', author_id: 2 }));
    const res = await request(appAs('caseworker', 2))
      .post('/admin/api/users/42/notes')
      .send({ note_type: 'case', content: { narrative: 'Called client, left voicemail' } });
    expect(res.status).toBe(201);
    expect(dbMocks.createCareNote).toHaveBeenCalledWith(
      expect.objectContaining({ noteType: 'case', authorRole: 'caseworker', caseNoteKind: 'other' })
    );
  });

  it('400s a caseworker attempting a progress note', async () => {
    const res = await request(appAs('caseworker', 2))
      .post('/admin/api/users/42/notes')
      .send({ note_type: 'progress', content: { subjective: 'S' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/case notes only/i);
    expect(dbMocks.createCareNote).not.toHaveBeenCalled();
  });

  it('400s invalid content shapes (empty SOAP, missing narrative, bad kind)', async () => {
    const app = appAs('therapist', 9);
    expect((await request(app).post('/admin/api/users/42/notes').send({ note_type: 'progress', content: {} })).status).toBe(400);
    expect((await request(app).post('/admin/api/users/42/notes').send({ note_type: 'case', content: {} })).status).toBe(400);
    expect((await request(app).post('/admin/api/users/42/notes').send({ note_type: 'case', case_note_kind: 'bogus', content: { narrative: 'x' } })).status).toBe(400);
    expect((await request(app).post('/admin/api/users/42/notes').send({ note_type: 'nope', content: {} })).status).toBe(400);
  });

  it('404s when the client is not on the author caseload', async () => {
    dbMocks.isAssigned.mockResolvedValue(false);
    const res = await request(appAs('therapist', 9))
      .post('/admin/api/users/42/notes')
      .send({ note_type: 'progress', content: { subjective: 'S' } });
    expect(res.status).toBe(404);
  });

  it('400s a session_id owned by a different client (cross-client attach)', async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'ended', user_id: 77, session_type: 'voice' });
    const res = await request(appAs('therapist', 9))
      .post('/admin/api/users/42/notes')
      .send({ note_type: 'progress', session_id: 'sess-x', content: { subjective: 'S' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong/i);
    expect(dbMocks.createCareNote).not.toHaveBeenCalled();
  });

  it('400s a session_id that does not exist or has no logged-in owner', async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue(null);
    expect((await request(appAs('therapist', 9))
      .post('/admin/api/users/42/notes')
      .send({ note_type: 'progress', session_id: 'missing', content: { subjective: 'S' } })).status).toBe(400);
    dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'ended', user_id: null, session_type: 'voice' });
    expect((await request(appAs('therapist', 9))
      .post('/admin/api/users/42/notes')
      .send({ note_type: 'progress', session_id: 'anon', content: { subjective: 'S' } })).status).toBe(400);
    expect(dbMocks.createCareNote).not.toHaveBeenCalled();
  });

  it("accepts a session_id owned by the client and passes it through", async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'ended', user_id: 42, session_type: 'voice' });
    dbMocks.createCareNote.mockResolvedValue(baseNote({ session_id: 'sess-1' }));
    const res = await request(appAs('therapist', 9))
      .post('/admin/api/users/42/notes')
      .send({ note_type: 'progress', session_id: 'sess-1', content: { subjective: 'S' } });
    expect(res.status).toBe(201);
    expect(dbMocks.createCareNote).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }));
  });

  it('409s (not 500) a duplicate live-progress-note conflict', async () => {
    dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'ended', user_id: 42, session_type: 'voice' });
    dbMocks.createCareNote.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const res = await request(appAs('therapist', 9))
      .post('/admin/api/users/42/notes')
      .send({ note_type: 'progress', session_id: 'sess-1', content: { subjective: 'S' } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('is care-team only (researchers 403)', async () => {
    expect((await request(appAs('researcher', 7)).post('/admin/api/users/42/notes').send({})).status).toBe(403);
  });
});

describe('GET /admin/api/users/:userId/notes', () => {
  it('lists with the caller as viewer (role drives visibility SQL)', async () => {
    dbMocks.listCareNotesForClient.mockResolvedValue([baseNote()]);
    const res = await request(appAs('caseworker', 2)).get('/admin/api/users/42/notes');
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(dbMocks.listCareNotesForClient).toHaveBeenCalledWith(42, { userId: 2, role: 'caseworker' });
  });
});

describe('GET /admin/api/notes/:noteId (requireNoteAccess)', () => {
  it('404s caseworkers on unshared progress notes they did not author', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ status: 'signed' }));
    expect((await request(appAs('caseworker', 2)).get('/admin/api/notes/21')).status).toBe(404);
  });

  it('returns shared progress notes to care-team caseworkers', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ status: 'signed', shared_with_care_team: true }));
    const res = await request(appAs('caseworker', 2)).get('/admin/api/notes/21');
    expect(res.status).toBe(200);
    expect(res.body.note.note_id).toBe(21);
  });

  it('404s researchers (notes blocked v1) without loading visibility', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote());
    expect((await request(appAs('researcher', 7)).get('/admin/api/notes/21')).status).toBe(404);
  });
});

describe('PUT /admin/api/notes/:noteId', () => {
  it('updates the author own draft', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote());
    dbMocks.updateCareNoteDraft.mockResolvedValue(baseNote({ content: { subjective: 'S2' } }));
    const res = await request(appAs('therapist', 9))
      .put('/admin/api/notes/21')
      .send({ content: { subjective: 'S2' } });
    expect(res.status).toBe(200);
    expect(dbMocks.updateCareNoteDraft).toHaveBeenCalledWith(21, 9, expect.objectContaining({ content: { subjective: 'S2' } }));
  });

  it('403s a care-team therapist who is not the author', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ author_id: 8 }));
    const res = await request(appAs('therapist', 9)).put('/admin/api/notes/21').send({ content: { plan: 'x' } });
    expect(res.status).toBe(403);
    expect(dbMocks.updateCareNoteDraft).not.toHaveBeenCalled();
  });

  it('supports explicitly clearing case_note_kind with null', async () => {
    const caseNote = baseNote({ note_type: 'case', author_role: 'caseworker', author_id: 2, case_note_kind: 'referral' });
    dbMocks.getCareNoteById.mockResolvedValue(caseNote);
    dbMocks.updateCareNoteDraft.mockResolvedValue({ ...caseNote, case_note_kind: null });
    const res = await request(appAs('caseworker', 2))
      .put('/admin/api/notes/21')
      .send({ case_note_kind: null });
    expect(res.status).toBe(200);
    expect(dbMocks.updateCareNoteDraft).toHaveBeenCalledWith(21, 2, expect.objectContaining({ caseNoteKind: null }));
  });

  it('still 400s a null kind on a progress note and bogus kinds on case notes', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote()); // progress
    expect((await request(appAs('therapist', 9)).put('/admin/api/notes/21').send({ case_note_kind: null })).status).toBe(400);
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ note_type: 'case', author_role: 'caseworker', author_id: 2 }));
    expect((await request(appAs('caseworker', 2)).put('/admin/api/notes/21').send({ case_note_kind: 'bogus' })).status).toBe(400);
    expect(dbMocks.updateCareNoteDraft).not.toHaveBeenCalled();
  });

  it('409s edits to a signed note (immutable; amend instead)', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ status: 'signed' }));
    const res = await request(appAs('therapist', 9)).put('/admin/api/notes/21').send({ content: { plan: 'x' } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/amend/i);
  });
});

describe('DELETE /admin/api/notes/:noteId', () => {
  it('deletes the author own draft', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote());
    dbMocks.deleteCareNoteDraft.mockResolvedValue(true);
    const res = await request(appAs('therapist', 9)).delete('/admin/api/notes/21');
    expect(res.status).toBe(200);
    expect(dbMocks.deleteCareNoteDraft).toHaveBeenCalledWith(21, 9);
  });

  it('409s deleting a signed note', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ status: 'signed' }));
    expect((await request(appAs('therapist', 9)).delete('/admin/api/notes/21')).status).toBe(409);
    expect(dbMocks.deleteCareNoteDraft).not.toHaveBeenCalled();
  });
});

describe('POST /admin/api/notes/:noteId/sign', () => {
  it('signs the author draft and expires its awaiting-signature work item', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote());
    dbMocks.signCareNote.mockResolvedValue(baseNote({ status: 'signed', signed_at: '2026-08-27T01:00:00Z', sign_hash: 'abc' }));
    const res = await request(appAs('therapist', 9)).post('/admin/api/notes/21/sign');
    expect(res.status).toBe(200);
    expect(res.body.note.status).toBe('signed');
    expect(dbMocks.expireWorkItemsBySource).toHaveBeenCalledWith('note_awaiting_signature', 'care_notes', ['21']);
    expect(dbMocks.markSoapReviewed).not.toHaveBeenCalled();
  });

  it('marks the AI SOAP draft reviewed when signing a seeded note', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ seed_source: 'ai_soap', session_id: 'sess-1' }));
    dbMocks.signCareNote.mockResolvedValue(
      baseNote({ status: 'signed', seed_source: 'ai_soap', session_id: 'sess-1' })
    );
    const res = await request(appAs('therapist', 9)).post('/admin/api/notes/21/sign');
    expect(res.status).toBe(200);
    expect(dbMocks.markSoapReviewed).toHaveBeenCalledWith('sess-1', 'user9');
  });

  it('403s non-authors and 409s already-signed notes', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ author_id: 8 }));
    expect((await request(appAs('therapist', 9)).post('/admin/api/notes/21/sign')).status).toBe(403);
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ status: 'signed' }));
    expect((await request(appAs('therapist', 9)).post('/admin/api/notes/21/sign')).status).toBe(409);
    expect(dbMocks.signCareNote).not.toHaveBeenCalled();
  });

  it('409s a lost signing race', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote());
    dbMocks.signCareNote.mockResolvedValue(null);
    expect((await request(appAs('therapist', 9)).post('/admin/api/notes/21/sign')).status).toBe(409);
  });
});

describe('POST /admin/api/notes/:noteId/amend', () => {
  it('starts an amendment draft of the author signed note', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ status: 'signed' }));
    dbMocks.createCareNoteAmendment.mockResolvedValue(baseNote({ note_id: 22, amends_note_id: 21 }));
    const res = await request(appAs('therapist', 9)).post('/admin/api/notes/21/amend');
    expect(res.status).toBe(201);
    expect(res.body.note.amends_note_id).toBe(21);
  });

  it('409s amending a draft', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote());
    expect((await request(appAs('therapist', 9)).post('/admin/api/notes/21/amend')).status).toBe(409);
  });
});

describe('POST /admin/api/notes/:noteId/share', () => {
  it('toggles sharing on the author progress note', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ status: 'signed' }));
    dbMocks.setCareNoteShared.mockResolvedValue(baseNote({ status: 'signed', shared_with_care_team: true }));
    const res = await request(appAs('therapist', 9)).post('/admin/api/notes/21/share').send({ shared: true });
    expect(res.status).toBe(200);
    expect(dbMocks.setCareNoteShared).toHaveBeenCalledWith(21, 9, true);
  });

  it('400s sharing a case note (always care-team visible)', async () => {
    dbMocks.getCareNoteById.mockResolvedValue(baseNote({ note_type: 'case', author_role: 'caseworker', author_id: 2 }));
    expect((await request(appAs('caseworker', 2)).post('/admin/api/notes/21/share').send({ shared: true })).status).toBe(400);
  });
});

describe('POST /admin/api/sessions/:sessionId/notes/from-insights', () => {
  beforeEach(() => {
    dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'ended', user_id: 42, session_type: 'text' });
    dbMocks.getLiveProgressNoteForSession.mockResolvedValue(null);
    dbMocks.getSessionInsights.mockResolvedValue({
      session_id: 'sess-1',
      soap_note: { subjective: 'S', objective: 'O', assessment: 'A', plan: 'P' },
      model: 'test-model',
    });
  });

  it('seeds a progress-note draft from the AI SOAP and enqueues note_awaiting_signature', async () => {
    dbMocks.createCareNote.mockResolvedValue(baseNote({ seed_source: 'ai_soap', session_id: 'sess-1' }));
    const res = await request(appAs('therapist', 9)).post('/admin/api/sessions/sess-1/notes/from-insights');
    expect(res.status).toBe(201);
    expect(res.body.existing).toBe(false);
    expect(dbMocks.createCareNote).toHaveBeenCalledWith(
      expect.objectContaining({
        noteType: 'progress', seedSource: 'ai_soap', seedModel: 'test-model',
        sessionId: 'sess-1', clientId: 42,
        content: { subjective: 'S', objective: 'O', assessment: 'A', plan: 'P' },
      })
    );
    expect(dbMocks.insertWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: 'note_awaiting_signature', assigneeId: 9, sourceTable: 'care_notes', sourceId: '21',
      })
    );
  });

  it('is idempotent: returns the existing live progress note', async () => {
    dbMocks.getLiveProgressNoteForSession.mockResolvedValue(baseNote({ session_id: 'sess-1' }));
    const res = await request(appAs('therapist', 9)).post('/admin/api/sessions/sess-1/notes/from-insights');
    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(true);
    expect(dbMocks.createCareNote).not.toHaveBeenCalled();
  });

  it('recovers from the unique-index race by returning the winner', async () => {
    dbMocks.createCareNote.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    dbMocks.getLiveProgressNoteForSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(baseNote({ session_id: 'sess-1' }));
    const res = await request(appAs('therapist', 9)).post('/admin/api/sessions/sess-1/notes/from-insights');
    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(true);
  });

  it('422s when there is no AI SOAP draft or no logged-in participant', async () => {
    dbMocks.getSessionInsights.mockResolvedValue(null);
    expect((await request(appAs('therapist', 9)).post('/admin/api/sessions/sess-1/notes/from-insights')).status).toBe(422);
    dbMocks.getSessionInsights.mockResolvedValue({ soap_note: { plan: 'P' } });
    dbMocks.getSessionAccessInfo.mockResolvedValue({ status: 'ended', user_id: null, session_type: 'text' });
    // Care-team session gate 404s null-owner sessions before the handler.
    expect((await request(appAs('therapist', 9)).post('/admin/api/sessions/sess-1/notes/from-insights')).status).toBe(404);
  });

  it('is therapist-only (caseworkers 403)', async () => {
    expect((await request(appAs('caseworker', 2)).post('/admin/api/sessions/sess-1/notes/from-insights')).status).toBe(403);
  });
});
