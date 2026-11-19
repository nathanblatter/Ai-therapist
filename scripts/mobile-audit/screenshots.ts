// Phone-size screenshots of the participant and admin apps (docs/mobile-audit).
//
// Drives headless Chromium (Playwright) against a LOCAL dev server whose
// database was seeded by scripts/mobile-audit/seed.ts. Never point it at stage
// or prod. No model is ever called: live sessions are rendered by mocking the
// browser side of the server API (the Grok voice proxy socket and the chat
// routes), so every transcript, tool overlay and orb state below is fixture
// data. Screens no browser path can reach (the content-filter recovery screen,
// quiet hours, study-status blocks) render through harness.tsx.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3791 OUT_DIR=docs/mobile-audit/after \
//     npx tsx scripts/mobile-audit/screenshots.ts [--only participant|admin] [--widths 390,360,1280]
//
// Needs the Chromium build once: npx playwright install chromium-headless-shell
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type WebSocketRoute } from 'playwright';
import { MOBILE_AUDIT_ACCOUNTS as ACCOUNTS } from './accounts';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3791';
const OUT = path.resolve(process.env.OUT_DIR || 'docs/mobile-audit/before');
const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY = argValue('--only');
const DEVICES: Record<string, { width: number; height: number; mobile: boolean }> = {
  '390': { width: 390, height: 844, mobile: true }, // iPhone 14/15
  '360': { width: 360, height: 740, mobile: true }, // small Android
  '1280': { width: 1280, height: 800, mobile: false }, // desktop regression check
};
const WIDTHS = (argValue('--widths') || '390,360').split(',');
const SCREEN_FILTER = argValue('--screens')?.split(',');

type Role = keyof typeof ACCOUNTS | 'anon';
interface Scene {
  name: string;
  role: Role;
  /** Reduced viewport height (on-screen keyboard simulation). */
  height?: number;
  run: (page: Page) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sign in once per role and reuse the session cookie: the login and magic-link
// routes are rate limited, and a fresh context per scene keeps scenes isolated.
const cookieCache = new Map<Role, Awaited<ReturnType<BrowserContext['cookies']>>>();

async function login(context: BrowserContext, role: Role) {
  if (role === 'anon') return;
  const cached = cookieCache.get(role);
  if (cached) {
    await context.addCookies(cached);
    return;
  }
  await freshLogin(context, role);
  cookieCache.set(role, await context.cookies());
}

async function freshLogin(context: BrowserContext, role: Exclude<Role, 'anon'>) {
  const { username, password } = ACCOUNTS[role];
  const res = await context.request.post(`${BASE}/api/auth/login`, { data: { username, password } });
  if (!res.ok()) throw new Error(`login ${username} failed: ${res.status()}`);
}

async function settle(page: Page, ms = 600) {
  // Socket.io long-polling keeps the network busy, so cap the idle wait.
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
  await sleep(ms);
}

// ---------------------------------------------------------------------------
// Session mocks (browser side only; nothing reaches the model or the DB)
// ---------------------------------------------------------------------------

const LONG_CONVERSATION: Array<{ role: 'user' | 'assistant'; text: string }> = [
  {
    role: 'assistant',
    text: "Hi, I'm an AI support assistant for this research study. I'm not a therapist, and if you're in danger please call or text 988. What's on your mind today?",
  },
  { role: 'user', text: "Work has been really stressful. I can't switch off at night." },
  {
    role: 'assistant',
    text: 'That sounds exhausting. When you lie down at night, what tends to show up first: thoughts about tomorrow, or replaying what happened during the day?',
  },
  { role: 'user', text: 'Mostly replaying conversations and worrying I said the wrong thing.' },
  {
    role: 'assistant',
    text: 'Replaying conversations is really common when we care about how we come across. Would it help to try a short breathing exercise together, or would you rather talk through one of those conversations first?',
  },
  {
    role: 'user',
    text: 'Maybe talk through one. There was a meeting today where my manager pushed back on my plan in front of everyone.',
  },
  {
    role: 'assistant',
    text: 'That would sting. What went through your mind in the moment, and what did you feel in your body?',
  },
  { role: 'user', text: 'I felt my face get hot. I thought everyone could see I had no idea what I was doing.' },
  {
    role: 'assistant',
    text: '"Everyone could see I had no idea what I was doing" is a heavy thought to carry. If a friend told you that same story, what might you say to them?',
  },
];

async function mockVoiceSession(page: Page): Promise<() => WebSocketRoute | null> {
  let socket: WebSocketRoute | null = null;
  await page.route('**/api/config/ai-model', (r) => r.fulfill({ json: { voice_backend: 'grok' } }));
  await page.route('**/api/grok/session', (r) =>
    r.fulfill({
      json: {
        session_id: 'mock-voice',
        ws_path: '/api/grok/voice/mock-voice',
        session_limits: { max_duration_minutes: 30 },
      },
    }),
  );
  await page.route('**/api/sessions/mock-voice/**', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/grok/session/mock-voice/**', (r) => r.fulfill({ json: { ok: true } }));
  await page.routeWebSocket(/\/api\/grok\/voice\//, (ws) => {
    socket = ws;
    ws.onMessage(() => undefined); // swallow mic PCM
    setTimeout(() => ws.send(JSON.stringify({ type: 'ready', model: 'mock' })), 300);
  });
  return () => socket;
}

function sendTranscript(ws: WebSocketRoute, turns: typeof LONG_CONVERSATION) {
  turns.forEach((t, i) =>
    ws.send(JSON.stringify({ type: 'transcript', role: t.role, itemId: `item-${i}`, text: t.text, final: true })),
  );
}

/** ~200 ms of a 220 Hz tone as PCM16 @ 24 kHz, so the orb sees assistant audio. */
function toneChunk(): Buffer {
  const n = 4800;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 24000) * 12000), i * 2);
  return buf;
}

