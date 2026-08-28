// Email copy for care-team notifications (caseworker portal, spec section 5).
//
// HARD RULE (Nathan decision #9, docs/caseworker-portal.md section 10): email
// bodies carry ZERO client PHI — no client names, no usernames, no session or
// message content, no scores. Every template is built exclusively from the
// notification KIND and SEVERITY ("a client on your caseload has a new urgent
// item" + login link). In-app notifications may be richer; email may not.
// The tests assert templates are pure functions of (kind, severity, counts).

export interface EmailContent {
  subject: string;
  text: string;
}

/** Generic, PHI-free label for a notification kind. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'crisis_flag':
      return 'safety alert';
    case 'message_crisis':
      return 'flagged message safety review';
    case 'adverse_event':
      return 'adverse event report';
    case 'escalation_inbound':
      return 'escalation';
    case 'escalation_response':
      return 'escalation update';
    case 'note_awaiting_signature':
      return 'note awaiting signature';
    case 'inactivity':
      return 'client inactivity reminder';
    case 'screener_worsening':
      return 'screener trend alert';
    case 'message_unread_stale':
      return 'unanswered message reminder';
    case 'note_shared':
      return 'shared note';
    default:
      return 'work item';
  }
}

function loginLine(): string {
  const base = (process.env.APP_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return base
    ? `Log in to review: ${base}/admin`
    : 'Log in to the care dashboard to review.';
}

/**
 * Immediate (single-notification) email. PHI-free by construction: the only
 * inputs are the kind and severity.
 */
export function immediateEmail(kind: string, severity: string): EmailContent {
  const label = kindLabel(kind);
  const urgent = severity === 'urgent';
  return {
    subject: urgent ? `Care team alert: urgent ${label}` : `Care team notification: new ${label}`,
    text: [
      `A client on your caseload has a new ${urgent ? 'urgent ' : ''}${label}.`,
      '',
      loginLine(),
      '',
      'For privacy, this email contains no client details.',
    ].join('\n'),
  };
}

/**
 * Daily digest email. Input is kind -> count only; PHI-free by construction.
 */
export function digestEmail(countsByKind: Record<string, number>): EmailContent {
  const entries = Object.entries(countsByKind).filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const lines = entries
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `- ${kindLabel(kind)}: ${count}`);
  return {
    subject: `Care team daily digest: ${total} new notification${total === 1 ? '' : 's'}`,
    text: [
      `You have ${total} unread care-team notification${total === 1 ? '' : 's'}:`,
      '',
      ...lines,
      '',
      loginLine(),
      '',
      'For privacy, this email contains no client details.',
    ].join('\n'),
  };
}
