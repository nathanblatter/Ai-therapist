// IRB packet service (ai-therapist-107): composition over mocked queries,
// arm split, empty-data rendering, identifier scrubbing and HTML escaping.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const q = vi.hoisted(() => ({
  getIrbEnrollmentCounts: vi.fn(),
  getIrbArmCounts: vi.fn(),
  getIrbSessionCounts: vi.fn(),
  getIrbSafetyCounts: vi.fn(),
  getIrbAdverseEvents: vi.fn(),
  getIrbDeviations: vi.fn(),
  getIrbConsentVersions: vi.fn(),
  getIrbMonitoringCounts: vi.fn(),
  getIrbDataAccessCounts: vi.fn(),
}));
const cfg = vi.hoisted(() => ({
  getStudyProtocol: vi.fn(),
  getSystemConfigByKey: vi.fn(),
  getIrbStudyOrgId: vi.fn(),
  getOrganizationById: vi.fn(),
}));

vi.mock('../db/irbPacket.queries.js', () => q);
vi.mock('../db/studyOps.queries.js', () => ({ getStudyProtocol: cfg.getStudyProtocol }));
vi.mock('../db/config.queries.js', () => ({ getSystemConfigByKey: cfg.getSystemConfigByKey }));
vi.mock('../db/organizations.queries.js', () => ({
  getIrbStudyOrgId: cfg.getIrbStudyOrgId,
  getOrganizationById: cfg.getOrganizationById,
}));
vi.mock('../utils/gitSha.js', () => ({ gitSha: () => 'abc1234' }));

import {
  buildIrbPacket,
  buildIrbPacketFiles,
  renderIrbPacketHtml,
  scrubIdentifiers,
  INCIDENTS_NOTE,
  type IrbPacket,
} from './irbPacket.service.js';

const FROM = '2025-10-01T00:00:00.000Z';
const TO = '2026-09-30T23:59:59.999Z';

const EMPTY = {
  enrollment: {
    enrolled_in_window: 0, enrolled_to_date: 0, active: 0, paused: 0, withdrawn: 0, completed: 0,
    withdrawn_in_window: 0, paused_in_window: 0, anonymous_sessions_in_window: 0,
  },
  sessions: { total: 0, ended: 0, mean_duration_minutes: null, by_session_type: [], by_modality: [] },
  safety: {
    crisis_events: [],
    flagged_sessions: { total: 0, unflagged_before_end: 0, still_flagged_at_end: 0, with_adverse_event_report: 0 },
    interventions: [], pages_sent: 0, escalations: [],
  },
  monitoring: { drift_alerts: { opened_in_window: 0, acknowledged_in_window: 0, open_at_end: 0, paged_in_window: 0 }, harness_runs: [] },
};

function primeEmpty() {
  q.getIrbEnrollmentCounts.mockResolvedValue(EMPTY.enrollment);
  q.getIrbArmCounts.mockResolvedValue([]);
  q.getIrbSessionCounts.mockResolvedValue(EMPTY.sessions);
  q.getIrbSafetyCounts.mockResolvedValue(EMPTY.safety);
  q.getIrbAdverseEvents.mockResolvedValue([]);
  q.getIrbDeviations.mockResolvedValue([]);
  q.getIrbConsentVersions.mockResolvedValue([]);
  q.getIrbMonitoringCounts.mockResolvedValue(EMPTY.monitoring);
  q.getIrbDataAccessCounts.mockResolvedValue([]);
  cfg.getStudyProtocol.mockResolvedValue({
    enrollment_target: 40, expected_sessions_per_participant: 4, study_start: null, study_end: null,
    arm_imbalance_threshold: 0.15, protocol_id: '2025-519-BYU', principal_investigator: 'Prof. Example',
  });
  cfg.getSystemConfigByKey.mockImplementation(async (key: string) => {
    if (key === 'study_protocol') return { config_key: key, config_value: { protocol_id: '2025-519-BYU', principal_investigator: 'Prof. Example', study_title: '  ' } };
    if (key === 'deployment_mode') return { config_key: key, config_value: { mode: 'research' } };
    return null;
  });
  cfg.getIrbStudyOrgId.mockResolvedValue(1);
  cfg.getOrganizationById.mockResolvedValue({ org_id: 1, slug: 'irb-study', name: 'IRB Study' });
}