async function mockChatSession(page: Page) {
  await page.route('**/api/config/features', async (r) => {
    const res = await r.fetch();
    const json = await res.json();
    await r.fulfill({ json: { ...json, voice_enabled: false } });
  });
  await page.route('**/api/chat/start', (r) =>
    r.fulfill({ json: { sessionId: 'mock-chat', opening: LONG_CONVERSATION[0].text } }),
  );
  await page.route('**/api/chat/end', (r) => r.fulfill({ json: { ok: true } }));
  const queue: Array<{ response: string; toolEvents?: Array<{ name: string; args?: unknown }> }> = [];
  await page.route('**/api/chat/message', (r) =>
    r.fulfill({ json: queue.shift() ?? { response: 'Thank you for sharing that.' } }),
  );
  return queue;
}

async function startFromHome(page: Page) {
  await page.getByRole('button', { name: /Start new therapy session/i }).click();
  await sleep(500);
  // Consent (only for an account without one on file), then the check-in.
  const consent = page.getByText('Before we begin');
  if (await consent.isVisible().catch(() => false)) {
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: /I agree/i }).click();
    await sleep(500);
  }
}

async function skipCheckin(page: Page) {
  await page.getByRole('button', { name: /^Skip/i }).click();
}

async function openVoice(page: Page) {
  const ws = await mockVoiceSession(page);
  await page.goto(`${BASE}/`);
  await settle(page);
  await startFromHome(page);
  await skipCheckin(page);
  await page.waitForSelector('#textMessageInput, [aria-label*="Microphone"]', { timeout: 15000 });
  await sleep(500);
  return ws;
}

async function openChat(page: Page, fill = true) {
  const queue = await mockChatSession(page);
  await page.goto(`${BASE}/`);
  await settle(page);
  await startFromHome(page);
  await skipCheckin(page);
  await page.waitForSelector('#textMessageInput', { timeout: 15000 });
  if (fill) {
    for (let i = 1; i + 1 < LONG_CONVERSATION.length; i += 2) {
      queue.push({ response: LONG_CONVERSATION[i + 1].text });
      await page.fill('#textMessageInput', LONG_CONVERSATION[i].text);
      await page.keyboard.press('Enter');
      await sleep(150);
    }
  }
  await sleep(400);
  return queue;
}

