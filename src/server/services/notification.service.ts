// Notification fan-out for the care-team work queue (caseworker portal, spec
// section 5). SINGLE CHOKE POINT: this service is called only from
// workQueue.service.ts — producers never insert notifications or send email
// directly, so the sandbox/PHI guards here cannot be bypassed.
//
// Hard rules enforced here:
//   - Sandbox items and sandbox recipients NEVER receive email (in-app only).
//   - Email bodies carry ZERO client PHI: they are built by emailTemplates.ts
//     from the notification kind + severity only. Work-item titles (which may
//     name a client) go to in-app notifications, never into email.
//   - Delivery policy (spec section 5): urgent kinds email immediately when
//     urgent_email_immediate; mid kinds follow email_mode; low kinds are
//     digest-only.
import {
  getUserById,
  getNotificationPreferences,
  insertNotification,
  markNotificationsEmailed,
  listUnemailedNotifications,
  listUserIdsWithUnemailedNotifications,
  type WorkItemRow,
  type NotificationRow,
} from '../db/index.js';
import {
  workItemSuppressesEmail,
  recipientSuppressesEmail,
  emailSuppressedWorkItemIds,
} from './suppression.js';
import { therapistRoom, caseworkerRoom } from '../utils/adminBroadcast.js';
import { immediateEmail, digestEmail } from './emailTemplates.js';
import { sendEmail } from './emailer.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('notification');

export interface NotificationRecipient {
  userId: number;
  /** Care-team role, when the caller knows it (drives the socket room). */
  role?: string | null;
}

type EmailPolicy = 'urgent_immediate' | 'per_mode' | 'digest_only';

/** Delivery policy for a work-item kind at a given severity (spec section 5). */
export function emailPolicyFor(kind: string, severity: string): EmailPolicy {
  switch (kind) {
    case 'crisis_flag':
      return 'urgent_immediate';
    case 'message_crisis':
    case 'escalation_inbound':
      return severity === 'urgent' ? 'urgent_immediate' : 'per_mode';
    case 'adverse_event':
    case 'escalation_response':
      return 'per_mode';
    default:
      // inactivity, screener_worsening, note_awaiting_signature,
      // message_unread_stale, note_shared, anything unknown: digest only.
      return 'digest_only';
  }
}

/**
 * Recipient email address. There is no users.email column yet, so the only
 * address we can use is an email-shaped username; anything else means "no
 * email for this user" (in-app + digest UI still work). Flagged as a known
 * gap in the portal spec rollout.
 */
export function emailAddressForUsername(username: string | undefined | null): string | null {
  if (!username) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) ? username.trim() : null;
}

function memberRoomFor(role: string | null | undefined, userId: number): string | null {
  if (role === 'caseworker') return caseworkerRoom(userId);
  if (role === 'therapist') return therapistRoom(userId);
  return null;
}

function emitNotificationNew(role: string | null | undefined, row: NotificationRow): void {
  const io = global.io;
  if (!io) return;
  const room = memberRoomFor(role, row.user_id);
  if (!room) return;
  io.to(room).emit('notification:new', {
    notification_id: row.notification_id,
    kind: row.kind,
    title: row.title,
    work_item_id: row.work_item_id,
    created_at: row.created_at,
  });
}

/**
 * Notify every recipient about a work item: in-app row + socket event, plus
 * (non-sandbox only) immediate email per the delivery policy. Never throws —
 * a notification failure must not break the producer that enqueued the item.
 */
