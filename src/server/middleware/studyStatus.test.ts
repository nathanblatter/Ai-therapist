import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { getStudyStatusMock } = vi.hoisted(() => ({ getStudyStatusMock: vi.fn() }));
vi.mock('../db/studyStatus.queries.js', () => ({ getStudyStatus: getStudyStatusMock }));

import { dropIfWithdrawn, isWithdrawnParticipant, refuseIfWithdrawn, requireActiveStudyStatus } from './studyStatus.js';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.sendStatus = vi.fn().mockReturnValue(res);
  return res as Response;
}

const participant = (extra: Record<string, unknown> = {}) =>
  ({ session: { userId: 42, userRole: 'participant', ...extra } }) as unknown as Request;

beforeEach(() => {
  getStudyStatusMock.mockReset();
  getStudyStatusMock.mockResolvedValue('active');
});

describe('isWithdrawnParticipant', () => {
  it('is true only for a logged-in participant whose status is withdrawn', async () => {
    getStudyStatusMock.mockResolvedValue('withdrawn');
    expect(await isWithdrawnParticipant(participant())).toBe(true);
    getStudyStatusMock.mockResolvedValue('paused');
    expect(await isWithdrawnParticipant(participant())).toBe(false);
    getStudyStatusMock.mockResolvedValue('active');
    expect(await isWithdrawnParticipant(participant())).toBe(false);
  });

  it('never applies to staff, sandbox users or anonymous browsers (no lookup at all)', async () => {
    getStudyStatusMock.mockResolvedValue('withdrawn');
    expect(await isWithdrawnParticipant(participant({ userRole: 'researcher' }))).toBe(false);
    expect(await isWithdrawnParticipant(participant({ isSandbox: true }))).toBe(false);
    expect(await isWithdrawnParticipant({ session: {} } as unknown as Request)).toBe(false);
    expect(getStudyStatusMock).not.toHaveBeenCalled();
  });

  it('fails open on a lookup error, like the start gate', async () => {
    getStudyStatusMock.mockRejectedValue(new Error('db down'));
    expect(await isWithdrawnParticipant(participant())).toBe(false);
  });
});

describe('dropIfWithdrawn (beacons and uploads)', () => {
  it('answers 204 and stops the chain for a withdrawn participant', async () => {
    getStudyStatusMock.mockResolvedValue('withdrawn');
    const res = mockRes();
    const next = vi.fn();
    await dropIfWithdrawn(participant(), res, next);
    expect(res.sendStatus).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes everyone else through', async () => {
    const res = mockRes();
    const next = vi.fn();
    await dropIfWithdrawn(participant(), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.sendStatus).not.toHaveBeenCalled();
  });
});

describe('refuseIfWithdrawn (deliberate submissions)', () => {
  it('refuses a withdrawn participant with 403 study_status and a plain message', async () => {
    getStudyStatusMock.mockResolvedValue('withdrawn');
    const res = mockRes();
    const next = vi.fn();
    await refuseIfWithdrawn(participant(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const body = vi.mocked(res.json).mock.calls[0][0] as { error: string; studyStatus: string; message: string };
    expect(body.error).toBe('study_status');
    expect(body.studyStatus).toBe('withdrawn');
    expect(body.message).toMatch(/no longer saves study responses/);
    expect(body.message).toMatch(/crisis resources/);
  });

  it('lets a paused participant submit (pausing is not withdrawing consent)', async () => {
    getStudyStatusMock.mockResolvedValue('paused');
    const next = vi.fn();
    await refuseIfWithdrawn(participant(), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('requireActiveStudyStatus (session start)', () => {
  it('still refuses paused and withdrawn participants with 403', async () => {
    for (const status of ['paused', 'withdrawn']) {
      getStudyStatusMock.mockResolvedValue(status);
      const res = mockRes();
      const next = vi.fn();
      await requireActiveStudyStatus(participant(), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });
});