async function chatTool(page: Page, name: string, toolArgs: unknown = {}) {
  const queue = await openChat(page, false);
  queue.push({ response: "Let's try something together.", toolEvents: [{ name, args: toolArgs }] });
  await page.fill('#textMessageInput', 'Okay, let us try it.');
  await page.keyboard.press('Enter');
  await sleep(900);
}

// ---------------------------------------------------------------------------
// Harness (screens with no browser-reachable path)
// ---------------------------------------------------------------------------

async function harness(page: Page, screen: string) {
  const entry = path.join(here, 'harness.tsx');
  const css = path.resolve(here, '../../src/client/shared/base.css');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(t)=>t;window.__vite_plugin_react_preamble_installed__=true;</script>
<script type="module" src="/@vite/client"></script>
<link rel="stylesheet" href="/@fs${css}" />
</head><body><div id="root"></div><script type="module" src="/@fs${entry}"></script></body></html>`;
  await page.route(`${BASE}/__mobile_harness*`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${BASE}/__mobile_harness?screen=${screen}`);
  await page.waitForSelector('[data-harness-ready]', { timeout: 20000 });
  await sleep(400);
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

async function adminView(page: Page, label: RegExp) {
  await page.goto(`${BASE}/admin`);
  await settle(page, 900);
  // The phone drawer is translated off-screen, not hidden, so test the toggle.
  const menu = page.getByRole('button', { name: 'Open navigation menu' });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await sleep(400);
  }
  await page.locator('aside nav').getByRole('button', { name: label }).first().click();
  await settle(page, 900);
}

