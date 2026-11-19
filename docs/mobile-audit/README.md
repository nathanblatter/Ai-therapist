# Mobile audit (participant + admin), 2026-11-18

Tracking item: Flightdeck `ai-therapist-352`. Screens captured at **390x844**
(iPhone 14/15) and **360x740** (small Android), device scale factor 2, touch
enabled, plus **1280x800** for a desktop regression check. Every PNG is named
`<screen>-<width>.png`.

- Before: [`before/`](before/) (with `metrics.json`: computed font sizes, every
  interactive element under 44x44 CSS px, anything sticking out past the right edge)
- After: [`after/`](after/) (same scenes, same measurements, after the fixes in this PR)

The fixes ship as two PRs: the participant side plus the shared rules
(`base.css`, `BugReport.tsx`, the participant viewport meta) and these docs and
scripts first, then the admin side stacked on it. The `after/` admin
screenshots show both PRs applied.

## How the screenshots were made

Everything ran locally against a throwaway database (`rt_mobile_*`, built with
`src/database/scripts/migrateFromScratch.ts`), a dev server on an unused port and
a dummy `OPENAI_API_KEY`. No model was called and nothing touched stage or prod.

```bash
createdb -h localhost -U postgres rt_mobile_xxxx
DATABASE_URL=postgresql://postgres@localhost:5432/rt_mobile_xxxx npx tsx src/database/scripts/migrateFromScratch.ts
# dev server: PORT, DATABASE_URL, a dummy OPENAI_API_KEY, DEMO_MAGIC_TOKEN=mobileauditdemotoken123, no SQUAWK_* vars
DATABASE_URL=... BASE_URL=http://127.0.0.1:<port> npx tsx scripts/mobile-audit/seed.ts
npx playwright install chromium-headless-shell   # once
BASE_URL=http://127.0.0.1:<port> OUT_DIR=docs/mobile-audit/after npx tsx scripts/mobile-audit/screenshots.ts --widths 390,360
```

- `scripts/mobile-audit/seed.ts` creates a researcher, a brand-new participant (no
  consent on file), and a **therapist sandbox account** through the real
  `/join-sandbox` flow, whose deterministic sandbox seeder (no LLM) provides the
  caseload, crisis flag, escalation, notes and session history. One sandbox client
  is re-keyed as the participant login so Home and history have real-looking data.
  It refuses any database whose name does not start with `rt_`. Credentials live in
  `scripts/mobile-audit/accounts.ts` (local scratch only).
- **Live sessions are real `App.tsx` renders with the browser side mocked.** Voice:
  the script switches the client to the Grok voice path (`/api/config/ai-model`),
  answers `POST /api/grok/session`, and plays the proxy WebSocket itself
  (`page.routeWebSocket`): `ready`, transcript turns, and PCM16 tone frames so the
  orb shows "AI is speaking". Microphone is Chromium's fake device. Chat: the
  script forces `voice_enabled: false` and answers `/api/chat/start` and
  `/api/chat/message`; tool overlays (breathing, grounding, crisis resources,
  thought record, PHQ-2, safety plan, journal, recap) open through the chat
  `toolEvents` path exactly as a model tool call would.
- **Harness (dev-only):** `scripts/mobile-audit/harness.tsx` renders the screens no
  browser-side mock can reach, with fixture props: the content-filter recovery
  screen (`ModerationRecoveryScreen`, stage `failed`), quiet hours, and the
  study-status block. It is loaded through the dev server's Vite `/@fs` path by
  the screenshot script and is never bundled or routed.
- Admin: the therapist sandbox account for the care-team path (triage,
  escalations, crisis register, work queue, profile, messages, assistant), the
  magic-link **demo** account for Live Monitoring and an active session (its
  admin API is synthetic fixtures), and the researcher for Users and System
  Config.
- The keyboard-open cases (`p02`, `p13`) are a reduced viewport height (480 and
  420 px), which is what Chrome Android does with `interactive-widget=resizes-content`;
  iOS Safari behaves differently (it overlays the keyboard and scrolls the
  focused input into view), which headless Chromium cannot reproduce.

### Could not capture

- The GPT-Live (WebRTC) voice path itself: it needs a real vendor SDP answer. The
  session screen is the same component tree under both voice backends, so the
  Grok-path captures stand in for it.
- An in-session crisis takeover pushed by the server (`session:crisis-emergency`
  over Socket.io). It opens the same resource card as `p16`, so `p16` is that
  screen.
- The admin crisis alert banner in Live Monitoring and the on-call SMS deep link
  (`/admin#session=<id>`), both of which need a real crisis event in flight; the
  deep link lands on the same `SessionDetail` dialog as `a13`/`a15`.
