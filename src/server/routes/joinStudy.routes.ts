// Survey-driven study enrollment (ai-therapist-149, Phase 2).
// The Phase 2 baseline Qualtrics survey's completer branch redirects to
//   GET /join-study?qid=<ResponseID>
// The server verifies the response with the Qualtrics API (right survey,
// finished — which on this survey means the participant passed every screener
// gate and consented in) and serves a one-field-pair registration page. POST
// atomically claims the ResponseID (UNIQUE constraint — a response can only
// ever produce one account), creates the participant account, records the
// response linkage for dataset joins, and logs the participant in.
//
// The feature is entirely env-gated (getQualtricsJoinConfig): with no API
// token/survey id configured the routes behave like unknown paths, so nothing
// participant-facing exists until the study turns it on.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  claimQualtricsResponse,
  releaseQualtricsClaim,
  markQualtricsSignupRegistered,
  findQualtricsSignup,
  createUser,
} from '../db/index.js';
import {
  getQualtricsJoinConfig,
  isPlausibleResponseId,
  verifyBaselineResponse,
} from '../services/qualtrics.service.js';

const PAGE_STYLE = `
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 2rem; width: 100%; max-width: 22rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { font-size: 0.875rem; color: #57534e; margin: 0 0 1.25rem; }
  label { display: block; font-size: 0.8125rem; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem 0.625rem; border: 1px solid #d6d3d1; border-radius: 8px; font-size: 0.9375rem; }
  button { width: 100%; margin-top: 1.25rem; padding: 0.625rem; border: 0; border-radius: 8px; background: #1c1917; color: #fff; font-size: 0.9375rem; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { display: none; margin-top: 0.75rem; font-size: 0.8125rem; color: #b91c1c; }
  a { color: #1c1917; }
`;

/** Registration page. The ResponseID is read from location.search client-side —
 *  it is never interpolated into the HTML. */
function registrationPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Create your study account</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="card">
  <h1>Baseline survey complete</h1>
  <p>Thank you! The last step is creating the account you will use to talk with the AI support agent. Choose a username and password.</p>
  <form id="join-form">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required minlength="3" maxlength="64">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
    <button type="submit" id="submit-btn">Create account</button>
    <div class="error" id="error"></div>
  </form>
