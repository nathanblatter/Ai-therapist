// IRB packet routes (ai-therapist-107): role matrix, sandbox 404, org scoping
// through orgIdFor, window validation, the audit row on HTML/zip (not JSON),
// and the zip's entry set.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  logDataAccess: vi.fn().mockResolvedValue(undefined),
  getOrganizationIdForUser: vi.fn().mockResolvedValue(1),
  getIrbStudyOrgId: vi.fn().mockResolvedValue(1),
  buildIrbPacket: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({
  logDataAccess: mocks.logDataAccess,
  getOrganizationIdForUser: mocks.getOrganizationIdForUser,
  getIrbStudyOrgId: mocks.getIrbStudyOrgId,
}));
vi.mock('../../services/irbPacket.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/irbPacket.service.js')>();
  return { ...real, buildIrbPacket: mocks.buildIrbPacket };
});

import irbPacketRoutes, { parseWindow } from './irbPacket.routes.js';
import type { IrbPacket } from '../../services/irbPacket.service.js';

function packetFor(from: string, to: string, orgId: number): IrbPacket {
  return {
    meta: {
      generated_at: '2026-10-23T00:00:00.000Z',
      git_sha: 'abc1234',
      period: { from, to },
      organization: { id: orgId, name: 'IRB Study', is_irb_study_org: orgId === 1 },
      sources: {},
    },
    study: {
      protocol_id: '2025-519-BYU',
      principal_investigator: 'PI',
      study_title: null,
      deployment_mode: 'research',
      enrollment_target: 40,
      expected_sessions_per_participant: 4,
      study_start: null,
      study_end: null,
    },
    enrollment: {
      enrolled_in_window: 0,
      enrolled_to_date: 0,
      active: 0,
      paused: 0,
      withdrawn: 0,
      completed: 0,
      withdrawn_in_window: 0,
      paused_in_window: 0,
      anonymous_sessions_in_window: 0,
      target: 40,
      arms: [],
    },
    sessions: { total: 0, ended: 0, mean_duration_minutes: null, by_session_type: [], by_modality: [] },
    safety: {
      crisis_events: [],
      flagged_sessions: { total: 0, unflagged_before_end: 0, still_flagged_at_end: 0, with_adverse_event_report: 0 },
      interventions: [],
      pages_sent: 0,
      escalations: [],
    },
    adverse_events: { total: 0, by_severity: {}, by_status: {}, by_category: {}, records: [] },
    deviations: { total: 0, by_severity: {}, by_status: {}, by_category: {}, records: [] },
    consent: { versions: [] },
    monitoring: {
      drift_alerts: { opened_in_window: 0, acknowledged_in_window: 0, open_at_end: 0, paged_in_window: 0 },
      harness_runs: [],
    },
    data_access: { counts: [], total: 0 },
    incidents: { records: [], note: 'fill by hand' },
  };
}

function appAs(session: Record<string, unknown> | null) {
  const app = express();
  app.use((req, _res, next) => {
    // Fresh copy per request: orgIdFor writes orgId back onto the session.
    (req as unknown as { session: Record<string, unknown> }).session = session ? { ...session } : {};
    next();
  });
  app.use(irbPacketRoutes());
  return app;
}
const researcher = (orgId = 1) => ({ userId: 9, userRole: 'researcher', username: 'res1', orgId });

/** Entry names from a zip buffer: every local-file-header signature. */
function zipEntryNames(buf: Buffer): string[] {
  const names: string[] = [];
  let i = 0;
  while ((i = buf.indexOf('PK\u0003\u0004', i, 'binary')) !== -1) {
    const nameLen = buf.readUInt16LE(i + 26);
    names.push(buf.subarray(i + 30, i + 30 + nameLen).toString('utf8'));
    i += 30 + nameLen;
  }
  return names;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrganizationIdForUser.mockResolvedValue(1);
  mocks.getIrbStudyOrgId.mockResolvedValue(1);
  mocks.buildIrbPacket.mockImplementation(async (input: { from: string; to: string; orgId: number }) =>
    packetFor(input.from, input.to, input.orgId),
  );
});

const QS = '?from=2025-10-01&to=2026-09-30';

describe('parseWindow', () => {
  it('defaults to the trailing 365 days ending now', () => {
    const w = parseWindow({});
    expect('error' in w).toBe(false);
    if ('error' in w) return;
    expect(new Date(w.to).getTime() - new Date(w.from).getTime()).toBe(365 * 24 * 60 * 60 * 1000);
  });
  it('widens a bare date `to` to end of day and `from` to start of day', () => {
    expect(parseWindow({ from: '2025-10-01', to: '2026-09-30' })).toEqual({
      from: '2025-10-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
    });
  });
  it('rejects garbage, inverted and over-long windows', () => {
    expect(parseWindow({ from: 'nope' })).toHaveProperty('error');
    expect(parseWindow({ to: '2026-13-45' })).toHaveProperty('error');
    expect(parseWindow({ from: '2026-09-30', to: '2025-10-01' })).toHaveProperty('error');
    expect(parseWindow({ from: '2024-01-01', to: '2026-09-30' })).toHaveProperty('error');
  });
});

