# Researcher email on the study domain

Staff accounts (researcher, therapist, caseworker) can hold an email address
on `byuisresearch.com`, the study's own domain. Mail for that domain is sent
and received by the `email-api` gateway (SES, production access granted;
receiving is catch-all, so any `name@byuisresearch.com` is deliverable with no
per-address setup — verified 2026-11-01). Participants never get an address:
they are anonymous by design, and the service refuses the participant role
whoever asks.

Tracked as ai-therapist-283, in three phases.

## Phase 1 — addresses and notifications (shipped 2026-11-01)

- `users.email` (migration 119; unique, case-insensitive; nullable).
- Admin Users view: an Email column, an Email field on the edit dialog for
  staff roles, and a **Provision** action that assigns
  `<slug>@byuisresearch.com` (`researcherEmail.service.studyAddressSlug`:
  lower-cased username, `[a-z0-9.-]` only, `-2`, `-3`, … when taken;
  idempotent for an account already on the domain). Routes: `PUT
  /api/users/:id { email }` (researcher only; `null` clears) and `POST
  /api/users/:id/provision-email` (researcher only). `STUDY_EMAIL_DOMAIN`
  overrides the domain for another deployment.
- Notifications (`notification.service`) now resolve the recipient address as
  `users.email` first, then the old email-shaped-username fallback, behind the
  unchanged `notification_email_recipients` gate (migration 119 adds
  `byuisresearch.com` to its allowlist; the gate's `enabled` flag is still
  seeded off and is a Nathan decision). Email bodies remain PHI-free.

## Phase 2 — compose and send from the admin app (planned)

`POST /admin/api/mail/send` for researchers, from their provisioned address
through `email-api`, with an `outbound_mail` audit table, a per-user daily
cap, and a Mail tab whose compose form carries a standing warning: no
participant content in email, ever.

## Phase 3 — per-researcher inbox (planned)

`email-api` gains an exact `to=` filter on `GET /inbox`; the app proxies
list / read / mark-read / reply scoped to the researcher's own address and
renders message text as untrusted (text only, no HTML).