const participantScenes: Scene[] = [
  { name: 'p01-login', role: 'anon', run: async (p) => void (await p.goto(`${BASE}/login`), await settle(p)) },
  {
    name: 'p02-login-keyboard',
    role: 'anon',
    height: 480,
    run: async (p) => {
      await p.goto(`${BASE}/login`);
      await settle(p);
      await p.focus('#username');
    },
  },
  { name: 'p03-home-new', role: 'newcomer', run: async (p) => void (await p.goto(`${BASE}/`), await settle(p, 1000)) },
  {
    name: 'p04-consent',
    role: 'newcomer',
    run: async (p) => {
      await p.goto(`${BASE}/`);
      await settle(p);
      await p.getByRole('button', { name: /Start new therapy session/i }).click();
      await sleep(700);
    },
  },
  { name: 'p05-home', role: 'participant', run: async (p) => void (await p.goto(`${BASE}/`), await settle(p, 1000)) },
  {
    name: 'p06-home-scrolled',
    role: 'participant',
    run: async (p) => {
      await p.goto(`${BASE}/`);
      await settle(p, 1000);
      await p
        .locator('main .overflow-y-auto')
        .first()
        .evaluate((el) => el.scrollTo(0, el.scrollHeight / 2));
      await sleep(300);
    },
  },
  {
    name: 'p07-checkin',
    role: 'participant',
    run: async (p) => {
      await p.goto(`${BASE}/`);
      await settle(p);
      await startFromHome(p);
    },
  },
  {
    name: 'p08-session-settings',
    role: 'participant',
    run: async (p) => {
      await p.goto(`${BASE}/`);
      await settle(p);
      await p.getByRole('button', { name: /Open session settings/i }).click();
      await sleep(500);
    },
  },
  {
    name: 'p09-voice-idle',
    role: 'participant',
    run: async (p) => {
      const ws = await openVoice(p);
      sendTranscript(ws()!, LONG_CONVERSATION.slice(0, 1));
      await sleep(500);
    },
  },
  {
    name: 'p10-voice-listening',
    role: 'participant',
    run: async (p) => {
      const ws = await openVoice(p);
      sendTranscript(ws()!, LONG_CONVERSATION.slice(0, 3));
      await p.getByRole('button', { name: /Microphone off/i }).click();
      await sleep(700);
    },
  },
  {
    name: 'p11-voice-speaking',
    role: 'participant',
    run: async (p) => {
      const ws = await openVoice(p);
      sendTranscript(ws()!, LONG_CONVERSATION);
      const tone = toneChunk();
      for (let i = 0; i < 8; i++) {
        ws()!.send(tone);
        await sleep(120);
      }
    },
  },
  { name: 'p12-chat-long', role: 'participant', run: async (p) => void (await openChat(p)) },
  {
    name: 'p13-chat-keyboard',
    role: 'participant',
    height: 420,
    run: async (p) => {
      await openChat(p);
      await p.focus('#textMessageInput');
      await p.fill('#textMessageInput', 'I think I would tell them it was one meeting');
    },
  },
  {
    name: 'p14-breathing',
    role: 'participant',
    run: async (p) => {
      await chatTool(p, 'start_breathing_exercise', { duration_seconds: 60 });
      await sleep(1500);
    },
  },
  {
    name: 'p15-grounding',
    role: 'participant',
    run: async (p) => void (await chatTool(p, 'start_grounding_exercise')),
  },
  {
    name: 'p16-crisis-resources',
    role: 'participant',
    run: async (p) => void (await chatTool(p, 'show_resource_card', { resource_type: 'all' })),
  },
  {
    name: 'p17-thought-record',
    role: 'participant',
    run: async (p) => void (await chatTool(p, 'start_thought_record')),
  },
  {
    name: 'p18-scale',
    role: 'participant',
    run: async (p) => void (await chatTool(p, 'administer_scale', { scale: 'phq2' })),
  },
  {
    name: 'p19-safety-plan',
    role: 'participant',
    run: async (p) =>
      void (await chatTool(p, 'create_safety_plan', {
        warning_signs: ['Not sleeping', 'Skipping meals'],
        coping_strategies: ['Walk outside', 'Call my sister'],
        support_contacts: ['Sister', 'Roommate'],
        reasons_worth_living: ['My dog', 'Finishing school'],
      })),
  },
  {
    name: 'p20-journal',
    role: 'participant',
    run: async (p) => void (await chatTool(p, 'show_journaling_prompt', { prompt: 'What would you say to a friend?' })),
  },
  {
    name: 'p21-recap',
    role: 'participant',
    run: async (p) =>
      void (await chatTool(p, 'display_session_recap', {
        focus: 'Replaying work conversations at night',
        techniques: ['Cognitive reframing', 'Paced breathing'],
        takeaway: 'One meeting is not the whole story.',
      })),
  },
  {
    name: 'p22-post-session',
    role: 'participant',
    run: async (p) => {
      await openChat(p);
      await p.getByTitle('Disconnect').click();
      await sleep(1500);
    },
  },
  {
    name: 'p23-messages',
    role: 'participant',
    run: async (p) => {
      await p.goto(`${BASE}/`);
      await settle(p);
      const menu = p.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click();
        await p.getByRole('menuitem', { name: /Messages/ }).click();
      } else {
        await p
          .getByRole('button', { name: /Open messages/ })
          .first()
          .click();
      }
      await settle(p, 800);
    },
  },
  {
    name: 'p24-profile',
    role: 'participant',
    run: async (p) => void (await p.goto(`${BASE}/profile`), await settle(p, 1000)),
  },
  {
    name: 'p25-profile-scrolled',
    role: 'participant',
    run: async (p) => {
      await p.goto(`${BASE}/profile`);
      await settle(p, 1000);
      await p.evaluate(() => {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY !== 'visible')
            el.scrollTo(0, el.scrollHeight / 2);
        });
      });
      await sleep(300);
    },
  },
  {
    name: 'p26-menu',
    role: 'participant',
    run: async (p) => {
      await p.goto(`${BASE}/`);
      await settle(p);
      const menu = p.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) await menu.click();
      await sleep(400);
    },
  },
  { name: 'p27-moderation-recovery', role: 'anon', run: async (p) => void (await harness(p, 'moderation')) },
  { name: 'p28-quiet-hours', role: 'anon', run: async (p) => void (await harness(p, 'quiet')) },
  { name: 'p29-study-status', role: 'anon', run: async (p) => void (await harness(p, 'status')) },
  // Text hand-off after a vendor cut of a voice session (ai-therapist-356):
  // composed in harness.tsx from the real components, fixture messages.
  { name: 'p30-handoff-crisis', role: 'anon', run: async (p) => void (await harness(p, 'handoff-crisis')) },
  { name: 'p31-handoff-crisis-sent', role: 'anon', run: async (p) => void (await harness(p, 'handoff-crisis-sent')) },
  { name: 'p32-handoff-neutral', role: 'anon', run: async (p) => void (await harness(p, 'handoff-neutral')) },
  {
    name: 'p33-handoff-crisis-keyboard',
    role: 'anon',
    height: 480,
    run: async (p) => void (await harness(p, 'handoff-crisis')),
  },
  { name: 'p34-handoff-moving', role: 'anon', run: async (p) => void (await harness(p, 'moderation-text')) },
];

