# Sign-in through Amazon Cognito

Status (2026-11-25): the server sign-in flow, the login page's Cognito mode
and the mirroring of account changes to the pool are built and unit-tested.
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
`sign_in_failed`, `invalid_token`, `no_role`, `no_account`, `server_error`.
Nothing Cognito sends is echoed into the URL.

With the `COGNITO_*` variables set, the legacy `POST /api/auth/login` answers
`410` before it looks at the local hash. With them unset (local dev, tests, CI)
nothing changes.

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
- **Accounts that are not in the pool.** A password or role change for an
  account the pool does not have answers `502` "This account does not exist in
  the sign-in service" (the local change stands). Nothing creates a pool user
  for an account that existed before the pool: how the existing accounts move
  is not built (see Not built yet).
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

Pool side, per app client: callback URL `{APP_URL}/api/auth/cognito/callback`,
sign-out URL `{APP_URL}/login`, authorization-code grant, scope `openid`,
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

As of 2026-11-25 the script has **not been run**: it passes a shell syntax
check only. The study's `nathan` IAM user has no Cognito permissions, so the
first run on stage is also the first test of every option in it.

Two sets of AWS permissions are involved, both granted by Nathan:

- **One-time setup**: whoever runs the script needs to administer Cognito in
  the study account (for example the AWS-managed `AmazonCognitoPowerUser`
  policy, attached for the setup and removed afterwards).
- **The running app**: `scripts/cognito/iam-app-policy.json`, limited to the
  user-management calls the app makes and to that environment's pool ARN. One
  copy per environment, each naming only its own pool.

## Not built yet

- The pools themselves (ai-therapist-394). The script exists; see Creating a pool.
- Moving the accounts that exist before a pool does into it. Their passwords
  cannot be copied (only hashes are stored), so each needs a pool user created
  and a new password set; nothing does that yet (ai-therapist-396).
- Staff TOTP reset (ai-therapist-396). A password reset from User Management
  works for an account that is in the pool (see Account changes).
- The security settings screen (Admin, MFA/Security) still shows the app's own
  TOTP setup and the Squawk passkey card; neither applies under Cognito
  (ai-therapist-397, with the staff TOTP rule on 396).
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