- Real iOS safe-area insets (notch, home indicator): headless Chromium reports 0
  for `env(safe-area-inset-*)`, so the safe-area changes are verified by reading
  the CSS, not by pixels.

## Ranked findings

Severity: **Blocks** (a task fails or is likely to go wrong), **Hard** (doable,
but cramped, error-prone or slow), **Cosmetic**. Effort: **S** (class changes in
one file), **M** (layout change in one component), **L** (new pattern or design
decision). Screenshot names refer to `before/` and `after/`, at 390 unless
noted. Sizes are CSS px, from `metrics.json` or measured on the PNG.

| # | Severity | Effort | Screen | Finding | File | Status |
|---|---|---|---|---|---|---|
| 1 | Hard | S | every screen, both apps | The root size is `0.9rem` and `body` is `0.9rem` of that, so body copy renders at **12.96px**, `text-sm` at 12.6px and `text-xs` at **10.8px** on a phone. Every input is 12.96px, which makes iOS Safari zoom the page when the participant taps the chat box, the login fields or the check-in fields. | `src/client/shared/base.css` | Fixed (phones only): 16px root and body, inputs at least 16px; desktop unchanged; an explicit accessibility font size still wins |
| 2 | Hard | S | `p12-chat-long`, `p11-voice-speaking` | The conversation never follows new turns. `ChatLog` has no scroll-to-bottom at all, so on a phone the newest reply lands below the fold and the participant has to scroll after every exchange. | `ChatLog.tsx` | Fixed: follows the newest turn while the reader is at the bottom; leaves them alone once they scroll back (scroll-back telemetry unchanged) |
| 3 | Hard | S | `p09`-`p13` | Session controls are **40x40** (End session, mic, send) with an **8px** gap, and End session is the bottom-left button right next to the mic toggle: one slip ends the session. | `SessionControls.tsx` | Size and spacing fixed (48x48, 12px gap). Placement is a design call: proposal B |
| 4 | Hard | L | `p09-voice-idle`, `p12-chat-long` | During a session the header (title, welcome, session ID, a large timer, a five-line disclaimer, Call 988, Menu) takes **251-287px of 844 (30-34%)**; with the orb row and the controls the transcript gets about half the screen. | `Header.tsx` | Session ID and timer shrunk on phones; still the biggest space cost (the now-legible disclaimer is slightly taller). Proposal A |
| 5 | Blocks | S | `a05-escalation-detail`, all admin | The admin header title wraps to **seven lines** at 390, making the header **192px**; with the sandbox banner, an escalation's Acknowledge and Resolve buttons sit at the very bottom of the first screen. This is the screen on-call staff open from a crisis page. | `AdminHeader.tsx` | Fixed: one-line truncated title, welcome line hidden on phones, icon-only logout, 44x44 buttons; header is 60px |
| 6 | Hard | M | `a15-live-session`, `a13-session-detail` | The session dialog (target of the on-call deep link `/admin#session=`) is a centered `h-5/6` card with a pinned navy header and a pinned steering and export footer, leaving **about 100px** of transcript on a phone. | `admin/components/SessionDetail.tsx` | Partly fixed: full screen on phones, tighter footer. Header and footer still crowd the transcript: proposal D |
| 7 | Hard | S | `p27-moderation-recovery`, `p28-quiet-hours`, `p29-study-status` | On the screens shown after a crisis cut-off and overnight, the crisis numbers (988, 741741, 911, CAPS) are inline text links **23x14** to **91x14** px. | `ModerationRecoveryScreen.tsx`, `QuietHoursScreen.tsx`, `StudyStatusScreen.tsx` | Fixed: 48px-tall hit areas, no visual change |
| 8 | Hard | S | `p19-safety-plan`, `p16-crisis-resources` | Safety plan card: the 988 and 741741 lines are 18-36px tall and do not look tappable; "Call 911" is plain text. Resource card: Call and Text sit side by side, so "Call 1-800-799-7233" wraps and its icon shrinks; all buttons are 36px. | `ToolOverlays.tsx` | Fixed: 44px underlined rows, 911 dialable; Call and Text stack on phones |
| 9 | Hard | S | `p04-consent`, `p07-checkin`, `p08`, `p17`-`p21` | Every participant overlay is a centered card with its primary action mid-screen; Cancel, Skip and primary buttons are **32-36px**. | `ConsentScreen.tsx`, `PreSessionCheckIn.tsx`, `ToolOverlays.tsx` (`Shell`), `SessionSettings.tsx` | Fixed: bottom sheets on phones (actions in thumb reach, safe-area aware, `dvh`), 44px buttons; desktop keeps the centered card |
| 10 | Hard | S | `p22-post-session` | Rating circles are **36x36** with 8px gaps; Skip is 32px. | `PostSessionScreen.tsx` | Fixed: 44x44 on phones |
| 11 | Hard | S | `p02-login-keyboard` | With the keyboard up the login page cannot scroll (`body` is `overflow: hidden`, page is `min-h-screen`), so the crisis line under Sign in is unreachable. | `Login.tsx` | Fixed: scrolls inside a `dvh` container |
| 12 | Hard | S | `a09-participant-profile` | The profile header squeezes the name block to ~100px: the meta line wraps word by word and the "Exports are logged" caption overlaps it. | `ParticipantProfile.tsx` | Fixed: actions wrap under the name |
| 13 | Hard | S | `a07-triage`, `a08-work-queue` | Triage and Work Queue have **no side gutter**: cards touch the screen edge (and sit flush against the sidebar on desktop). | `AdminApp.tsx` | Fixed on both (shared wrapper) |
| 14 | Hard | M | `p25-profile-scrolled` | Session history is a four-column table: dates wrap to five lines and the View button is cut off behind a horizontal scroll. | `Profile.tsx` | Not fixed (M): should become a card list on phones |
| 15 | Cosmetic | S | `a14-live-monitor`, `a06-crisis` | Four (live) and five (crisis) stat cards stack one per row, pushing the session table and event list a full screen down; the crisis title wraps to three lines. | `LiveMonitoring.tsx`, `CrisisManagement.tsx` | Fixed: 2-column stats, smaller title, 16px gutters |
| 16 | Hard | S | all admin | Header icon buttons are **34x34**, the hamburger 38x38, drawer items 38px; the notification dropdown (`w-80`, anchored to the bell) would open past the left edge of a phone. | `AdminHeader.tsx`, `NotificationBell.tsx`, `AdminApp.tsx` | Fixed: 44px targets; dropdown spans the screen on phones (dropdown not captured) |
| 17 | Hard | S | all | No `viewport-fit=cover` and no `env(safe-area-inset-*)` anywhere; admin is `h-screen` (`100vh`), so on iOS its bottom sits under the browser toolbar. | `index.html`, `admin.html`, `AdminApp.tsx`, headers, sheets | Fixed: `viewport-fit=cover`, `interactive-widget=resizes-content`, insets on headers, session controls, sheets and drawer, `h-dvh` |
| 18 | Hard | S | `p12`, `p13`, `a17-assistant-360` (after) | The feedback pill floats over the transcript just above the send button, and over the admin assistant's Ask button. | `BugReport.tsx` | Height fixed to 44; position is proposal F |
| 19 | Hard | M | `a08-work-queue` | Work queue filter chips are 26-32px, "View client" links 16px tall, row actions 36x28. | `WorkQueue.tsx`, `WorkItemRow.tsx` | Not fixed (M) |
| 20 | Hard | M | `a06-crisis` (after) | The crisis dashboard tab row wraps and runs off the right edge. | `CrisisManagement.tsx` | Not fixed (M): horizontal scroll or a select |
| 21 | Cosmetic | S | `a04-escalations` | Escalation filter pills are 36px tall. | `EscalationInbox.tsx` | Not fixed (S) |
| 22 | Cosmetic | M | `a12-sessions`, `a16-analytics`, `a18-users`, `a19-system-config` | Desktop analysis screens: View/Edit/Delete 28px, user rows 20px, crowded filters. Not needed on a phone; not broken after the type and header fixes. | various | Left desktop-first (proposal D) |
| 23 | Cosmetic | S | `p07-checkin` | The mood slider thumb is about 20px. | `PreSessionCheckIn.tsx` | Not fixed (S) |
| 24 | Cosmetic | S | `p03-home-new` | A first-time participant is greeted "Welcome back" (copy, noted while auditing). | `Home.tsx` | Not fixed |
| 25 | Cosmetic | S | `a05-escalation-detail` | The escalation shows "Client 6" and "Assigned: user 4" instead of usernames (data, noted while auditing). | `EscalationDetail.tsx` | Not fixed |

