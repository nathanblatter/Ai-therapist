// The test-page command (ai-therapist-355): its report, its exit codes, and
// the two properties that make it safe: nothing in a participant's reach can
// send a test page, and the harness entry points blank the SMS channel the
// way they blank the bridge. Nothing is sent here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { formatTestPageReport } from './sendTestPage.js';
import type { TestPageReport } from '../services/crisisAlert.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');

const base: TestPageReport = {
  ok: true,
  enabled: true,
  hasPhone: true,
  configured: { imessage: true, aws_sms: true },
  channels: [
    { channel: 'imessage', ok: true, error: null, messageIds: [], parts: 1, partsAccepted: 1, ms: 180 },
    { channel: 'aws_sms', ok: true, error: null, messageIds: ['abc-123'], parts: 1, partsAccepted: 1, ms: 420 },
  ],
};

describe('formatTestPageReport', () => {
  it('every channel accepted: exit 0, one line per channel with the provider message id', () => {
    const { lines, exitCode } = formatTestPageReport(base);
    expect(exitCode).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('imessage: ACCEPTED in 180 ms');
    expect(text).toContain('aws_sms: ACCEPTED in 420 ms (1 of 1 message(s), message id abc-123)');
    expect(text).toMatch(/accepted by the provider is not the same as on the phone/);
  });

  it('a failed channel: exit 1 and it is named with its error', () => {
    const { lines, exitCode } = formatTestPageReport({
      ...base,
      ok: false,
      channels: [
        base.channels[0],
        { ...base.channels[1], ok: false, error: 'AccessDeniedException', messageIds: [], partsAccepted: 0 },
      ],
    });
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('aws_sms: FAILED (AccessDeniedException)');
    expect(lines.join('\n')).toContain('AT LEAST ONE CHANNEL FAILED');
  });

  it('nothing sent: exit 2, with the reason (disabled, no phone, no channel)', () => {
    const none = { ...base, ok: false, channels: [] };
    expect(formatTestPageReport({ ...none, enabled: false })).toMatchObject({ exitCode: 2 });
    expect(formatTestPageReport({ ...none, enabled: false }).lines.join('\n')).toMatch(/paging is switched off/);
    expect(formatTestPageReport({ ...none, hasPhone: false }).lines.join('\n')).toMatch(/no on-call phone/);
    expect(formatTestPageReport({ ...none, configured: { imessage: false, aws_sms: false } }).lines.join('\n')).toMatch(
      /no paging channel is configured/,
    );
  });
});

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('a test page cannot be triggered from a participant session', () => {
  it('sendTestPage is called from the command-line script and nowhere else in the app', () => {
    const callers = sourcesUnder(path.join(REPO, 'src'))
      .filter((file) => /\bsendTestPage\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO, file))
      .sort();
    // The definition, and the script. No route, socket handler, tool or client file.
    expect(callers).toEqual(['src/server/scripts/sendTestPage.ts', 'src/server/services/crisisAlert.service.ts']);
  });

  it('the script only sends when it is run directly, and is wired to one npm script', () => {
    const script = fs.readFileSync(path.join(here, 'sendTestPage.ts'), 'utf8');
    expect(script).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['page:test']).toBe('tsx src/server/scripts/sendTestPage.ts');
  });
});

describe('the harness can never text anyone on the SMS channel either', () => {
  for (const file of [
    'src/redteam/cli.ts',
    'src/redteam/replay.ts',
    'src/redteam/goldens/cli.ts',
    'scripts/participant-sim/run-sessions.ts',
  ]) {
    it(`${file} blanks the AWS SMS variables next to the bridge ones`, () => {
      const source = fs.readFileSync(path.join(REPO, file), 'utf8');
      for (const name of [
        'IMESSAGE_API_KEY',
        'CRISIS_ALERT_PHONE',
        'CRISIS_SMS_AWS_REGION',
        'CRISIS_SMS_ORIGINATION_IDENTITY',
      ]) {
        expect(source).toContain(`process.env.${name} = '';`);
      }
    });
  }

  it('the red-team database setup script unsets them', () => {
    const body = fs.readFileSync(path.join(REPO, 'scripts/redteam-db-setup.sh'), 'utf8');
    expect(body).toMatch(/unset CRISIS_SMS_AWS_REGION/);
    expect(body).toMatch(/unset CRISIS_SMS_ORIGINATION_IDENTITY/);
  });

  it('.env.example documents both, commented out', () => {
    const env = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8');
    expect(env).toMatch(/^# CRISIS_SMS_AWS_REGION=/m);
    expect(env).toMatch(/^# CRISIS_SMS_ORIGINATION_IDENTITY=/m);
    expect(env).not.toMatch(/^CRISIS_SMS_/m);
  });
});
