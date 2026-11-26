# Sign-in through Amazon Cognito

Status (2026-11-26): the server sign-in flow, the login page's Cognito mode,
the mirroring of account changes to the pool and the authenticator-code rule
for staff are built and unit-tested, run end to end in a browser against a
local stand-in pool, and reviewed once by an independent reader (findings
fixed the same night).
It is **not enabled anywhere yet**: no user pool exists (ai-therapist-394).
Nothing here has run against a real pool; the account mirroring in particular
has only ever talked to a mocked AWS client (see "Unconfirmed until the first
stage run"). Until then stage signs in through Squawk (docs/squawk-auth.md)
and prod through the legacy login.

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
   `{COGNITO_DOMAIN}/oauth2/authorize` (`response_type=code`,
   `scope=openid aws.cognito.signin.user.admin`, `code_challenge_method=S256`).
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
6. A staff role (therapist, researcher, caseworker) must have an authenticator
   app switched on in the pool, or the sign-in is held for setup instead of
   signed in: see "Authenticator codes for staff".
7. The session is established exactly as the legacy login does it: a fresh
   session id, consent and anonymous-session ownership carried over, account
   fields stamped. Staff land on `/admin`, everyone else on `/`.

Sign-out stays `POST /api/auth/logout`. With Cognito configured its answer
also carries `redirect`, the hosted page's `{COGNITO_DOMAIN}/logout` URL; the
browser goes there next, which ends the hosted page's own session and returns
to `/login`. Without that second step the next "sign in" on a shared computer
would silently reuse the last account.

The login page asks `/api/auth/cognito/config` and `/api/auth/squawk/config`
and picks a mode in `src/client/main/lib/signInMode.ts`. In Cognito mode it
shows no form: it hands the browser to `/api/auth/cognito/start`, or, when a
callback sent it back with `?error=`, shows the reason and a button to try
again (never an automatic redirect, which would loop). The staff deep link from
a crisis page (`/admin#session=...`) is saved before the page leaves, exactly
as under Squawk.

Refusals redirect to `/login?error=<code>` with one of `state_mismatch`,
`sign_in_failed`, `invalid_token`, `no_role`, `no_account`, `server_error`,
`too_many_attempts`. Sign-in starts and callbacks are limited to 300 per
address in 15 minutes (a campus can sit behind one address), the enrolment
calls to 40.
Nothing Cognito sends is echoed into the URL.

With the `COGNITO_*` variables set, the legacy `POST /api/auth/login` answers
`410` before it looks at the local hash. With them unset (local dev, tests, CI)
nothing changes.

## Authenticator codes for staff

Built 2026-11-26 (ai-therapist-396) against a mocked AWS client. **Never run
against a real pool.**

The rule (decided 2026-11-25): therapists, researchers and caseworkers sign in
with a password and a code from an authenticator app; participants and demo
accounts are not required to. `requiresSecondFactor()` in `src/shared/roles.ts`
is the one place the list lives.

Why the app enforces it: a pool can require a second factor for everyone or
leave it optional for everyone, and while it is optional the hosted page never
offers to set one up (AWS developer guide, "Adding MFA to a user pool", read
2026-11-26). So the pool is created with it optional, and this app does the
rest:

1. In the callback, after the account and role are resolved, a staff sign-in
   asks the pool (`AdminGetUser`) whether the account has
   `SOFTWARE_TOKEN_MFA` in `UserMFASettingList`. If it does, the hosted page
   has already asked for a code at this sign-in (it does so at every sign-in
   once the factor is on) and the session is established. If the pool cannot
   be asked, the sign-in is refused (`server_error`): staff are never let in
   on a password alone because a lookup failed.
2. If it does not, no app session is created. The browser session is replaced
   by a short-lived enrolment state (15 minutes, 8 code attempts) holding the
   access token of that sign-in, and the browser goes to `/login?enrol=totp`.
3. The login page shows the setup screen
   (`src/client/main/components/TotpEnrol.tsx`):
   `POST /api/auth/cognito/totp/begin` calls `AssociateSoftwareToken` with the
   held access token and returns the secret and a QR code;
   `POST /api/auth/cognito/totp/verify` calls `VerifySoftwareToken` with the
   6-digit code, then `AdminSetUserMFAPreference` (enabled, preferred), then
   establishes the session. The code just entered is the second factor for
   this sign-in.
4. From then on the hosted page asks that account for a code every time.
5. "Switched on now" is not the same as "this sign-in was asked for a code":
   someone who signed in at the hosted page with the password alone, before
   the owner enrolled, could come back afterwards. So step 3 also records when
   the account enrolled (`users.cognito_totp_enrolled_at`, migration 131), and
   the callback requires the ID token's `auth_time` to be later. An older
   sign-in gets no session: the browser is sent through the hosted sign-out,
   and the next attempt authenticates afresh, with a code. A token with no
   `auth_time` is treated as older.
6. A held sign-in ends the moment the account has an authenticator: both
   enrolment calls ask the pool first, so a hold opened by someone else
   cannot register a second authenticator or sign in once the owner has
   enrolled.

Other ways into a session follow the same rule. With Cognito on, the invite
links (`/join/:token`, `/join-sandbox/:token`) create a staff account but do
not sign it in: the page goes to `/login` and the person signs in and enrols
like anyone else. Participant invites still sign the new participant in.

The access token is the only Cognito token the app ever keeps, only for a held
staff sign-in, only in the server-side session, and it is dropped when the
session is established or the enrolment expires. It is why sign-in requests
the `aws.cognito.signin.user.admin` scope: `AssociateSoftwareToken` and
`VerifySoftwareToken` are authorised by that token, not by IAM.

Lost phone: a researcher presses "Reset authenticator app" on the account in
User Management (`POST /api/users/:id/reset-authenticator`, through
`accounts.service.ts`). That switches the challenge off in the pool
(`AdminSetUserMFAPreference`), clears the recorded enrolment time, revokes the
account's pool tokens (`AdminUserGlobalSignOut`) and ends its app sessions;
the person's next sign-in is then held for setup again, and the new setup
replaces the old secret. There are no backup codes: the reset is the recovery
path, as for passwords. The route is researcher only, limited to staff
accounts in the researcher's own organisation, and accepts JSON requests only
(another site cannot make it for a signed-in researcher). It is logged at warn
level with both usernames and written to the account audit trail
(`account_audit_log`, migration 132), as are account creations, deletions,
role, username, password and email changes made through User Management, in
every sign-in mode. The trail never holds a password, a token or an address.
Researchers read their organisation's rows under "Recent account changes" in
User Management (`GET /api/users/audit`).

An account's app sessions also end when it is deleted or its role changes, in
every sign-in mode: a session otherwise keeps the role it was given for up to
24 hours.

The security settings screen (Admin, MFA) says, under Cognito, that the
sign-in service holds the password and authenticator, and offers nothing to
set up. The app's own `/api/mfa/setup/*`, `/disable` and
`/regenerate-backup-codes` answer `409 managed_by_cognito`: nothing reads the
local secret under Cognito, and confirming with the local password would be a
second password check. The Squawk passkey card is already hidden when Squawk
is not configured.

Known limits:

- Between a reset and the person's next sign-in the account is protected by
  its password alone at the pool, but that sign-in still cannot reach the app
  without enrolling.
- An attacker who knows a staff password for an account that has never
  enrolled (new account, or just reset) can enrol their own authenticator.
  This is inherent to enrol-at-first-sign-in; keep the window short by having
  new staff sign in when the account is made, and reset only on request.
- A researcher can set another staff account's password and reset its
  authenticator, which together take the account over. That is the
  researcher role's existing power over accounts; what is new is that it now
  leaves a warn-level log line and ends the target's sessions.
- The SDK version in use has no `AdminDeleteSoftwareToken`, so a reset does
  not erase the old secret at the pool; it stops being asked for, and the
  next enrolment replaces it.
- The ID token may carry `amr`/`acr` claims naming the methods used (AWS says
  the feature is rolling out and may not be on a given pool). The app does not
  read them yet; if the stage pool sends them, checking `amr` for a staff
  sign-in would be a second, independent proof.

### Unconfirmed until the first stage run (authenticator)

1. The app client accepts `aws.cognito.signin.user.admin` in
   `AllowedOAuthScopes` next to `openid`, and the access token from the code
   exchange carries it.
2. `AssociateSoftwareToken` and `VerifySoftwareToken` work with that access
   token from the server (no IAM), and a wrong code comes back as
   `CodeMismatchException` or `EnableSoftwareTokenMFAException`.
3. `AdminSetUserMFAPreference` succeeds right after a successful verify, and
   `AdminGetUser` then lists `SOFTWARE_TOKEN_MFA`.
4. The hosted page asks an enrolled account for a code at the next sign-in,
   and does not ask one that was reset.
5. After a reset, a new `AssociateSoftwareToken` replaces the old secret (the
   old authenticator entry stops working).
6. `AdminGetUser`, `AdminSetUserMFAPreference` and `AdminUserGlobalSignOut`
   are covered by `iam-app-policy.json` as written.
7. The ID token carries `auth_time` (AWS's token reference says so). If it
   does not, every staff sign-in after enrolment is sent back to the hosted
   page: the rule fails closed, so check this first.
8. Signing in again after the hosted sign-out really does ask for the
   password and a code (the hosted page's own session is gone).
9. `AdminUserGlobalSignOut` ends the hosted page's session for a reset
   account.

## Account changes

Built 2026-11-25 (ai-therapist-396) against a mocked AWS client. **Never run
against a real pool.**

Every flow that creates, re-passwords, re-roles or deletes an account goes
through `src/server/services/accounts.service.ts` (User Management, invite
links, the sandbox link, the Qualtrics join, `POST /api/auth/register`). With
the `COGNITO_*` variables set it writes the local row first and then the pool,
through `src/server/services/cognitoAdmin.service.ts` (the official
`@aws-sdk/client-cognito-identity-provider` client, default AWS credential
chain, region and pool id from `cognito.service.ts`). A pool user is addressed
by its **username**, which is the local username.

| Change | Pool calls | If the pool call fails |
|---|---|---|
| Create | `AdminCreateUser` (invitation suppressed, no email attribute), `AdminSetUserPassword` (`Permanent`), `AdminAddUserToGroup` (the role) | The local row is removed again. A user that was created but did not get its password or group is deleted from the pool (`AdminDeleteUser`). A username the pool already has answers "Username already exists" and that pool user is not touched. |
| Password | `AdminSetUserPassword` (`Permanent`) | Surfaced (`502`, or `400` when the pool refused the password itself). The local change stands. |
| Role | `AdminListGroupsForUser`, `AdminAddUserToGroup` (new role), `AdminRemoveUserFromGroup` (every other role group) | Surfaced (`502`). The local change stands. Stopping half-way leaves the account in two role groups, which sign-in refuses; saving the role again finishes it. |
| Delete | `AdminDeleteUser` | Surfaced (`502`): the local row is gone but the pool user still holds its password and its username. A user the pool never had is not an error. |
| Rename | none | Refused before anything is written: a pool username cannot change. |

The new user's subject is stored in `users.cognito_sub` at creation (read from
the `AdminCreateUser` answer, else `AdminGetUser`). If it cannot be read or
stored the account is still kept: the first sign-in links it by username.

Things to know:

- **One provider only.** With both `COGNITO_*` and `SQUAWK_*` set, account
  changes go to the pool and Squawk is not written (the login page makes the
  same choice). Do not run that way on purpose.
- **Accounts that are not in the pool.** An account that existed before the
  pool has no pool user (its password cannot be copied: only a hash is
  stored). Setting a new password for it, from User Management or by the
  person themselves while still signed in, creates the pool user with that
  password and the row's role, and links the row. A role change alone for
  such an account answers `502` "This account is not in the sign-in service
  yet. Set a new password for it to move it there." (the local change stands).
- **Accounts that never go to the pool.** Magic-link demo accounts
  (`createDemoUser`), the sandbox link's seeded caseload (`sandboxSeed.ts`) and
  the red-team harness participant (`harnessRunner.service.ts`) are inserted
  straight into `users` with a throwaway hash and are never signed in with a
  password. They get no pool user. The demo sweep deletes rows directly, which
  is right for the same reason.
- **Passwords.** The app's rule (`src/server/utils/passwordPolicy.ts`, 12 to
  256 characters, no character classes) matches the pool policy the script
  sets (minimum 12, no classes) and Cognito's own maximum of 256. A password
  the pool still refuses comes back as "The sign-in service did not accept
  this password. Choose a different one." A password is never written to a
  log: errors from the password call carry AWS's error name only.
- **The local hash is still written** (`users.password`), as under Squawk. No
  sign-in reads it while `COGNITO_*` is set; it is what the rollback in
  ai-therapist-398 falls back to.
- **Permissions.** Every call above is in `scripts/cognito/iam-app-policy.json`.

### Unconfirmed until the first stage run

None of this could be checked without a pool. Check each on stage:

1. `AdminCreateUser` with only `Username` and `MessageAction=SUPPRESS` is
   accepted (no email, no temporary password supplied), and its answer carries
   the `sub` attribute.
2. `AdminSetUserPassword` with `Permanent=true` moves the new user from
   `FORCE_CHANGE_PASSWORD` to `CONFIRMED`, and the hosted page then signs it in
   without asking for a new password.
3. A password containing spaces. Cognito's API reference gives the password
   type the pattern `[\S]+` (no whitespace), while its password-policy page
   counts the space as an allowed special character. The app allows spaces. If
   the pool refuses them the person gets the clean error above; decide then
   whether the app's rule should say so up front.
4. The maximum password length is 256 (the API reference and the developer
   guide both say so, read 2026-11-25; the SDK's types do not state it).
5. The exception names this code reads: `UsernameExistsException`,
   `UserNotFoundException`, `InvalidPasswordException`,
   `PasswordHistoryPolicyViolationException`, `InvalidParameterException`.
6. `AdminAddUserToGroup` for a group the user is already in, and
   `AdminRemoveUserFromGroup` for the old role, behave as assumed (the code
   lists the groups first and skips an add that is not needed).
7. Usernames: the app allows whatever the join forms allow; confirm the pool
   accepts the same characters and treats case as the app does
   (`CaseSensitive=true` in the script).
8. Deleting a pool user while that person is signed in: the app session keeps
   working until it expires (it is the app's own session); confirm the hosted
   page refuses the next sign-in.
9. The app's AWS identity with only `iam-app-policy.json` attached can make
   every call in the table.

## Configuration

`.env` (see `.env.example`):

| Variable | Value |
|---|---|
| `COGNITO_USER_POOL_ID` | the pool id, e.g. `us-west-1_AbCdEf123`; the region is read from it |
| `COGNITO_CLIENT_ID` | the app client id |
| `COGNITO_CLIENT_SECRET` | only if the app client has a secret |
| `COGNITO_DOMAIN` | the hosted-page origin, `https://<prefix>.auth.us-west-1.amazoncognito.com` |
| `APP_URL` | this deployment's public origin (falls back to `CORS_ORIGIN`) |
| `COGNITO_AWS_ACCESS_KEY_ID`, `COGNITO_AWS_SECRET_ACCESS_KEY` | optional key pair for the pool calls only; see Creating a pool |

Pool side, per app client: callback URL `{APP_URL}/api/auth/cognito/callback`,
sign-out URL `{APP_URL}/login`, authorization-code grant, scopes `openid` and
`aws.cognito.signin.user.admin`,
self-sign-up **off** (the first-sign-in match by username relies on it), sign-in
by username, groups `therapist`, `researcher`, `participant`, `demo`,
`caseworker`.

Do not set `COGNITO_*` and `SQUAWK_*` together. Never put either in CI.

## Creating a pool

`scripts/cognito/create-pool.sh <stage|prod> <app-url> <domain-prefix>` creates
one pool with the settings above, its five role groups, the hosted sign-in
domain and the app client, then prints the `.env` values. It refuses to run
outside the study account or when a pool of that name exists, and never changes
an existing pool. Change the script, not the console, so stage and prod stay
the same.

As of 2026-11-26 the script has **not been run**. It passes a shell syntax
check, and every command and flag in it and in `create-first-researcher.sh`
exists in the installed AWS CLI (2.38.1, checked against its own help). The
study's `nathan` IAM user has no Cognito permissions, so the first run on
stage is still the first test of what the service accepts.

Two sets of AWS permissions are involved, both granted by Nathan:

- **One-time setup**: whoever runs the script needs to administer Cognito in
  the study account (for example the AWS-managed `AmazonCognitoPowerUser`
  policy, attached for the setup and removed afterwards).
- **The running app**: `scripts/cognito/iam-app-policy.json`, limited to the
  user-management calls the app makes and to that environment's pool ARN. One
  copy per environment, each naming only its own pool.
  The app uses `COGNITO_AWS_ACCESS_KEY_ID` and
  `COGNITO_AWS_SECRET_ACCESS_KEY` when both are set, otherwise the AWS SDK's
  default chain. On stage the key pair is required: the compose file passes
  variables to the container one by one and does not pass `AWS_ACCESS_KEY_ID`.

`scripts/cognito/create-first-researcher.sh <pool-id> <username>` creates the
first researcher in a new pool (nobody can reach User Management before one
exists). It asks for the password on the terminal. Not run yet either.

## Cutover runbook

Written 2026-11-26, before any pool exists. Every step marked (Nathan) is an
IAM, account or prod decision that only he makes. Nothing here has been done.

### Stage (ai-therapist-394, 398)

1. (Nathan) Give the IAM identity that will run the setup Cognito admin rights
   in the study account, for the setup only (for example attach
   `AmazonCognitoPowerUser` to the `nathan` user, and remove it afterwards).
2. Check the pricing page again, then run
   `scripts/cognito/create-pool.sh stage https://ai-therapist.nathanblatter.com <domain-prefix>`.
   Note the pool id, client id, domain and pool ARN it prints. This is the
   first run of the script: expect to fix an option or two.
3. (Nathan) Create an IAM user for the app's pool calls, attach
   `scripts/cognito/iam-app-policy.json` with the stage pool ARN filled in,
   and make an access key for it.
4. Pick the first researcher: an existing researcher row in stage's `users`
   table. Run `scripts/cognito/create-first-researcher.sh <pool-id> <username>`
   and type a new password for it.
5. In `~/deploy/Ai-therapist/.env` add the four `COGNITO_*` values, the client
   secret, and `COGNITO_AWS_ACCESS_KEY_ID` / `COGNITO_AWS_SECRET_ACCESS_KEY`
   from step 3. **Remove or comment out every `SQUAWK_*` line** (the two must
   not be set together). Redeploy stage through the pipeline (re-run the
   Deploy workflow on `main`; do not restart the container by hand).
6. Sign in as the first researcher. Expected: hosted page, password, then the
   app's authenticator setup screen, then `/admin`. Sign out, sign in again:
   the hosted page now asks for a code.
7. Work both "Unconfirmed until the first stage run" lists in this document
   and record each result here.
8. Move the other stage accounts: in User Management set a new password for
   each one that should keep working. Demo and sandbox-seeded accounts are
   never signed in with a password and need nothing.
9. Rehearse the rollback: comment out the `COGNITO_*` lines, restore the
   `SQUAWK_*` lines, redeploy, confirm Squawk sign-in works, then switch back.
10. (Nathan) Remove the setup rights from step 1.

Migrations 129 (`users.cognito_sub`) and 131
(`users.cognito_totp_enrolled_at`) are already on stage.

At the moment of the switch (step 5), end every existing app session, so
nobody carries a pre-Cognito session, or a staff session that never passed the
authenticator rule, across the cutover:
`TRUNCATE user_sessions;` on the stage database. Everyone signs in again.

### Prod (ai-therapist-399), after stage has run on Cognito

Prod has three accounts (one researcher, two participants) and runs the
legacy login today. Each promotion to prod needs Nathan's go-ahead.

1. (Nathan) Tell the two participants a new password is coming, and how they
   will get it. They have no email on file.
2. Take a manual RDS snapshot (`ai-therapist-pre-cognito-YYYYMMDD`), wait for
   `available`, and apply migrations 129 and 131 to `ai_therapist_prod`.
3. (Nathan) Setup rights as on stage, then
   `scripts/cognito/create-pool.sh prod https://ai.byuisresearch.com <domain-prefix>`.
4. (Nathan) An identity for the app with `iam-app-policy.json` naming the prod
   pool: either the instance's existing identity or a key pair set as
   `COGNITO_AWS_*` in `/opt/ai-therapist/.env`.
5. `scripts/cognito/create-first-researcher.sh <prod-pool-id> <researcher username>`.
6. Promote the Cognito code to prod (`git push origin main:prod`) with the
   `COGNITO_*` variables still unset: nothing changes yet.
7. Add the `COGNITO_*` values to `/opt/ai-therapist/.env` and redeploy through
   the pipeline. From this moment the legacy login answers 410. In the same
   step run `TRUNCATE user_sessions;` on prod (Nathan's go-ahead: it signs
   everyone out), so no pre-Cognito session outlives the switch.
8. Sign in as the researcher, set up the authenticator app, then set a new
   password for each participant in User Management (this creates their pool
   accounts) and pass the passwords on by the channel agreed in step 1.
9. Confirm `https://ai.byuisresearch.com/health/deep` is 200 and one
   participant sign-in works.

Rollback at any point after step 7: remove the `COGNITO_*` lines and redeploy.
The legacy login works again against the local password hashes, which every
password change above also updated.

## Not built yet

- The pools themselves (ai-therapist-394). The script exists; see Creating a pool.
- A bulk move of the accounts that exist before a pool does. One at a time
  works: a new password moves an account (see Account changes). The first
  researcher account in a new pool has to be created by hand, because nobody
  can sign in to User Management before it exists (ai-therapist-398, 399).
- An authenticator app for participants who want one (optional by decision):
  nothing offers it yet.
- Rollback rehearsal on stage (ai-therapist-398). The intended rollback is to
  remove the `COGNITO_*` variables and redeploy; the legacy login works again
  because the local hashes are untouched.

## Cost

Checked 2026-11-25 against the AWS pricing page: the Essentials tier (the
default for new pools, and the lowest tier with the hosted managed login and
passkeys) is free for the first 10,000 monthly active users per account. The
study has 3 prod accounts. The Plus tier has no free allowance and is not used.