export async function notifyWorkItem(
  item: WorkItemRow,
  recipients: NotificationRecipient[]
): Promise<void> {
  for (const recipient of recipients) {
    try {
      const user = await getUserById(recipient.userId);
      if (!user) continue;
      const prefs = await getNotificationPreferences(recipient.userId);

      let inserted: NotificationRow | null = null;
      if (prefs.in_app_enabled) {
        inserted = await insertNotification({
          userId: recipient.userId,
          workItemId: item.item_id,
          kind: item.item_type,
          title: item.title,
        });
        emitNotificationNew(recipient.role ?? user.role, inserted);
      }

      // HARD RULE: sandbox never emails — neither sandbox-origin items nor
      // sandbox recipient accounts (docs/caseworker-portal.md section 5).
      if (workItemSuppressesEmail(item) || recipientSuppressesEmail(user)) continue;

      const policy = emailPolicyFor(item.item_type, item.severity);
      const sendNow =
        (policy === 'urgent_immediate' && prefs.urgent_email_immediate) ||
        (policy === 'per_mode' && prefs.email_mode === 'immediate');
      if (!sendNow) continue; // digest sweep picks up the rest

      const address = emailAddressForUsername(user.username);
      if (!address) {
        log.debug({ userId: recipient.userId }, '[notify] no email address for user; in-app only');
        continue;
      }
      // PHI-free by construction: template inputs are kind + severity only.
      const content = immediateEmail(item.item_type, item.severity);
      const result = await sendEmail({ to: address, ...content });
      // Only a REAL send stamps emailed_at. 'skipped' means SMTP is not
      // configured: the notification must stay unemailed so the digest sweep
      // can deliver it once email is available, instead of silently vanishing.
      if (result === 'sent' && inserted) {
        await markNotificationsEmailed([inserted.notification_id]);
      }
    } catch (err) {
      log.error({ err, userId: recipient.userId, itemId: item.item_id },
        '[notify] failed to notify recipient');
    }
  }
}

/** Local hour in the deployment timezone (matches utils/timezoneHelpers). */
export function localHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: 'numeric',
      hour12: false,
    }).format(now)
  ) % 24;
}

/**
 * Hourly digest sweep: for each user with unemailed notifications whose
 * digest_hour_local matches the current local hour, send ONE roll-up email
 * (kind -> count only; PHI-free) and stamp emailed_at. Sandbox accounts and
 * email_mode='off' users have their backlog stamped without sending, so
 * suppressed notifications don't accumulate forever. Never throws.
 */
export async function runDigestSweep(now: Date = new Date()): Promise<void> {
  let userIds: number[];
  try {
    userIds = await listUserIdsWithUnemailedNotifications();
  } catch (err) {
    log.error({ err }, '[digest] failed to list pending users');
    return;
  }
  const hour = localHour(now);

  for (const userId of userIds) {
    try {
      const user = await getUserById(userId);
      if (!user) continue;
      const prefs = await getNotificationPreferences(userId);

      const suppress = recipientSuppressesEmail(user) || prefs.email_mode === 'off';
      if (!suppress && prefs.digest_hour_local !== hour) continue;

      const pending = await listUnemailedNotifications(userId);
      if (pending.length === 0) continue;

      if (!suppress) {
        // Sandbox-origin work items never email — not even inside a real
        // recipient's digest counts. They are excluded from the email and
        // stamped below (suppressed, not retried).
        const workItemIds = pending
          .map((row) => (row.work_item_id == null ? null : Number(row.work_item_id)))
          .filter((id): id is number => id !== null && Number.isFinite(id));
        const sandboxItemIds = new Set(await emailSuppressedWorkItemIds(workItemIds));
        const emailable = pending.filter(
          (row) => row.work_item_id == null || !sandboxItemIds.has(Number(row.work_item_id))
        );

        const address = emailAddressForUsername(user.username);
        if (address && emailable.length > 0) {
          const counts: Record<string, number> = {};
          for (const row of emailable) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
          const result = await sendEmail({ to: address, ...digestEmail(counts) });
          // Anything short of a real send (failed OR skipped-no-SMTP) leaves
          // the rows unstamped so the next matching hour retries them.
          if (result !== 'sent') continue;
        }
        // No address / nothing emailable: fall through and stamp — there is
        // nowhere (or nothing) to send.
      }
      await markNotificationsEmailed(pending.map((row) => row.notification_id));
    } catch (err) {
      log.error({ err, userId }, '[digest] failed for user');
    }
  }
}
