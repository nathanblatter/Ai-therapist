// Qualtrics API client for survey-driven enrollment (ai-therapist-149).
// The only capability the app needs from Qualtrics today is "does this
// ResponseID belong to our baseline survey, and is it a finished response?" —
// used by /join-study to verify a participant really completed (and therefore
// passed the screener gates and consented in) the baseline survey before an
// account is provisioned.
//
// Configuration is plain env (feature is disabled when unset, mirroring the
// DEMO_MAGIC_TOKEN pattern):
//   QUALTRICS_API_TOKEN         - a Qualtrics API token with read access
//   QUALTRICS_BASELINE_SURVEY_ID- SV_... id of the Phase 2 baseline survey
//   QUALTRICS_DATACENTER        - optional, defaults to BYU's 'byu.pdx1'

export interface QualtricsJoinConfig {
  apiToken: string;
  baselineSurveyId: string;
  datacenter: string;
}

/** Resolve config from env, or null when the feature is not configured. */
export function getQualtricsJoinConfig(): QualtricsJoinConfig | null {
  const apiToken = process.env.QUALTRICS_API_TOKEN;
  const baselineSurveyId = process.env.QUALTRICS_BASELINE_SURVEY_ID;
  if (!apiToken || !baselineSurveyId) return null;
  return {
    apiToken,
    baselineSurveyId,
    datacenter: process.env.QUALTRICS_DATACENTER || 'byu.pdx1',
  };
}

export type ResponseVerification =
  | { ok: true; finished: boolean }
  | { ok: false; reason: 'not_found' | 'unavailable' };

/** Qualtrics ResponseIDs look like R_ followed by url-safe base64-ish chars.
 *  Reject anything else before it reaches the API client. */
export function isPlausibleResponseId(value: unknown): value is string {
  return typeof value === 'string' && /^R_[A-Za-z0-9]{8,24}$/.test(value);
}

/**
 * Fetch a single survey response and report whether it exists and is finished.
 * Network/auth/5xx problems surface as 'unavailable' (callers show a
 * try-again-later page rather than provisioning an unverified account).
 */
export async function verifyBaselineResponse(
  config: QualtricsJoinConfig,
  responseId: string
): Promise<ResponseVerification> {
  const url = `https://${config.datacenter}.qualtrics.com/API/v3/surveys/${config.baselineSurveyId}/responses/${responseId}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'X-API-TOKEN': config.apiToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error('[Qualtrics] response lookup failed:', error);
    return { ok: false, reason: 'unavailable' };
  }

  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res.ok) {
    console.error(`[Qualtrics] response lookup HTTP ${res.status}`);
    return { ok: false, reason: 'unavailable' };
  }

  try {
    const body = (await res.json()) as {
      result?: { responseId?: string; values?: { finished?: number | boolean } };
    };
    const finishedRaw = body.result?.values?.finished;
    const finished = finishedRaw === 1 || finishedRaw === true;
    return { ok: true, finished };
  } catch (error) {
    console.error('[Qualtrics] response parse failed:', error);
    return { ok: false, reason: 'unavailable' };
  }
}
