// Recording egress (ai-therapist-199 item 4): `?download=1` serves the whole
// object as an attachment and is audited as 'recording_download', distinct from
// the range-streamed playback rows ('recording_stream').
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';

const { logDataAccessMock, getSessionRecordingMock, headObjectMock, getObjectStreamMock } = vi.hoisted(() => ({
  logDataAccessMock: vi.fn(),
  getSessionRecordingMock: vi.fn(),
  headObjectMock: vi.fn(),
  getObjectStreamMock: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  logDataAccess: logDataAccessMock,
  // The rest of the barrel is irrelevant to this route; proxies keep the
  // module importable without enumerating every export.
  getSessionWithUser: vi.fn(), getAdminSessionMessages: vi.fn(), listSessions: vi.fn(),
  getActiveSessions: vi.fn(), updateSessionStatus: vi.fn(), insertMessagesBatch: vi.fn(),
  getSessionCostSummary: vi.fn(), getSessionFeedback: vi.fn(), getSessionAccessInfo: vi.fn(),
  getRedactionStatus: vi.fn(), getSessionMessages: vi.fn(), endSession: vi.fn(),
  getUserSessions: vi.fn(), getSessionConfig: vi.fn(), getSessionCheckin: vi.fn(),
}));
vi.mock('../../db/recording.queries.js', () => ({ getSessionRecording: getSessionRecordingMock }));
vi.mock('../../config/objectStorage.js', () => ({ headObject: headObjectMock, getObjectStream: getObjectStreamMock }));
vi.mock('../../middleware/auth.js', () => ({
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFullContent: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../middleware/caseload.js', () => ({
  requireSessionClientAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireMessageClientAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  careTeamScopeId: () => null,
}));
vi.mock('../../middleware/org.js', () => ({ orgIdFor: async () => 1 }));
vi.mock('../../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn() }));
vi.mock('../../services/sessionName.service.js', () => ({ generateSessionNameAsync: vi.fn() }));

import adminSessionsRoutes from './sessions.routes.js';

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: 7, userRole: 'therapist' } as unknown as typeof req.session;
    next();
  });
  app.use(adminSessionsRoutes());
  return app;
}

const WAV = Buffer.from('RIFF....WAVEfmt ');

beforeEach(() => {
  vi.clearAllMocks();
  getSessionRecordingMock.mockResolvedValue({ status: 'ready', objectKey: 'sessions/s1/recording.wav' });
  headObjectMock.mockResolvedValue({ contentLength: WAV.length, contentType: 'audio/wav' });
  getObjectStreamMock.mockImplementation(async (_key: string, range?: { start: number; end: number }) => ({
    body: Readable.from([range ? WAV.subarray(range.start, range.end + 1) : WAV]),
  }));
});

describe('GET /admin/api/sessions/:sessionId/recording', () => {
  it('download=1 serves the whole file as an attachment and audits recording_download', async () => {
    const res = await request(makeApp()).get('/admin/api/sessions/s1/recording?download=1').set('Range', 'bytes=0-3');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="session-s1.wav"');
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(Number(res.headers['content-length'])).toBe(WAV.length);
    // The Range header is ignored for a download: the whole object is sent.
    expect(getObjectStreamMock).toHaveBeenCalledWith('sessions/s1/recording.wav');
    expect(logDataAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      accessedBy: 7, role: 'therapist', action: 'recording_download', sessionId: 's1',
    }));
  });

  it('a plain request streams inline and audits recording_stream with the range', async () => {
    const res = await request(makeApp()).get('/admin/api/sessions/s1/recording').set('Range', 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['content-range']).toBe(`bytes 0-3/${WAV.length}`);
    expect(logDataAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recording_stream', detail: { range: 'bytes=0-3' },
    }));
  });

  it('404s when no recording is ready, without an audit row', async () => {
    getSessionRecordingMock.mockResolvedValueOnce({ status: 'pending', objectKey: null });
    const res = await request(makeApp()).get('/admin/api/sessions/s1/recording?download=1');
    expect(res.status).toBe(404);
    expect(logDataAccessMock).not.toHaveBeenCalled();
  });
});