const adminScenes: Scene[] = [
  {
    name: 'a01-login',
    role: 'anon',
    run: async (p) => {
      await p.goto(`${BASE}/admin`);
      await settle(p);
    },
  },
  {
    name: 'a02-landing-therapist',
    role: 'therapist',
    run: async (p) => void (await p.goto(`${BASE}/admin`), await settle(p, 1200)),
  },
  {
    name: 'a03-nav-drawer',
    role: 'therapist',
    run: async (p) => {
      await p.goto(`${BASE}/admin`);
      await settle(p, 900);
      const menu = p.getByRole('button', { name: 'Open navigation menu' });
      if (await menu.isVisible().catch(() => false)) await menu.click();
      await sleep(400);
    },
  },
  { name: 'a04-escalations', role: 'therapist', run: async (p) => adminView(p, /^Escalations/) },
  {
    name: 'a05-escalation-detail',
    role: 'therapist',
    run: async (p) => {
      await adminView(p, /^Escalations/);
      await p.locator('main button').filter({ hasText: 'Assigned to' }).first().click();
      await settle(p, 900);
    },
  },
  { name: 'a06-crisis', role: 'therapist', run: async (p) => adminView(p, /Crisis Management/) },
  { name: 'a07-triage', role: 'therapist', run: async (p) => adminView(p, /^Triage/) },
  { name: 'a08-work-queue', role: 'therapist', run: async (p) => adminView(p, /Work Queue/) },
  {
    name: 'a09-participant-profile',
    role: 'therapist',
    run: async (p) => {
      await adminView(p, /^Triage/);
      await p
        .locator('main')
        .getByRole('button')
        .filter({ hasText: /sbx_|mobile_participant/ })
        .first()
        .click();
      await settle(p, 1200);
    },
  },
  { name: 'a10-caseload', role: 'therapist', run: async (p) => adminView(p, /^Caseload/) },
  { name: 'a11-messages', role: 'therapist', run: async (p) => adminView(p, /^Messages/) },
  { name: 'a12-sessions', role: 'therapist', run: async (p) => adminView(p, /^Sessions/) },
  {
    name: 'a13-session-detail',
    role: 'therapist',
    run: async (p) => {
      await adminView(p, /^Sessions/);
      await p.locator('main').getByRole('button', { name: /view/i }).first().click();
      await settle(p, 1200);
    },
  },
  { name: 'a14-live-monitor', role: 'demo', run: async (p) => adminView(p, /Live Monitoring/) },
  {
    name: 'a15-live-session',
    role: 'demo',
    run: async (p) => {
      await adminView(p, /Live Monitoring/);
      await p
        .getByRole('button', { name: /^Monitor session/ })
        .first()
        .click();
      await settle(p, 1200);
    },
  },
  { name: 'a16-analytics', role: 'demo', run: async (p) => adminView(p, /^Analytics/) },
  { name: 'a17-assistant', role: 'therapist', run: async (p) => adminView(p, /^Assistant/) },
  { name: 'a18-users', role: 'researcher', run: async (p) => adminView(p, /^Users/) },
  { name: 'a19-system-config', role: 'researcher', run: async (p) => adminView(p, /System Config/) },
  { name: 'a20-adverse-events', role: 'therapist', run: async (p) => adminView(p, /Adverse Events/) },
];

// ---------------------------------------------------------------------------
// Measurements (written next to the screenshots as metrics.json)
// ---------------------------------------------------------------------------

interface SceneMetrics {
  bodyFontPx: number;
  /** Visible text sizes in px -> number of elements using them. */
  textSizes: Record<string, number>;
  inputFontPx: number[];
  /** Interactive elements under 44x44 CSS px (label, w x h). */
  smallTargets: string[];
  /** Elements that stick out past the right edge of the viewport. */
  overflowX: string[];
}