beforeEach(() => {
  vi.clearAllMocks();
  primeEmpty();
});

describe('buildIrbPacket', () => {
  it('passes the window + org scope to every query, and includes unattributed rows only for the IRB org', async () => {
    await buildIrbPacket({ from: FROM, to: TO, orgId: 1, generatedAt: '2026-10-23T00:00:00.000Z' });
    const w = { from: FROM, to: TO, orgId: 1, includeUnattributed: true };
    expect(q.getIrbEnrollmentCounts).toHaveBeenCalledWith(w, 4);
    for (const fn of [q.getIrbArmCounts, q.getIrbSessionCounts, q.getIrbSafetyCounts, q.getIrbAdverseEvents,
      q.getIrbDeviations, q.getIrbConsentVersions, q.getIrbMonitoringCounts, q.getIrbDataAccessCounts]) {
      expect(fn).toHaveBeenCalledWith(w);
    }

    vi.clearAllMocks();
    primeEmpty();
    cfg.getOrganizationById.mockResolvedValue({ org_id: 7, slug: 'clinic', name: 'Clinic' });
    const p = await buildIrbPacket({ from: FROM, to: TO, orgId: 7 });
    expect(q.getIrbSafetyCounts).toHaveBeenCalledWith({ from: FROM, to: TO, orgId: 7, includeUnattributed: false });
    expect(p.meta.organization).toEqual({ id: 7, name: 'Clinic', is_irb_study_org: false });
  });

  it('builds a complete, NaN-free packet on empty data with the hand-written incidents note', async () => {
    const p = await buildIrbPacket({ from: FROM, to: TO, orgId: 1, generatedAt: '2026-10-23T00:00:00.000Z' });
    expect(p.meta).toMatchObject({ generated_at: '2026-10-23T00:00:00.000Z', git_sha: 'abc1234', period: { from: FROM, to: TO } });
    expect(p.study).toMatchObject({
      protocol_id: '2025-519-BYU', principal_investigator: 'Prof. Example', study_title: null,
      deployment_mode: 'research', enrollment_target: 40, expected_sessions_per_participant: 4,
    });
    expect(p.enrollment).toMatchObject({ ...EMPTY.enrollment, target: 40, arms: [] });
    expect(p.adverse_events).toEqual({ total: 0, by_severity: {}, by_status: {}, by_category: {}, records: [] });
    expect(p.deviations).toEqual({ total: 0, by_severity: {}, by_status: {}, by_category: {}, records: [] });
    expect(p.consent.versions).toEqual([]);
    expect(p.data_access).toEqual({ counts: [], total: 0 });
    expect(p.incidents).toEqual({ records: [], note: INCIDENTS_NOTE });
    expect(JSON.stringify(p)).not.toMatch(/NaN|undefined/);
    // Every section lists its source.
    for (const k of ['enrollment', 'sessions', 'safety', 'adverse_events', 'deviations', 'consent', 'monitoring', 'data_access', 'incidents']) {
      expect(p.meta.sources[k]).toBeTruthy();
    }
  });

  it('projects adverse events and deviations as records without identifiers, with tallies and resolution', async () => {
    q.getIrbAdverseEvents.mockResolvedValue([
      {
        report_id: 5, occurred_at: new Date('2026-03-01T10:00:00Z'), severity: 'high', category: 'crisis',
        trigger_source: 'auto_crisis_flag', status: 'closed', summary: 'Auto-drafted from flag for participant 42 (jane@example.com)',
        submitted_at: new Date('2026-03-02T10:00:00Z'), closed_at: new Date('2026-03-05T10:00:00Z'), last_action: 'clinician_review',
      },
      {
        report_id: 6, occurred_at: new Date('2026-04-01T10:00:00Z'), severity: 'medium', category: 'survey_report',
        trigger_source: 'auto_survey', status: 'draft', summary: 'Survey item', submitted_at: null, closed_at: null, last_action: null,
      },
    ]);
    q.getIrbDeviations.mockResolvedValue([
      { deviation_id: 9, occurred_at: new Date('2026-02-01T00:00:00Z'), source: 'auto', category: 'session_limit_exceeded',
        severity: 'minor', status: 'resolved', description: 'Participant 17 has 9 in-study sessions', resolved_at: new Date('2026-02-03T00:00:00Z') },
    ]);
    const p = await buildIrbPacket({ from: FROM, to: TO, orgId: 1 });
    expect(p.adverse_events.total).toBe(2);
    expect(p.adverse_events.by_severity).toEqual({ high: 1, medium: 1 });
    expect(p.adverse_events.by_status).toEqual({ closed: 1, draft: 1 });
    expect(p.adverse_events.records[0]).toMatchObject({
      report_id: 5, occurred_at: '2026-03-01T10:00:00.000Z', status: 'closed',
      summary: 'Auto-drafted from flag for participant [id] ([email])', resolution: 'closed (last action: clinician_review)',
      closed_at: '2026-03-05T10:00:00.000Z',
    });
    expect(p.adverse_events.records[1].resolution).toBe('draft - not yet submitted');
    expect(Object.keys(p.adverse_events.records[0])).not.toEqual(expect.arrayContaining(['participant_ref', 'user_id', 'session_id', 'transcript_excerpt']));
    expect(p.deviations.records[0]).toMatchObject({ deviation_id: 9, description: 'Participant [id] has 9 in-study sessions', resolved_at: '2026-02-03T00:00:00.000Z' });
    expect(p.deviations.by_category).toEqual({ session_limit_exceeded: 1 });
  });

  it('carries the arm split and marks consent versions in force at period end', async () => {
    q.getIrbArmCounts.mockResolvedValue([
      { dimension: 'proactive_offering', value: 'true', sessions: 10, participants: 4 },
      { dimension: 'proactive_offering', value: 'false', sessions: 8, participants: 3 },
      { dimension: 'ai_model', value: 'gpt-live-1', sessions: 18, participants: 7 },
    ]);
    q.getIrbConsentVersions.mockResolvedValue([
      { version: '2025-07-30.1', audience: 'research', effective_at: new Date('2025-07-30T00:00:00Z'),
        superseded_at: new Date('2026-01-15T00:00:00Z'), acceptances_in_window: 12, acceptances_total: 30 },
      { version: '2026-01-15.1', audience: 'research', effective_at: new Date('2026-01-15T00:00:00Z'),
        superseded_at: null, acceptances_in_window: 20, acceptances_total: 20 },
    ]);
    q.getIrbMonitoringCounts.mockResolvedValue({
      drift_alerts: EMPTY.monitoring.drift_alerts,
      harness_runs: [{ suite: 'voice', runs: 3, scenarios: 30, passed: 27, pass_rate: 0.9, last_run_at: new Date('2026-09-01T00:00:00Z') }],
    });
    const p = await buildIrbPacket({ from: FROM, to: TO, orgId: 1 });
    expect(p.enrollment.arms.filter(a => a.dimension === 'proactive_offering').map(a => a.sessions)).toEqual([10, 8]);
    expect(p.consent.versions.map(v => [v.version, v.in_force_at_end])).toEqual([['2025-07-30.1', false], ['2026-01-15.1', true]]);
    expect(p.monitoring.harness_runs[0]).toMatchObject({ suite: 'voice', pass_rate: 0.9, last_run_at: '2026-09-01T00:00:00.000Z' });
  });
});

