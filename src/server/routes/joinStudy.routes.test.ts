// /join-study — survey-driven enrollment. Covers: env gating (routes vanish
// when unconfigured), verification outcomes (unfinished/unknown/unavailable
// never provision), the atomic single-use claim, claim release on failed
// registration, and the session-fixation regenerate on success.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  claimQualtricsResponse: vi.fn(),
  releaseQualtricsClaim: vi.fn(),
  markQualtricsSignupRegistered: vi.fn(),
  findQualtricsSignup: vi.fn(),
  createUser: vi.fn(),
}));
vi.mock('../db/index.js', () => dbMocks);

const serviceMocks = vi.hoisted(() => ({
  verifyBaselineResponse: vi.fn(),
}));
vi.mock('../services/qualtrics.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/qualtrics.service.js')>();
  return { ...actual, verifyBaselineResponse: serviceMocks.verifyBaselineResponse };
});

import joinStudyRoutes from './joinStudy.routes.js';

const QID = 'R_1hB2c3D4e5F6g7H';
const USER = {
  userid: 7,
  username: 'newpart',
  role: 'participant',
  organization_id: 3,
  is_sandbox: false,
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use(joinStudyRoutes());
  app.use((_req, res) => res.status(404).send('not found'));
  return app;
}

function enableFeature() {
  process.env.QUALTRICS_API_TOKEN = 'tok';
  process.env.QUALTRICS_BASELINE_SURVEY_ID = 'SV_test';
  delete process.env.QUALTRICS_STUDY_ORG_ID;
}

beforeEach(() => {
  vi.clearAllMocks();
  enableFeature();
  dbMocks.findQualtricsSignup.mockResolvedValue(null);
  dbMocks.releaseQualtricsClaim.mockResolvedValue(undefined);
  dbMocks.markQualtricsSignupRegistered.mockResolvedValue(undefined);
  serviceMocks.verifyBaselineResponse.mockResolvedValue({ ok: true, finished: true });
  dbMocks.claimQualtricsResponse.mockResolvedValue({ signup_id: 11, response_id: QID });
  dbMocks.createUser.mockResolvedValue(USER);
});

describe('env gating', () => {
  it('falls through like an unknown route when unconfigured', async () => {
    delete process.env.QUALTRICS_API_TOKEN;
    const res = await request(makeApp()).get(`/join-study?qid=${QID}`);
    expect(res.status).toBe(404);
    expect(serviceMocks.verifyBaselineResponse).not.toHaveBeenCalled();
  });
});

describe('GET /join-study', () => {
  it('serves the registration page for a finished response', async () => {
    const res = await request(makeApp()).get(`/join-study?qid=${QID}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Create account');
  });

  it('rejects malformed qids without calling Qualtrics', async () => {
    const res = await request(makeApp()).get('/join-study?qid=not-a-response');
    expect(res.status).toBe(410);
    expect(serviceMocks.verifyBaselineResponse).not.toHaveBeenCalled();
  });

  it('shows already-used for a registered claim without calling Qualtrics', async () => {
    dbMocks.findQualtricsSignup.mockResolvedValue({ signup_id: 1, registered_at: '2026-09-02' });
    const res = await request(makeApp()).get(`/join-study?qid=${QID}`);
    expect(res.status).toBe(410);
    expect(res.text).toContain('already used');
    expect(serviceMocks.verifyBaselineResponse).not.toHaveBeenCalled();
  });

  it('shows not-verified for unknown or unfinished responses', async () => {
    serviceMocks.verifyBaselineResponse.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await request(makeApp()).get(`/join-study?qid=${QID}`)).status).toBe(410);

    serviceMocks.verifyBaselineResponse.mockResolvedValue({ ok: true, finished: false });
    expect((await request(makeApp()).get(`/join-study?qid=${QID}`)).status).toBe(410);
  });

  it('shows try-later (503) when Qualtrics is unreachable', async () => {
    serviceMocks.verifyBaselineResponse.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const res = await request(makeApp()).get(`/join-study?qid=${QID}`);
    expect(res.status).toBe(503);
  });
});

describe('POST /join-study', () => {
  const body = { username: 'newpart', password: 'longenough' };

  it('creates a participant, records the linkage, and logs in on a fresh session', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    const res = await agent.post(`/join-study?qid=${QID}`).send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(dbMocks.claimQualtricsResponse).toHaveBeenCalledWith(QID, 'SV_test');
    expect(dbMocks.createUser).toHaveBeenCalledWith('newpart', 'longenough', 'participant', {
      orgId: null,
    });
    expect(dbMocks.markQualtricsSignupRegistered).toHaveBeenCalledWith(11, USER.userid);
    // Logged in: a session cookie was set for the new participant.
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('passes QUALTRICS_STUDY_ORG_ID through to account creation', async () => {
    process.env.QUALTRICS_STUDY_ORG_ID = '42';
    await request(makeApp()).post(`/join-study?qid=${QID}`).send(body);
    expect(dbMocks.createUser).toHaveBeenCalledWith('newpart', 'longenough', 'participant', {
      orgId: 42,
    });
  });

  it('never claims or creates for unverified responses', async () => {
    serviceMocks.verifyBaselineResponse.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const res = await request(makeApp()).post(`/join-study?qid=${QID}`).send(body);
    expect(res.status).toBe(503);
    expect(dbMocks.claimQualtricsResponse).not.toHaveBeenCalled();
    expect(dbMocks.createUser).not.toHaveBeenCalled();
  });

  it('410s when the response was already claimed (single-use)', async () => {
    dbMocks.claimQualtricsResponse.mockResolvedValue(null);
    const res = await request(makeApp()).post(`/join-study?qid=${QID}`).send(body);
    expect(res.status).toBe(410);
    expect(dbMocks.createUser).not.toHaveBeenCalled();
  });

  it('releases the claim when the username is taken so the link stays usable', async () => {
    dbMocks.createUser.mockRejectedValue(new Error('Username already exists'));
    const res = await request(makeApp()).post(`/join-study?qid=${QID}`).send(body);
    expect(res.status).toBe(409);
    expect(dbMocks.releaseQualtricsClaim).toHaveBeenCalledWith(11);
  });

  it('validates the password length before touching anything', async () => {
    const res = await request(makeApp())
      .post(`/join-study?qid=${QID}`)
      .send({ username: 'x', password: 'short' });
    expect(res.status).toBe(400);
    expect(serviceMocks.verifyBaselineResponse).not.toHaveBeenCalled();
  });

  it('sheds prior-login session state (fixation regenerate)', async () => {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.post('/test/seed', (req, res) => {
      req.session.userId = 999;
      req.session.userRole = 'researcher';
      req.session.orgId = 55;
      res.json({ ok: true });
    });
    app.get('/test/session', (req, res) => {
      res.json({
        userId: req.session.userId ?? null,
        userRole: req.session.userRole ?? null,
        orgId: req.session.orgId ?? null,
      });
    });
    app.use(joinStudyRoutes());

    const agent = request.agent(app);
    await agent.post('/test/seed');
    await agent.post(`/join-study?qid=${QID}`).send(body);

    const state = await agent.get('/test/session');
    expect(state.body.userId).toBe(USER.userid);
    expect(state.body.userRole).toBe('participant');
    expect(state.body.orgId).toBe(USER.organization_id);
  });
});
