# Sign-in through Squawk

Since 2026-10-19 (auth-service-33) AI Therapist authenticates people through
**Squawk**, Nathan's auth service at https://squawk.nathanblatter.com. The app
keeps its own `users` table (RBAC, foreign keys, org scoping) and its express
session; Squawk owns the credentials and the sign-in ceremonies.

## What changed for people

- **Same username and password.** Existing bcrypt hashes were imported into
  Squawk as they are; nobody had to reset anything.
- **Passkeys.** Admin → MFA/Security shows a Passkeys card. Registering one
  *replaces* the password on that account (Squawk keeps one method per
  account); a researcher can set a new password from User Management, which
  switches it back.
- **Owner passkey.** The login page offers "Sign in as owner": Nathan's Squawk
  passkey signs in as the local account named by `SQUAWK_OWNER_USERNAME`.
- TOTP MFA is not part of the Squawk flow. Nobody on stage had it enabled;
  decide before prod whether Squawk should grow it or passkeys replace it.

## How it works

1. `/login` without a `login_challenge` sends the browser to
   `/api/auth/squawk/start`, which stores a PKCE verifier + state on the
   session and redirects to Squawk's `/oauth/authorize` with
   `scope=role:therapist role:researcher role:participant role:demo role:caseworker`.
2. Squawk parks the request and sends the browser back to
   `/login?login_challenge=<id>`. The page posts username + password to
   `/api/auth/squawk/password` (or runs a WebAuthn ceremony through
   `/api/auth/squawk/{passkey,owner}/{begin,finish}`); the backend relays to
   Squawk under the **service token** and gets a `redirect_to`.
3. The browser follows it to `/api/auth/squawk/callback?code&state`. The
   backend exchanges the code, verifies the ES256 access token against
   Squawk's JWKS (`src/server/services/squawk.service.ts`, no JWT library),
   maps `sub` to a local row (`users.squawk_user_id`, or by username on the
   first login, or `SQUAWK_OWNER_USERNAME` for `sub=owner`), **copies the role
   out of the token scope** (`role:<name>`; Squawk is the source of roles) and
   establishes the session exactly as the legacy login did.
4. Account changes flow through `src/server/services/accounts.service.ts`:
   creating a user (admin, invite links, Qualtrics join) also creates the
   Squawk password account; password and role changes are mirrored; deleting
   deletes there too. Usernames cannot change once linked.

With the `SQUAWK_*` variables unset (local dev, tests) everything falls back
to the legacy `/api/auth/login` against the local hash. With them set, that
route answers `410` so a stale local hash is never consulted.

## Configuration

`.env` (see `.env.example`): `SQUAWK_ISSUER`, `SQUAWK_SERVICE_ID`,
`SQUAWK_CREDENTIAL` (a service credential minted in the Squawk console),
`SQUAWK_CLIENT_ID` (the OAuth client registered with redirect URI
`{APP_URL}/api/auth/squawk/callback`), `SQUAWK_RESOURCE` (the resource URL
registered on the service), `SQUAWK_OWNER_USERNAME`, `APP_URL`.

Squawk side (console → service `ai-therapist`): `login_url` = `{APP_URL}/login`,
`rp_id` = the app host, `origins` = `[APP_URL]`, `default_roles` =
`[participant]`, `open_signup` = true (invite-link sign-ups create accounts),
scope catalog = the five `role:*` scopes with each role bundling its own.

## One-time import

`src/database/scripts/importToSquawk.ts` (header comment has the command)
needs the Squawk admin bearer token: it creates the password accounts with
the stored hashes, then one Squawk org per organisation with members
(therapists and researchers as org admins), filling `users.squawk_user_id`
and `organizations.squawk_org_id` (migration 106). Idempotent.