describe('scrubIdentifiers', () => {
  it('replaces emails and numeric participant/user ids, leaves other numbers', () => {
    expect(scrubIdentifiers('Participant 12 had 3 sessions; user_id 7; contact a.b+c@x.org')).toBe(
      'Participant [id] had 3 sessions; user_id [id]; contact [email]');
    expect(scrubIdentifiers(null)).toBe('');
  });
});

async function packetWithFixture(): Promise<IrbPacket> {
  q.getIrbAdverseEvents.mockResolvedValue([{
    report_id: 1, occurred_at: new Date('2026-03-01T10:00:00Z'), severity: 'high', category: 'crisis',
    trigger_source: 'manual', status: 'submitted',
    summary: 'Filed by therapist <script>alert("x")</script> about "quoted" & participant 99 at bob.smith@byu.edu',
    submitted_at: new Date('2026-03-02T10:00:00Z'), closed_at: null, last_action: null,
  }]);
  q.getIrbDeviations.mockResolvedValue([{
    deviation_id: 2, occurred_at: new Date('2026-02-01T00:00:00Z'), source: 'manual', category: 'procedure',
    severity: 'major', status: 'open', description: 'Seen by nathanblatter <b>bold</b>', resolved_at: null,
  }]);
  cfg.getSystemConfigByKey.mockImplementation(async (key: string) =>
    key === 'study_protocol' ? { config_key: key, config_value: { protocol_id: '2025-519-BYU', principal_investigator: 'O\'Brien & Co' } } : null);
  return buildIrbPacket({ from: FROM, to: TO, orgId: 1, generatedAt: '2026-10-23T12:00:00.000Z' });
}

