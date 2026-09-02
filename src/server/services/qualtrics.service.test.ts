// Qualtrics enrollment client: env gating, ResponseID shape filtering, and the
// verification outcomes /join-study branches on (finished / not_found /
// unavailable — the last must NEVER be treated as verified).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getQualtricsJoinConfig,
  isPlausibleResponseId,
  verifyBaselineResponse,
  type QualtricsJoinConfig,
} from './qualtrics.service.js';

const CONFIG: QualtricsJoinConfig = {
  apiToken: 'test-token',
  baselineSurveyId: 'SV_aW32vA2r2yHrpI2',
  datacenter: 'byu.pdx1',
};

describe('getQualtricsJoinConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.QUALTRICS_API_TOKEN = saved.QUALTRICS_API_TOKEN;
    process.env.QUALTRICS_BASELINE_SURVEY_ID = saved.QUALTRICS_BASELINE_SURVEY_ID;
    process.env.QUALTRICS_DATACENTER = saved.QUALTRICS_DATACENTER;
  });

  it('returns null when the token or survey id is missing', () => {
    delete process.env.QUALTRICS_API_TOKEN;
    delete process.env.QUALTRICS_BASELINE_SURVEY_ID;
    expect(getQualtricsJoinConfig()).toBeNull();

    process.env.QUALTRICS_API_TOKEN = 't';
    expect(getQualtricsJoinConfig()).toBeNull();
  });

  it('defaults the datacenter to byu.pdx1', () => {
    process.env.QUALTRICS_API_TOKEN = 't';
    process.env.QUALTRICS_BASELINE_SURVEY_ID = 'SV_x';
    delete process.env.QUALTRICS_DATACENTER;
    expect(getQualtricsJoinConfig()).toEqual({
      apiToken: 't',
      baselineSurveyId: 'SV_x',
      datacenter: 'byu.pdx1',
    });
  });
});

describe('isPlausibleResponseId', () => {
  it('accepts real-shaped ResponseIDs', () => {
    expect(isPlausibleResponseId('R_1hB2c3D4e5F6g7H')).toBe(true);
  });

  it('rejects non-strings, wrong prefixes, and path-metacharacters', () => {
    expect(isPlausibleResponseId(undefined)).toBe(false);
    expect(isPlausibleResponseId(['R_a1b2c3d4'])).toBe(false);
    expect(isPlausibleResponseId('SV_aW32vA2r2yHrpI2')).toBe(false);
    expect(isPlausibleResponseId('R_abc/../../secrets')).toBe(false);
    expect(isPlausibleResponseId('R_ab')).toBe(false);
  });
});

describe('verifyBaselineResponse', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it('calls the datacenter-scoped single-response endpoint with the API token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { result: { values: { finished: 1 } } }));
    await verifyBaselineResponse(CONFIG, 'R_1hB2c3D4e5F6g7H');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://byu.pdx1.qualtrics.com/API/v3/surveys/SV_aW32vA2r2yHrpI2/responses/R_1hB2c3D4e5F6g7H',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-API-TOKEN': 'test-token' }) })
    );
  });

  it('reports finished responses', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { result: { values: { finished: 1 } } }));
    expect(await verifyBaselineResponse(CONFIG, 'R_1hB2c3D4e5F6g7H')).toEqual({
      ok: true,
      finished: true,
    });
  });

  it('reports in-progress responses as unfinished', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { result: { values: { finished: 0 } } }));
    expect(await verifyBaselineResponse(CONFIG, 'R_1hB2c3D4e5F6g7H')).toEqual({
      ok: true,
      finished: false,
    });
  });

  it('maps 404 to not_found', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { meta: {} }));
    expect(await verifyBaselineResponse(CONFIG, 'R_1hB2c3D4e5F6g7H')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('maps auth/server errors and network failures to unavailable, never verified', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}));
    expect(await verifyBaselineResponse(CONFIG, 'R_1hB2c3D4e5F6g7H')).toEqual({
      ok: false,
      reason: 'unavailable',
    });

    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    expect(await verifyBaselineResponse(CONFIG, 'R_1hB2c3D4e5F6g7H')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});