describe('role matrix', () => {
  for (const path of ['/admin/api/irb/packet', '/admin/api/irb/packet.html', '/admin/api/irb/packet.zip']) {
    it(`${path}: 401 anonymous, 403 participant/therapist/caseworker, 404 sandbox, 200 researcher`, async () => {
      expect((await request(appAs(null)).get(path + QS)).status).toBe(401);
      for (const role of ['participant', 'therapist', 'caseworker', 'demo']) {
        expect(
          (await request(appAs({ userId: 2, userRole: role, username: 'u', orgId: 1 })).get(path + QS)).status,
        ).toBe(403);
      }
      const sb = await request(appAs({ ...researcher(), isSandbox: true })).get(path + QS);
      expect(sb.status).toBe(404);
      expect(mocks.buildIrbPacket).not.toHaveBeenCalled();
      expect((await request(appAs(researcher())).get(path + QS)).status).toBe(200);
    });
  }
});

describe('org scope', () => {
  it('builds for the session org, never a query-supplied one', async () => {
    const res = await request(appAs(researcher(5))).get('/admin/api/irb/packet' + QS + '&orgId=1');
    expect(res.status).toBe(200);
    expect(mocks.buildIrbPacket).toHaveBeenCalledWith({
      from: '2025-10-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      orgId: 5,
    });
    expect(res.body.meta.organization.id).toBe(5);
  });

  it('resolves a pre-069 session through the user row, and 500s (never widens) when resolution fails', async () => {
    const noOrg = { userId: 9, userRole: 'researcher', username: 'res1' };
    mocks.getOrganizationIdForUser.mockResolvedValueOnce(3);
    expect((await request(appAs(noOrg)).get('/admin/api/irb/packet' + QS)).status).toBe(200);
    expect(mocks.buildIrbPacket).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: 3 }));

    mocks.getOrganizationIdForUser.mockRejectedValueOnce(new Error('db down'));
    const res = await request(appAs(noOrg)).get('/admin/api/irb/packet' + QS);
    expect(res.status).toBe(500);
    expect(mocks.buildIrbPacket).toHaveBeenCalledTimes(1);
  });
});

describe('validation', () => {
  it('400s a bad window without building', async () => {
    const res = await request(appAs(researcher())).get('/admin/api/irb/packet?from=2026-09-30&to=2025-10-01');
    expect(res.status).toBe(400);
    expect(mocks.buildIrbPacket).not.toHaveBeenCalled();
    expect(mocks.logDataAccess).not.toHaveBeenCalled();
  });
});

describe('audit row', () => {
  it('JSON view writes no row; HTML and zip write exactly one export row each', async () => {
    await request(appAs(researcher())).get('/admin/api/irb/packet' + QS);
    expect(mocks.logDataAccess).not.toHaveBeenCalled();

    const html = await request(appAs(researcher())).get('/admin/api/irb/packet.html' + QS);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(mocks.logDataAccess).toHaveBeenCalledTimes(1);
    expect(mocks.logDataAccess).toHaveBeenCalledWith({
      accessedBy: 9,
      role: 'researcher',
      action: 'export',
      detail: { kind: 'irb_packet', format: 'html', from: '2025-10-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' },
    });

    await request(appAs(researcher()))
      .get('/admin/api/irb/packet.zip' + QS)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(mocks.logDataAccess).toHaveBeenCalledTimes(2);
    expect(mocks.logDataAccess).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ kind: 'irb_packet', format: 'zip' }) }),
    );
  });
});

describe('zip', () => {
  it('streams an attachment with packet.json, the three CSVs and README', async () => {
    const res = await request(appAs(researcher()))
      .get('/admin/api/irb/packet.zip' + QS)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="irb-packet-2025-10-01_2026-09-30.zip"');
    expect(zipEntryNames(res.body as Buffer)).toEqual([
      'packet.json',
      'adverse_events.csv',
      'deviations.csv',
      'consent_versions.csv',
      'README.md',
    ]);
  });
});

describe('html', () => {
  it('renders the header from the packet and never echoes the caller username', async () => {
    const res = await request(appAs(researcher())).get('/admin/api/irb/packet.html' + QS);
    expect(res.text).toContain('2025-519-BYU');
    expect(res.text).toContain('2025-10-01 to 2026-09-30');
    expect(res.text).not.toContain('res1');
  });

  it('500s cleanly when the build fails', async () => {
    mocks.buildIrbPacket.mockRejectedValueOnce(new Error('boom'));
    const res = await request(appAs(researcher())).get('/admin/api/irb/packet.html' + QS);
    expect(res.status).toBe(500);
    expect(mocks.logDataAccess).not.toHaveBeenCalled();
  });
});
