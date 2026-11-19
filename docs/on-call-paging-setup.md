# On-call paging: channels and AWS SMS setup

How on-call staff are reached, and exactly what the AWS account owner has to do
before the second channel can be switched on. Code: `src/server/services/crisisAlert.service.ts`
(transport), `crisisPaging.service.ts` (policy), `src/server/utils/smsText.ts` (SMS text).
What a page means and what to do about one: `docs/on-call-sop.md`.

## The two channels

Every page is sent on every configured channel **at the same time**, to the same on-call
phone (System Config → `crisis_alert.phone`, else `CRISIS_ALERT_PHONE`).

| Channel | What it is | Configured by | Failure it covers |
| --- | --- | --- | --- |
| `imessage` | The iMessage bridge on the Mac mini | `IMESSAGE_API_KEY` (+ `IMESSAGE_API_URL`) | AWS down, number unverified, spend limit hit |
| `aws_sms` | Carrier SMS through AWS End User Messaging (`SendTextMessage`) | `CRISIS_SMS_AWS_REGION` + `CRISIS_SMS_ORIGINATION_IDENTITY` | The mini down, asleep or off the tailnet |

- **Inert until configured.** With either `CRISIS_SMS_*` variable unset the AWS channel does not
  exist: the SDK is never loaded and nothing differs from before it was added.
- **Delivered** means at least one channel accepted the page (the bridge returned 2xx, or AWS
  returned a message id). That is what the 15-minute folding rule uses. Neither channel confirms
  the text reached the handset.
- **Recorded.** Each page's `crisis_sms_alert` row lists, under `action_details.paging.channels`,
  every channel attempted, whether it accepted, an error code if not, and the AWS message ids.
  No phone number and no message text are stored there.
- **A failed channel is surfaced.** All channels failed: nobody was texted; an error-level log
  line `ON-CALL PAGE NOT DELIVERED`, a `system:on-call-paging-failed` event to the researcher
  room, and for a participant page a "Page NOT delivered" notice in Live Monitoring. One channel
  failed: the page went out, and the same places say paging is degraded.
- **One kill switch.** `crisis_alert.enabled = false` turns both channels off.
- **The harness never pages.** `src/redteam/cli.ts`, `replay.ts`, `goldens/cli.ts` and
  `scripts/participant-sim` force all four paging variables to empty; CI carries none of them.

### SMS text

The SMS carries everything the bridge message says. Pages are plain 7-bit text (no participant
name, no transcript text; a session id prefix, scores and the admin link, as before). A page of
up to 306 characters (two GSM-7 segments) is one SMS, worded exactly as the bridge message. A
longer one is deliberately split into numbered parts, `(1/2) ...`, each within two SMS
segments, sent in order. Because carriers do not guarantee the order parts arrive in, **part 1
stands on its own**: the headline with the severity, who is at risk, what changed, the `Why:`
line and the admin link (or, when the link cannot fit, `Open Crisis Management: session
<id prefix>...`, with the link opening part 2). To fit, part 1 may use shorter wording for
those lines, written into the page builders (`crisisPaging.service.ts` `compose*Page`); the
full wording follows in the later parts. `docs/on-call-sop.md` section 1 says what each part
contains and `docs/crisis.md` has examples. Today's participant pages are 1 to 4 parts. The
SMS channel counts as accepted only when every part was.

Tapping the admin link while signed out opens the sign-in page; after signing in, the
on-call staff member lands on the session or participant profile the link names (the
link's `#session=` / `#participant=` hash is carried across sign-in in that browser tab for
up to 15 minutes; `docs/squawk-auth.md`, "Signed out on a staff link").

### Why `SendTextMessage` and not SNS `Publish`

AWS's own guidance for new messaging work is to use AWS End User Messaging directly; SNS sends
SMS through the same service and adds a publish/subscribe layer this use has no need for. The
direct API is synchronous and returns a `MessageId` (or a named error such as a throttle) in the
call, which is what lets each page's row record what the channel did. It also allows an IAM
permission scoped to one sending number. Amazon Pinpoint is closed to new customers and ends
support on 2026-10-30. Client: `@aws-sdk/client-pinpoint-sms-voice-v2`, on the same version
line as the existing `@aws-sdk/client-s3`.

## What the account owner must do in AWS

Nothing in the code or in this change performs any of these; they are account changes and
commit spend. Do them in the region you will put in `CRISIS_SMS_AWS_REGION` (SMS resources are
per region). Console: **AWS End User Messaging → SMS**.

