// Notification choke-point contract (spec section 5): delivery policy per
// kind/severity, the sandbox-never-emails hard rule, PHI-free email bodies,
// and digest assembly. All collaborators mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getUserByIdMock,
  getNotificationPreferencesMock,
  insertNotificationMock,
  markNotificationsEmailedMock,
  listUnemailedNotificationsMock,
  listUserIdsWithUnemailedNotificationsMock,
  getSandboxWorkItemIdsMock,
  sendEmailMock,
} = vi.hoisted(() => ({
  getUserByIdMock: vi.fn(),
  getNotificationPreferencesMock: vi.fn(),
  insertNotificationMock: vi.fn(),
  markNotificationsEmailedMock: vi.fn(),
  listUnemailedNotificationsMock: vi.fn(),
  listUserIdsWithUnemailedNotificationsMock: vi.fn(),
  getSandboxWorkItemIdsMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getUserById: getUserByIdMock,
  getNotificationPreferences: getNotificationPreferencesMock,
  insertNotification: insertNotificationMock,
  markNotificationsEmailed: markNotificationsEmailedMock,
  listUnemailedNotifications: listUnemailedNotificationsMock,
  listUserIdsWithUnemailedNotifications: listUserIdsWithUnemailedNotificationsMock,
  getSandboxWorkItemIds: getSandboxWorkItemIdsMock,
  // Transitive imports of utils/adminBroadcast.js (real module, mocked barrel):
  getSessionAccessInfo: vi.fn(),
  getTherapistIdsForClient: vi.fn(),
  getCaseworkerIdsForClient: vi.fn(),
}));
vi.mock('./emailer.service.js', () => ({ sendEmail: sendEmailMock }));

const {
  notifyWorkItem,
  runDigestSweep,
  emailPolicyFor,
  emailAddressForUsername,
  localHour,
} = await import('./notification.service.js');

const DEFAULT_PREFS = {
  user_id: 9,
  email_mode: 'digest' as const,
  urgent_email_immediate: true,
  digest_hour_local: 8,
  in_app_enabled: true,
};

function workItem(overrides: Record<string, unknown> = {}) {
  return {
    item_id: 11,
    org_id: 1,
    client_id: 42,
    assignee_id: null,
    assignee_role: null,
    item_type: 'crisis_flag',
    severity: 'urgent',
    title: 'Crisis flag for client jane.doe', // in-app title MAY name the client
    detail: null,
    source_table: 'crisis_events',
    source_id: '7',
    status: 'open',
    acked_by: null, acked_at: null,
    resolved_by: null, resolved_at: null, resolution_note: null,
    is_sandbox: false,
    created_at: '2026-08-27T12:00:00Z',
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserByIdMock.mockResolvedValue({ userid: 9, username: 'cw@example.com', role: 'caseworker', is_sandbox: false });
  getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS });
  insertNotificationMock.mockResolvedValue({
    notification_id: 501, user_id: 9, work_item_id: 11, kind: 'crisis_flag',
    title: 'Crisis flag for client jane.doe', body: null,
    read_at: null, emailed_at: null, created_at: '2026-08-27T12:00:00Z',
  });
  markNotificationsEmailedMock.mockResolvedValue(undefined);
  getSandboxWorkItemIdsMock.mockResolvedValue([]);
  sendEmailMock.mockResolvedValue('sent');
});

describe('emailPolicyFor', () => {
  it('classifies kinds per the spec section 5 table', () => {
    expect(emailPolicyFor('crisis_flag', 'urgent')).toBe('urgent_immediate');
    expect(emailPolicyFor('message_crisis', 'urgent')).toBe('urgent_immediate');
    expect(emailPolicyFor('message_crisis', 'warning')).toBe('per_mode');
    expect(emailPolicyFor('escalation_inbound', 'urgent')).toBe('urgent_immediate');
    expect(emailPolicyFor('escalation_inbound', 'info')).toBe('per_mode');
    expect(emailPolicyFor('adverse_event', 'warning')).toBe('per_mode');
    expect(emailPolicyFor('escalation_response', 'info')).toBe('per_mode');
    for (const kind of ['inactivity', 'screener_worsening', 'note_awaiting_signature', 'message_unread_stale', 'note_shared']) {
      expect(emailPolicyFor(kind, 'info')).toBe('digest_only');
    }
  });
});

