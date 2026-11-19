// sendTestPage.ts - send a clearly labelled TEST page to the on-call phone
// through every configured paging channel, and report what each one did.
//
//   npm run page:test                (inside the app container on stage/prod:
//                                     docker compose exec app npm run page:test)
//
// When to run it: after every on-call handoff, after any change to the paging
// configuration, and after a deploy that touches the crisis path
// (docs/on-call-sop.md sections 2 and 6).
//
// THIS TEXTS A REAL PHONE when a channel is configured. It reads the same
// configuration the server does (IMESSAGE_API_KEY, CRISIS_SMS_AWS_REGION,
// CRISIS_SMS_ORIGINATION_IDENTITY, the on-call phone from System Config or
// CRISIS_ALERT_PHONE); with none of it set it sends nothing and says so.
//
// It is a command-line script on purpose. There is no HTTP route, socket
// event or model tool that sends a test page, so nothing a participant can do
// in a session reaches it; running it takes a shell on the app host.
//
// Exit code: 0 every configured channel accepted its test page; 1 a channel
// failed; 2 nothing was sent (paging disabled, no phone, or no channel).
// Prints channel names, results and provider message ids. Never prints the
// phone number, a key or a credential.
import { pathToFileURL } from 'node:url';
import type { TestPageReport } from '../services/crisisAlert.service.js';

/** The report as text, and the exit code. Pure; exported for tests. */
export function formatTestPageReport(report: TestPageReport): { lines: string[]; exitCode: number } {
  const lines: string[] = ['On-call TEST page'];
  lines.push(`  paging enabled in System Config: ${report.enabled ? 'yes' : 'NO'}`);
  lines.push(`  on-call phone set:               ${report.hasPhone ? 'yes' : 'NO'}`);
  lines.push(`  iMessage bridge configured:      ${report.configured.imessage ? 'yes' : 'no'}`);
  lines.push(`  AWS SMS configured:              ${report.configured.aws_sms ? 'yes' : 'no'}`);
  if (!report.enabled) {
    lines.push('Nothing sent: paging is switched off (System Config, crisis_alert.enabled).');
    return { lines, exitCode: 2 };
  }
  if (!report.hasPhone) {
    lines.push('Nothing sent: no on-call phone (System Config crisis_alert.phone, or CRISIS_ALERT_PHONE).');
    return { lines, exitCode: 2 };
  }
  if (report.channels.length === 0) {
    lines.push('Nothing sent: no paging channel is configured in this environment.');
    return { lines, exitCode: 2 };
  }
  for (const c of report.channels) {
    const ids = c.messageIds.length > 0 ? `, message id ${c.messageIds.join(', ')}` : '';
    lines.push(
      c.ok
        ? `  ${c.channel}: ACCEPTED in ${c.ms} ms (${c.partsAccepted} of ${c.parts} message(s)${ids})`
        : `  ${c.channel}: FAILED (${c.error ?? 'error'}) after ${c.ms} ms, ${c.partsAccepted} of ${c.parts} message(s) accepted`,
    );
  }
  lines.push(
    report.ok
      ? 'Every configured channel accepted its test page. Confirm with the on-call that each TEST text arrived: ' +
          'accepted by the provider is not the same as on the phone.'
      : 'AT LEAST ONE CHANNEL FAILED. Paging is degraded until it is fixed (docs/on-call-sop.md section 6).',
  );
  return { lines, exitCode: report.ok ? 0 : 1 };
}

async function main(): Promise<void> {
  const { sendTestPage } = await import('../services/crisisAlert.service.js');
  const { lines, exitCode } = formatTestPageReport(await sendTestPage());
  for (const line of lines) console.log(line);
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('test page failed:', err instanceof Error ? err.name : 'error');
    process.exit(1);
  });
}