</div>
<script>
  const form = document.getElementById('join-form');
  const errorEl = document.getElementById('error');
  const btn = document.getElementById('submit-btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';
    btn.disabled = true;
    try {
      const res = await fetch(location.pathname + location.search, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        location.href = '/';
        return;
      }
      errorEl.textContent = data.error || 'Registration failed. Please try again.';
      errorEl.style.display = 'block';
    } catch (err) {
      errorEl.textContent = 'Network error. Please try again.';
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

function messagePage(title: string, body: string, status = 410): { status: number; html: string } {
  return {
    status,
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${PAGE_STYLE} .card { text-align: center; }</style>
</head>
<body>
<div class="card">
  <h1>${title}</h1>
  <p>${body}</p>
</div>
</body>
</html>`,
  };
}

const ALREADY_USED = messagePage(
  'This link was already used',
  'An account was already created for this survey response. <a href="/">Log in here</a>, or contact the research team if that was not you.'
);
const NOT_VERIFIED = messagePage(
  'We could not verify your survey',
  'This link does not match a completed baseline survey. Please finish the survey first, or contact the research team.'
);
const TRY_LATER = messagePage(
  'Please try again in a moment',
  'We could not reach the survey system to verify your completion. Your survey is saved — retry this link in a few minutes.',
  503
);

export default function joinStudyRoutes(): Router {
  const router = Router();

  // ResponseIDs are hard to guess and single-use, but throttle probing anyway.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in a few minutes.' },
  });

  // GET /join-study?qid=R_... — verify and render the registration page.
  router.get('/join-study', limiter, async (req, res, next) => {
    const config = getQualtricsJoinConfig();
    if (!config) return next(); // feature off: behave like an unknown route

    const qid = req.query.qid;
    if (!isPlausibleResponseId(qid)) {
      const page = NOT_VERIFIED;
      return res.status(page.status).type('html').send(page.html);
    }

    try {
      const existing = await findQualtricsSignup(qid);
      if (existing?.registered_at) {
        return res.status(ALREADY_USED.status).type('html').send(ALREADY_USED.html);
      }

      const verification = await verifyBaselineResponse(config, qid);
      if (!verification.ok) {
        const page = verification.reason === 'not_found' ? NOT_VERIFIED : TRY_LATER;
        return res.status(page.status).type('html').send(page.html);
      }
      if (!verification.finished) {
        return res.status(NOT_VERIFIED.status).type('html').send(NOT_VERIFIED.html);
      }

      res.type('html').send(registrationPage());
    } catch (error) {
      console.error('Error loading study join page:', error);
      res.status(500).json({ error: 'Failed to load signup page' });
    }
  });

  // POST /join-study?qid=R_... — claim the response, create the account, log in.
  router.post('/join-study', limiter, async (req, res, next) => {
    const config = getQualtricsJoinConfig();
    if (!config) return next();

    const qid = req.query.qid;
    if (!isPlausibleResponseId(qid)) {
      return res.status(410).json({ error: 'This link is not valid.' });
    }

    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
      // Verify with Qualtrics BEFORE claiming, so an unverifiable request
      // never burns the single-use claim.
      const verification = await verifyBaselineResponse(config, qid);
      if (!verification.ok) {
        return verification.reason === 'not_found'
          ? res.status(410).json({ error: 'This link does not match a completed survey.' })
          : res.status(503).json({ error: 'Could not verify your survey right now. Please try again shortly.' });
      }
      if (!verification.finished) {
        return res.status(410).json({ error: 'Please finish the baseline survey first.' });
      }

      // Atomic single-use gate: only one request can ever win this INSERT.
      const claim = await claimQualtricsResponse(qid, config.baselineSurveyId);
      if (!claim) {
        return res.status(410).json({ error: 'An account was already created from this link.' });
      }

      let user;
      try {
        const orgIdRaw = process.env.QUALTRICS_STUDY_ORG_ID;
        const orgId = orgIdRaw && /^\d+$/.test(orgIdRaw) ? Number(orgIdRaw) : null;
        user = await createUser(username.trim(), password, 'participant', { orgId });
      } catch (error: unknown) {
        // Registration failed — release the claim so the link stays usable.
        await releaseQualtricsClaim(claim.signup_id).catch((releaseError: unknown) => {
          console.error('Error releasing qualtrics claim after failed registration:', releaseError);
        });
        if (error instanceof Error && error.message === 'Username already exists') {
          return res.status(409).json({ error: 'Username already exists' });
        }
        throw error;
      }

      await markQualtricsSignupRegistered(claim.signup_id, user.userid);

      // Establish the session on a fresh id, mirroring login (fixation +
      // no leftover fields from a previous account on this browser).
      const createdUser = user;
      req.session.regenerate((regenErr) => {
        if (regenErr) {
          console.error('Session regenerate error:', regenErr);
          return res.status(500).json({ error: 'Account created — please log in from the home page.' });
        }
        req.session.userId = createdUser.userid;
        req.session.username = createdUser.username;
        req.session.userRole = createdUser.role;
        req.session.mfaVerified = true;
        if (typeof createdUser.organization_id === 'number') req.session.orgId = createdUser.organization_id;
        req.session.isSandbox = createdUser.is_sandbox === true;

        req.session.save((err) => {
          if (err) {
            console.error('Session save error:', err);
            return res.status(500).json({ error: 'Account created — please log in from the home page.' });
          }
          res.json({
            success: true,
            user: { userid: createdUser.userid, username: createdUser.username, role: createdUser.role },
          });
        });
      });
    } catch (error) {
      console.error('Error completing study registration:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  return router;
}
