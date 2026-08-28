// Email templates are pure functions of (kind, severity, counts) — the
// structural guarantee behind the zero-client-PHI email rule (Nathan
// decision #9): there is no parameter through which a client name, title, or
// content could reach an email body.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { immediateEmail, digestEmail, kindLabel } from './emailTemplates.js';

const ORIGINAL_BASE_URL = process.env.APP_BASE_URL;

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = ORIGINAL_BASE_URL;
});

beforeEach(() => {
  delete process.env.APP_BASE_URL;
});

describe('immediateEmail', () => {
  it('marks urgent severity in the subject and body', () => {
    const email = immediateEmail('crisis_flag', 'urgent');
    expect(email.subject).toContain('urgent');
    expect(email.text).toContain('urgent safety alert');
    expect(email.text).toContain('A client on your caseload');
  });

  it('uses neutral copy for non-urgent kinds', () => {
    const email = immediateEmail('escalation_response', 'info');
    expect(email.subject).not.toContain('urgent');
    expect(email.text).toContain('escalation update');
  });

  it('includes the privacy line and a generic login line without APP_BASE_URL', () => {
    const email = immediateEmail('adverse_event', 'warning');
    expect(email.text).toContain('no client details');
    expect(email.text).toContain('Log in to the care dashboard');
  });

  it('links to /admin when APP_BASE_URL is set (trailing slash trimmed)', () => {
    process.env.APP_BASE_URL = 'https://therapy.example.com/';
    const email = immediateEmail('crisis_flag', 'urgent');
    expect(email.text).toContain('https://therapy.example.com/admin');
  });
});

describe('digestEmail', () => {
  it('totals counts and lists one line per kind, skipping zeros', () => {
    const email = digestEmail({ inactivity: 2, screener_worsening: 1, note_shared: 0 });
    expect(email.subject).toContain('3 new notifications');
    expect(email.text).toContain('client inactivity reminder: 2');
    expect(email.text).toContain('screener trend alert: 1');
    expect(email.text).not.toContain('shared note');
  });

  it('uses singular phrasing for one notification', () => {
    const email = digestEmail({ note_awaiting_signature: 1 });
    expect(email.subject).toContain('1 new notification');
    expect(email.subject).not.toContain('notifications');
  });
});

describe('kindLabel', () => {
  it('falls back to a generic label for unknown kinds', () => {
    expect(kindLabel('something_new')).toBe('work item');
  });
});
