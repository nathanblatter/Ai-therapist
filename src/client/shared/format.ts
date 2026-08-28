// Shared date/time formatters for participant + admin UIs. Before this
// module ~15 components each carried a local formatDate/timeAgo/timeLabel
// copy with drifting formats (numeric vs short month, 'Never' vs em dash).
// Conventions: 'en-US' short-month formats; null/undefined -> em dash.
// Call sites that need a semantic empty value ('Never') guard before calling.

const EM_DASH = '—';

/** Short date only: "Aug 28, 2026". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Short date + time: "Aug 28, 2026, 4:05 PM". */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Chat/thread timestamp: time only when the message is from today, otherwise
 * short date + time ("Aug 28, 4:05 PM"). Empty string for null so bubble
 * captions collapse rather than showing a dash.
 */
export function timeLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Compact relative timestamp for queue/notification rows ("5m ago"). */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return EM_DASH;
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
