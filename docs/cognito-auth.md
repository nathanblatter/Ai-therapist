# Sign-in through Amazon Cognito

Status (2026-11-25): the server sign-in flow is built and unit-tested. It is
**not enabled anywhere yet**: no user pool exists, the login page does not
start this flow, and account changes are not mirrored to a pool. Those are
ai-therapist-394, 397 and 396. Until then stage signs in through Squawk
(docs/squawk-auth.md) and prod through the legacy login.

## Why

Prod sign-in must not depend on Nathan's personal infrastructure (Squawk runs
alongside his other projects). Cognito is a managed service in the study's own
AWS account, the same account that holds the study data. Decided 2026-11-21 to
25 on ai-therapist-387 and 393:

- Sign-in happens on Cognito's **hosted page**. A password is never typed into
  this app at sign-in.
- Authenticator-app codes (TOTP) are required for staff (therapist, researcher,
  caseworker) and optional for participants.
- No owner passkey. Passkeys only if the pool tier that includes them stays free.
- Participants have no email on file, so there is no self-service password
  reset: study staff reset a password from User Management.
- One pool for stage and one for prod. Squawk comes out of the app once prod
  has run on Cognito (ai-therapist-400).
- One Cognito **group per role**. The app's `users` table still holds
  organisations, RBAC lookups and foreign keys.

## How it works

1. The browser goes to `GET /api/auth/cognito/start`. The server stores a PKCE
   verifier, a `state` and a `nonce` on the session and redirects to
   `{COGNITO_DOMAIN}/oauth2/authorize` (`response_type=code`, `scope=openid`,
   `code_challenge_method=S256`).
2. The person signs in on the hosted page (password, and a code if their
   account has TOTP). Cognito redirects to
   `GET /api/auth/cognito/callback?code&state`.
3. The server checks `state` (single use, 10 minutes), exchanges the code at
   `{COGNITO_DOMAIN}/oauth2/token` with the verifier, and verifies the **ID
   token** in `src/server/services/cognito.service.ts`: RS256 signature against
   the pool's JWKS, `iss` = this pool, `aud` = this app client, `token_use` =
   `id`, lifetime, and the `nonce` from step 1. No JWT library.
4. The role is the one entry in the token's `cognito:groups` that names an app
   role. No role group, or more than one, refuses the sign-in (`no_role`): the
   app never guesses a role.
5. The local row is found by `users.cognito_sub` (migration 129), or on the
   first sign-in by username (`cognito:username`), and is then linked. A
   username whose row is linked to a different subject is refused
   (`no_account`). If the pool's role differs from `users.role`, the row is
   updated: the pool is the source of roles.
6. The session is established exactly as the legacy login does it: a fresh
   session id, consent and anonymous-session ownership carried over, account
   fields stamped. Staff land on `/admin`, everyone else on `/`.

`GET /api/auth/cognito/logout` destroys the app session and then redirects to
`{COGNITO_DOMAIN}/logout`, which ends the hosted page's own session and returns
the browser to `/login`. Without that second step the next "sign in" on a
shared computer would silently reuse the last account.

Refusals redirect to `/login?error=<code>` with one of `state_mismatch`,
`sign_in_failed`, `invalid_token`, `no_role`, `no_account`, `server_error`.
Nothing Cognito sends is echoed into the URL.

With the `COGNITO_*` variables set, the legacy `POST /api/auth/login` answers
`410` before it looks at the local hash. With them unset (local dev, tests, CI)
nothing changes.

## Configuration

`.env` (see `.env.example`):

| Variable | Value |
|---|---|
| `COGNITO_USER_POOL_ID` | the pool id, e.g. `us-west-1_AbCdEf123`; the region is read from it |
| `COGNITO_CLIENT_ID` | the app client id |
| `COGNITO_CLIENT_SECRET` | only if the app client has a secret |
| `COGNITO_DOMAIN` | the hosted-page origin, `https://<prefix>.auth.us-west-1.amazoncognito.com` |
| `APP_URL` | this deployment's public origin (falls back to `CORS_ORIGIN`) |

Pool side, per app client: callback URL `{APP_URL}/api/auth/cognito/callback`,
sign-out URL `{APP_URL}/login`, authorization-code grant, scope `openid`,
self-sign-up **off** (the first-sign-in match by username relies on it), sign-in
by username, groups `therapist`, `researcher`, `participant`, `demo`,
`caseworker`.

Do not set `COGNITO_*` and `SQUAWK_*` together. Never put either in CI.

## Not built yet

- The pools themselves, and the script that creates them (ai-therapist-394).
- Account create, password, role and delete mirrored to the pool through
  `accounts.service.ts`; staff password and TOTP reset (ai-therapist-396).
- The login page starting this flow, the sign-out button calling the logout
  route, and the security settings screen (ai-therapist-397).
- Requiring TOTP for staff. The pool can only require a second factor for
  everyone or leave it optional for everyone, so the per-role rule has to be
  enforced by this app at sign-in; how is open on ai-therapist-396.
- Rollback rehearsal on stage (ai-therapist-398). The intended rollback is to
  remove the `COGNITO_*` variables and redeploy; the legacy login works again
  because the local hashes are untouched.

## Cost

Checked 2026-11-25 against the AWS pricing page: the Essentials tier (the
default for new pools, and the lowest tier with the hosted managed login and
passkeys) is free for the first 10,000 monthly active users per account. The
study has 3 prod accounts. The Plus tier has no free allowance and is not used.