describe('renderIrbPacketHtml', () => {
  it('is self-contained, carries the header fields, and escapes HTML', async () => {
    const html = renderIrbPacketHtml(await packetWithFixture());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script\b[^>]*src=|<link\b|https?:\/\//i);
    expect(html).toContain('2025-519-BYU');
    expect(html).toContain('O&#39;Brien &amp; Co');
    expect(html).toContain('2025-10-01 to 2026-09-30');
    expect(html).toContain('build abc1234');
    expect(html).toContain('2026-10-23 12:00 UTC');
    // Fixture markup arrives escaped, never live.
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('@media print');
    expect(html).toContain('To be completed by hand');
  });

  it('contains no raw username or email from the fixture', async () => {
    const html = renderIrbPacketHtml(await packetWithFixture());
    expect(html).not.toContain('bob.smith@byu.edu');
    expect(html).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(html).not.toContain('participant 99');
    // Free text that names a staff account is not scrubbed by pattern; it is
    // the researcher's responsibility, and the deviation form says so. The
    // renderer still escapes it rather than dropping the record.
    expect(html).toContain('Seen by nathanblatter &lt;b&gt;bold&lt;/b&gt;');
  });

  it('renders every section with "None in this period." placeholders on empty data', async () => {
    const html = renderIrbPacketHtml(await buildIrbPacket({ from: FROM, to: TO, orgId: 1 }));
    for (const h of ['1. Study', '2. Enrollment', '3. Sessions', '4. Safety monitoring', '5. Adverse events',
      '6. Protocol deviations', '7. Consent', '8. Quality monitoring', '9. Data access', '10. Data-security incidents', '11. Narrative']) {
      expect(html).toContain(h);
    }
    expect(html).toContain('None in this period.');
    expect(html).toContain('(not set - fill by hand)');
  });
});

describe('buildIrbPacketFiles', () => {
  it('emits packet.json, three CSVs and a README with headers and escaped cells', async () => {
    const files = buildIrbPacketFiles(await packetWithFixture());
    expect(files.map(f => f.name)).toEqual(['packet.json', 'adverse_events.csv', 'deviations.csv', 'consent_versions.csv', 'README.md']);
    const ae = files[1].content.split('\n');
    expect(ae[0]).toBe('report_id,occurred_at,severity,category,trigger_source,status,summary,submitted_at,closed_at,resolution');
    expect(ae[1]).toContain('about ""quoted"" & participant [id] at [email]"');
    expect(ae[1]).not.toContain('bob.smith');
    expect(files[2].content.split('\n')[0]).toBe('deviation_id,occurred_at,source,category,severity,status,description,resolved_at');
    expect(files[3].content.split('\n')[0]).toBe('version,audience,effective_at,superseded_at,in_force_at_end,acceptances_in_window,acceptances_total');
    expect(JSON.parse(files[0].content).study.protocol_id).toBe('2025-519-BYU');
    expect(files[4].content).toContain('Must be written by hand');
    expect(files[4].content).toContain('Protocol: 2025-519-BYU');
  });
});