What already works: the breathing, grounding and body-scan overlays are
full-screen with a 44px close button (`p14`, `p15`); Call 988 is a 44px button
that never hides behind a menu; reduced motion is honored (`base.css`); the
admin already has a phone drawer; the participant app root is already `h-dvh`.
Dark mode and contrast were not audited beyond confirming the theme tokens are
untouched.

## Before and after

The code changes are Tailwind classes, one CSS block in `base.css`, the
viewport meta and the chat log's follow-the-latest-turn effect. Desktop checks
at 1280 (`*-1280.png`: p05, p07, p12, p14, p16, p22, p24, p27, a04-a07, a09,
a14, a15) are unchanged apart from the triage/work-queue gutter (#13), admin
drawer items 6px taller, and the transcript following new turns.

| Fix | Before | After |
|---|---|---|
| Type scale and inputs (#1), chat follows newest turn (#2), controls (#3) | `before/p12-chat-long-390.png` | `after/p12-chat-long-390.png` |
| Keyboard open (#1, #3) | `before/p13-chat-keyboard-390.png` | `after/p13-chat-keyboard-390.png` |
| Voice session (#3, #4) | `before/p11-voice-speaking-390.png` | `after/p11-voice-speaking-390.png` |
| Check-in as a bottom sheet (#9) | `before/p07-checkin-390.png` | `after/p07-checkin-390.png` |
| Consent (#9) | `before/p04-consent-360.png` | `after/p04-consent-360.png` |
| Crisis resources card (#8) | `before/p16-crisis-resources-360.png` | `after/p16-crisis-resources-360.png` |
| Safety plan (#8) | `before/p19-safety-plan-390.png` | `after/p19-safety-plan-390.png` |
| Content-filter recovery screen (#7) | `before/p27-moderation-recovery-390.png` | `after/p27-moderation-recovery-390.png` |
| Post-session ratings (#10) | `before/p22-post-session-390.png` | `after/p22-post-session-390.png` |
| Login with keyboard (#11) | `before/p02-login-keyboard-390.png` | `after/p02-login-keyboard-390.png` |
| Admin header, escalation detail (#5) | `before/a05-escalation-detail-390.png` | `after/a05-escalation-detail-390.png` |
| Session dialog (#6) | `before/a15-live-session-360.png` | `after/a15-live-session-360.png` |
| Participant profile header (#12) | `before/a09-participant-profile-390.png` | `after/a09-participant-profile-390.png` |
| Triage gutter (#13) | `before/a07-triage-390.png` | `after/a07-triage-390.png` |
| Crisis dashboard (#15) | `before/a06-crisis-360.png` | `after/a06-crisis-360.png` |
| Live monitor (#15) | `before/a14-live-monitor-390.png` | `after/a14-live-monitor-390.png` |

Interactive elements under 44px on the first screen at 390, before to after
(`metrics.json`, ignoring the off-screen admin drawer): chat session 8 to 3,
voice session 10 to 3, crisis resources 13 to 3, post-session 22 to 2, recovery
screen 4 to 0, escalation detail 7 to 0, crisis dashboard 8 to 0. Every input
is now 16px on phones (was 12.6-12.96px). What remains on participant session
screens is the two inline links in the header disclaimer (39px tall, inline
text) and the session-ID Copy button (28px).

## Proposals (design decisions for Nathan)

**A. The session-screen header on phones** (#4).
1. Collapse the header to its existing slim bar (title, timer, Call 988, expand)
   by default while a session is active on a phone. The collapse already exists
   and persists; only the in-session default changes.
2. As 1, and move the distress disclaimer into the session's opening message and
   the Home crisis card (the preamble already carries the 988 line).
3. Leave it; participants can collapse it themselves.

Recommendation: **1**. Call 988 stays one tap away and the transcript roughly
doubles. Check the IRB materials first in case the disclaimer must stay visible
during a session; 1 still keeps it one tap away.

**B. Where End session lives** (#3).
1. Keep it in the bar but at the far end from the mic, with an "End the
   session?" confirmation.
2. Move it into the slim header (top right, away from the thumb); the bar keeps
   only mic, text and send.
3. Leave it.

Recommendation: **1**: least disruptive, and the confirmation protects data
quality from sessions ended by accident.

**C. Participant navigation** (the Menu dropdown holds Crisis Resources,
Messages, Profile, Logout).
1. A bottom tab bar (Home, Messages, Profile) on phones, Call 988 kept in the
   header.
2. Keep the Menu button but open it as a bottom sheet.
3. Leave it.

Recommendation: **2** now (cheap, in thumb reach), **1** once participants use
Messages regularly.

**D. What the admin app should be on a phone.**
1. A deliberate on-call view: crisis queue, escalations, a participant's latest
   session transcript (full screen, collapsible header) and the work queue;
   other screens show a short "best on a larger screen" note but keep working.
2. Make every admin screen fully responsive.
3. Keep today's drawer with the fixes in these PRs.

Recommendation: **1**. It matches the vision (participant safety first,
analysis on desktop) and bounds the work to about five screens.

**E. Admin navigation on phones.**
1. A bottom bar for care-team roles (Triage, Escalations, Crisis, Messages,
   More).
2. Keep the drawer (it works, and the header is now one line).

Recommendation: **1** together with D1; otherwise 2.

**F. The feedback pill** (#18).
1. Move "Report a problem" into the Menu on phones.
2. Hide it during an active session on phones only.

Recommendation: **1**.

**G. Typeface.** The UI is monospace; at 16px a 360px screen fits about 34
characters per line, which is much of what "cramped" feels like in the
transcript. A system sans for body text on phones would fit about 45. Brand
decision, so not touched here.
