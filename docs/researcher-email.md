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

## Phase 2 — compose and send from the admin app (shipped 2026-11-01)

A researcher with a provisioned study address writes to outside parties from
it. Admin nav: People → Mail (`MailView.tsx`).

- `POST /admin/api/mail/send { to, cc?, subject, text, in_reply_to? }`,
  `GET /admin/api/mail/me` (address, cap, whether sending is possible and why
  not), `GET /admin/api/mail/sent` (the caller's own messages). Researcher
  only; self-scoped.
- `mailCompose.service.sendStaffMail` enforces: researcher role; an address on
  the study domain (the gateway's SES policy only sends from it); at most 10
  recipients; subject ≤ 200 and body ≤ 20,000 characters; a body that carries
  nothing shaped like a participant session id (`live_…`, `grok_…`,
  `chat_…`); and `STAFF_MAIL_DAILY_CAP` messages per sender per UTC day
  (default 50). The From is `<username> (AI Therapist Study) <address>` with
  Reply-To the address; `in_reply_to` threads a reply via In-Reply-To /
  References.
- Every message is recorded in `outbound_mail` (migration 120) with the
  gateway's verdict — `sent`, `queued` (email-api spools and retries itself)
  or `failed` (the request is refused with the gateway's reason). The row is
  the study's correspondence record and survives account deletion.
- `emailer.sendMailFrom` is the explicit-sender path (cc, reply-to, headers);
  it ignores the `email_notifications` kill switch, which governs notification
  traffic only.
- Policy, stated on every compose: participant content never goes into
  email. The session-id guard is the mechanical part; the author is
  responsible for the rest.

## Phase 3 — per-researcher inbox (planned)

`email-api` gains an exact `to=` filter on `GET /inbox`; the app proxies
list / read / mark-read / reply scoped to the researcher's own address and
renders message text as untrusted (text only, no HTML).