1. **Request a toll-free number** (Phone numbers → Request originator → United States →
   Toll-free, SMS, outbound). This is the origination identity. A 10DLC number also works but
   needs brand and campaign registration, which is slower.
2. **Submit the toll-free verification (registration)** for that number. Use case: internal
   on-call alerts to study staff who have agreed to receive them; low volume; no marketing. US
   carriers do not deliver from an unverified toll-free number. Review typically takes days to
   a couple of weeks; the number cannot be relied on until it shows as verified.
3. **Request production access** (leave the SMS sandbox): a Support case of type *Service limit
   increase*, category *AWS End User Messaging SMS*, limit *SMS Production Access*, for this
   region. In the sandbox the account can only text verified destination numbers and is capped
   at $1 a month.
4. **Set the monthly SMS spending limit** to something that fits paging (a few dollars is ample;
   a page is 1 to 3 messages). Raising the account limit is part of the same kind of Support
   request; then set the enforced limit under Account settings. If the limit is reached, AWS
   refuses sends and this channel fails (the bridge still pages, and the failure is reported).
5. **IAM: allow sending and nothing else.** Attach to the identity the app runs as (the role or
   user whose credentials the app's AWS SDK already resolves) a policy with the single action
   `sms-voice:SendTextMessage`, with `Resource` set to the ARN of the toll-free number. No
   describe, no account or number management. The app reads credentials through the standard
   AWS provider chain; do not add new key variables for this. The IAM reference lists five
   resource types for this action (phone number, pool, sender ID, configuration set, protect
   configuration). If the account has a default configuration set or protect configuration,
   the call is also authorized against that resource; if the test page fails with
   `AccessDeniedException` and the number ARN is in the policy, add that resource's ARN too.
6. **For testing before verification lands:** while the account is in the sandbox, add the
   on-call phone as a *verified destination number* (Sandbox → Add destination, confirm the
   code). That lets the test page below go through.
7. **Opt-in and STOP.** Have each on-call researcher agree to receive these texts (the
   toll-free verification form asks how). A recipient who replies STOP is opted out by the
   carrier and AWS will refuse sends to them; that shows as a failed `aws_sms` channel.

Cost, to confirm against current AWS pricing before committing: about $2 a month for the
toll-free number plus roughly a cent per message part.

## Switching it on

1. In the environment's `.env` (stage or prod; never dev or CI) set
   `CRISIS_SMS_AWS_REGION` and `CRISIS_SMS_ORIGINATION_IDENTITY` (the number in E.164, or its
   ARN). Make sure the on-call phone is in E.164 (`+1...`) or a 10-digit US number.
2. Deploy through the pipeline as usual so the app restarts with the new environment.
3. Send a test page (next section) and confirm with the on-call that both texts arrived.

To switch it off again, remove either variable and redeploy.

## Test page

```
docker compose exec app npm run page:test
```

Sends one clearly labelled text per configured channel, each naming its channel
("TEST PAGE: ... NOT a participant event ... Channel: AWS SMS."), and prints per-channel
results: accepted or failed, the error code, the AWS message id. Exit code 0 when every
configured channel accepted, 1 when one failed, 2 when nothing was sent (paging disabled, no
on-call phone, or no channel configured). It prints no phone number and no credential.

It is a command-line script and nothing else: no HTTP route, socket event or model tool sends
a test page, so it cannot be triggered from a participant session. It texts a real phone, so
run it only on stage or prod, and tell the on-call first.

Run it after every on-call handoff, after any change to paging configuration, and after a
deploy that touches the crisis path.

## If texts stop

| Symptom | Likely cause | Check |
| --- | --- | --- |
| `aws_sms (AccessDeniedException)` | IAM permission missing or scoped to another number | step 5 |
| `aws_sms (ValidationException)` or `ResourceNotFoundException` | wrong region or origination identity; sandbox and the destination is not verified | `.env`, steps 3 and 6 |
| `aws_sms (ServiceQuotaExceededException)` | monthly spending limit reached | step 4 |
| `aws_sms (ConflictException)` | the recipient opted out (replied STOP), or the number is not yet usable | step 7, step 2 |
| `aws_sms (invalid_destination)` | the on-call phone is not a phone number AWS accepts | System Config → `crisis_alert.phone` |
| `aws_sms (timeout)` / `ThrottlingException` | AWS slow or rate limiting | retry the test page |
| `imessage (http_...)`, `imessage (timeout)`, `imessage (error)` | the bridge or the Mac mini is down, or off the tailnet | the mini, the bridge service |
| nothing attempted, "not configured" | no channel variables in this environment, or no on-call phone | `.env`, System Config |
