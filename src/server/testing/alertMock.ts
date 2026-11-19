// Test helper: the two exports of services/crisisAlert.service that
// crisisPaging.service uses, built on ONE vi.fn so existing tests that make
// the pager return true / false / throw keep reading the same way.
//
//   vi.mock('./crisisAlert.service.js', async () =>
//     (await import('../testing/alertMock.js')).alertModuleMock(sendCrisisAlertMock));
//
// The mock may return a boolean (one channel, accepted or not), or a full
// AlertDelivery when a test cares about the individual channels.
import type { AlertChannelResult, AlertDelivery } from '../services/crisisAlert.service.js';

/** One channel's result, for tests. */
export function channelResult(
  channel: AlertChannelResult['channel'],
  ok: boolean,
  extra: Partial<AlertChannelResult> = {},
): AlertChannelResult {
  return {
    channel,
    ok,
    error: ok ? null : 'http_502',
    messageIds: [],
    parts: 1,
    partsAccepted: ok ? 1 : 0,
    ms: 1,
    ...extra,
  };
}

export function alertModuleMock(pager: (message: string) => unknown): {
  sendCrisisAlert: (message: string) => Promise<unknown>;
  sendCrisisAlertDetailed: (message: string) => Promise<AlertDelivery>;
} {
  return {
    sendCrisisAlert: async (message) => pager(message),
    sendCrisisAlertDetailed: async (message) => {
      const answer = await pager(message);
      if (answer !== null && typeof answer === 'object') return answer as AlertDelivery;
      const ok = answer === true;
      return { delivered: ok, skipped: null, channels: [channelResult('imessage', ok)] };
    },
  };
}