describe('emailAddressForUsername', () => {
  it('accepts only email-shaped usernames', () => {
    expect(emailAddressForUsername('cw@example.com')).toBe('cw@example.com');
    expect(emailAddressForUsername('caseworker1')).toBeNull();
    expect(emailAddressForUsername(null)).toBeNull();
  });
});

describe('notifyWorkItem', () => {
  it('inserts an in-app row and emails urgent items immediately, stamping emailed_at', async () => {
    await notifyWorkItem(workItem(), [{ userId: 9, role: 'caseworker' }]);
    expect(insertNotificationMock).toHaveBeenCalledWith({
      userId: 9, workItemId: 11, kind: 'crisis_flag', title: 'Crisis flag for client jane.doe',
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(markNotificationsEmailedMock).toHaveBeenCalledWith([501]);
  });

  it("does NOT stamp emailed_at when the send is skipped (no SMTP) — digest must retry it", async () => {
    sendEmailMock.mockResolvedValue('skipped');
    await notifyWorkItem(workItem(), [{ userId: 9, role: 'caseworker' }]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(markNotificationsEmailedMock).not.toHaveBeenCalled();
  });

  it('does NOT stamp emailed_at when the send fails', async () => {
    sendEmailMock.mockResolvedValue('failed');
    await notifyWorkItem(workItem(), [{ userId: 9, role: 'caseworker' }]);
    expect(markNotificationsEmailedMock).not.toHaveBeenCalled();
  });

  it('never leaks the client-naming in-app title into the email', async () => {
    await notifyWorkItem(workItem(), [{ userId: 9, role: 'caseworker' }]);
    const email = sendEmailMock.mock.calls[0][0] as { subject: string; text: string };
    expect(email.subject).not.toContain('jane.doe');
    expect(email.text).not.toContain('jane.doe');
    expect(email.text).toContain('A client on your caseload');
  });

  it('sandbox items never email (in-app only)', async () => {
    await notifyWorkItem(workItem({ is_sandbox: true }), [{ userId: 9, role: 'caseworker' }]);
    expect(insertNotificationMock).toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sandbox recipient accounts never email', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 9, username: 'demo@example.com', role: 'therapist', is_sandbox: true });
    await notifyWorkItem(workItem(), [{ userId: 9, role: 'therapist' }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('respects urgent_email_immediate=false for urgent kinds', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, urgent_email_immediate: false });
    await notifyWorkItem(workItem(), [{ userId: 9 }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('per-mode kinds email immediately only when email_mode=immediate', async () => {
    const item = workItem({ item_type: 'adverse_event', severity: 'warning' });
    await notifyWorkItem(item, [{ userId: 9 }]);
    expect(sendEmailMock).not.toHaveBeenCalled(); // digest mode: wait for sweep

    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, email_mode: 'immediate' });
    await notifyWorkItem(item, [{ userId: 9 }]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('digest-only kinds never email immediately', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, email_mode: 'immediate' });
    await notifyWorkItem(workItem({ item_type: 'inactivity', severity: 'info' }), [{ userId: 9 }]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips the in-app insert when in_app_enabled=false', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, in_app_enabled: false });
    await notifyWorkItem(workItem(), [{ userId: 9 }]);
    expect(insertNotificationMock).not.toHaveBeenCalled();
  });

  it('skips email for users without an email-shaped username', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 9, username: 'caseworker1', role: 'caseworker', is_sandbox: false });
    await notifyWorkItem(workItem(), [{ userId: 9 }]);
    expect(insertNotificationMock).toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('never throws when a collaborator fails, and continues to other recipients', async () => {
    getUserByIdMock
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ userid: 10, username: 'ok@example.com', role: 'therapist', is_sandbox: false });
    await expect(
      notifyWorkItem(workItem(), [{ userId: 9 }, { userId: 10, role: 'therapist' }])
    ).resolves.toBeUndefined();
    expect(insertNotificationMock).toHaveBeenCalledTimes(1);
  });
});

describe('runDigestSweep', () => {
  const NOW = new Date('2026-08-27T15:30:00Z');
  const pending = [
    { notification_id: 1, user_id: 9, kind: 'inactivity', title: 't', body: null, work_item_id: 1, read_at: null, emailed_at: null, created_at: 'x' },
    { notification_id: 2, user_id: 9, kind: 'inactivity', title: 't', body: null, work_item_id: 2, read_at: null, emailed_at: null, created_at: 'x' },
    { notification_id: 3, user_id: 9, kind: 'screener_worsening', title: 't', body: null, work_item_id: 3, read_at: null, emailed_at: null, created_at: 'x' },
  ];

  beforeEach(() => {
    listUserIdsWithUnemailedNotificationsMock.mockResolvedValue([9]);
    listUnemailedNotificationsMock.mockResolvedValue(pending);
  });

  it('sends one digest at the matching local hour and stamps all rows', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, digest_hour_local: localHour(NOW) });
    await runDigestSweep(NOW);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const email = sendEmailMock.mock.calls[0][0] as { subject: string; text: string };
    expect(email.subject).toContain('3 new notifications');
    expect(markNotificationsEmailedMock).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('does nothing outside the user digest hour', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, digest_hour_local: (localHour(NOW) + 1) % 24 });
    await runDigestSweep(NOW);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(markNotificationsEmailedMock).not.toHaveBeenCalled();
  });

  it('stamps without sending for email_mode=off users', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, email_mode: 'off', digest_hour_local: (localHour(NOW) + 5) % 24 });
    await runDigestSweep(NOW);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(markNotificationsEmailedMock).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('stamps without sending for sandbox users', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 9, username: 'demo@example.com', role: 'therapist', is_sandbox: true });
    await runDigestSweep(NOW);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(markNotificationsEmailedMock).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('leaves rows unstamped when the send fails (retry later)', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, digest_hour_local: localHour(NOW) });
    sendEmailMock.mockResolvedValue('failed');
    await runDigestSweep(NOW);
    expect(markNotificationsEmailedMock).not.toHaveBeenCalled();
  });

  it('leaves rows unstamped when the send is skipped (no SMTP yet — retry once configured)', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, digest_hour_local: localHour(NOW) });
    sendEmailMock.mockResolvedValue('skipped');
    await runDigestSweep(NOW);
    expect(markNotificationsEmailedMock).not.toHaveBeenCalled();
  });

  it('excludes sandbox-origin notifications from a real recipient digest (counted out, stamped anyway)', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, digest_hour_local: localHour(NOW) });
    getSandboxWorkItemIdsMock.mockResolvedValue([1, 2]); // items behind notifications 1 & 2
    await runDigestSweep(NOW);
    expect(getSandboxWorkItemIdsMock).toHaveBeenCalledWith([1, 2, 3]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const email = sendEmailMock.mock.calls[0][0] as { subject: string };
    expect(email.subject).toContain('1 new notification'); // only the real item counted
    // Sandbox-origin rows are stamped (suppressed), not retried forever.
    expect(markNotificationsEmailedMock).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('sends no digest at all when every pending notification is sandbox-origin', async () => {
    getNotificationPreferencesMock.mockResolvedValue({ ...DEFAULT_PREFS, digest_hour_local: localHour(NOW) });
    getSandboxWorkItemIdsMock.mockResolvedValue([1, 2, 3]);
    await runDigestSweep(NOW);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(markNotificationsEmailedMock).toHaveBeenCalledWith([1, 2, 3]);
  });
});