function measure(): SceneMetrics {
  const vw = window.innerWidth;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0;
  };
  const label = (el: Element) =>
    (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('placeholder') || el.tagName)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  const textSizes: Record<string, number> = {};
  document.querySelectorAll('body *').forEach((el) => {
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 1);
    if (!own || !visible(el)) return;
    const px = String(Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10);
    textSizes[px] = (textSizes[px] || 0) + 1;
  });
  const smallTargets: string[] = [];
  document
    .querySelectorAll(
      'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=menuitem], [role=tab]',
    )
    .forEach((el) => {
      if (!visible(el) || el.closest('[aria-hidden="true"]')) return;
      const r = el.getBoundingClientRect();
      if (r.top > window.innerHeight) return;
      if (r.width < 44 || r.height < 44)
        smallTargets.push(`${label(el)} (${Math.round(r.width)}x${Math.round(r.height)})`);
    });
  const overflowX: string[] = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (overflowX.length >= 6 || !visible(el)) return;
    const r = el.getBoundingClientRect();
    let p = el.parentElement;
    let clipped = false;
    while (p) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') {
        clipped = true;
        break;
      }
      p = p.parentElement;
    }
    if (!clipped && r.right > vw + 1)
      overflowX.push(`${el.tagName.toLowerCase()} "${label(el)}" right=${Math.round(r.right)}`);
  });
  return {
    bodyFontPx: parseFloat(getComputedStyle(document.body).fontSize),
    textSizes,
    inputFontPx: Array.from(document.querySelectorAll('input:not([type=hidden]), textarea, select'))
      .filter(visible)
      .map((el) => parseFloat(getComputedStyle(el).fontSize)),
    smallTargets,
    overflowX,
  };
}

const metrics: Record<string, SceneMetrics> = {};

function writeMetrics() {
  const file = path.join(OUT, 'metrics.json');
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const merged = { ...previous, ...metrics };
  const sorted = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((k) => [k, merged[k]]),
  );
  fs.writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
}

async function runScene(browser: Browser, scene: Scene, width: string) {
  const d = DEVICES[width];
  const context = await browser.newContext({
    viewport: { width: d.width, height: scene.height ?? d.height },
    deviceScaleFactor: 2,
    isMobile: d.mobile,
    hasTouch: d.mobile,
    permissions: ['microphone'],
  });
  context.setDefaultTimeout(12000);
  // The sandbox welcome callout would push every admin screen down; it is
  // one-time onboarding, so capture the screens as a returning user sees them.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('sandbox-onboarding-dismissed', '1');
    } catch {
      /* ignore */
    }
  });
  const page = await context.newPage();
  const file = path.join(OUT, `${scene.name}-${width}.png`);
  try {
    await login(context, scene.role);
    await scene.run(page);
    // Park the pointer so no :hover style from the last click leaks into the shot.
    await page.mouse.move(0, 0).catch(() => undefined);
    await page.screenshot({ path: file });
    // tsx (esbuild keepNames) wraps inner functions in __name(); give the page a no-op.
    await page.evaluate('window.__name = window.__name || ((f) => f)');
    metrics[`${scene.name}-${width}`] = await page.evaluate(measure);
    writeMetrics();
    console.log(`ok   ${scene.name}-${width}`);
  } catch (err) {
    await page.screenshot({ path: file.replace(/\.png$/, '.FAILED.png') }).catch(() => undefined);
    console.log(`FAIL ${scene.name}-${width}: ${(err as Error).message.split('\n')[0]}`);
  } finally {
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const scenes = [
    ...(ONLY === 'admin' ? [] : participantScenes),
    ...(ONLY === 'participant' ? [] : adminScenes),
  ].filter((s) => !SCREEN_FILTER || SCREEN_FILTER.some((f) => s.name.startsWith(f)));
  try {
    // Widths run side by side; scenes within a width run in order.
    await Promise.all(
      WIDTHS.map(async (width) => {
        for (const scene of scenes) await runScene(browser, scene, width);
      }),
    );
  } finally {
    await browser.close();
  }
}

await main();
