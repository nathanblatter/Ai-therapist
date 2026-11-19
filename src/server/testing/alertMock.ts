// Test helper: the two exports of services/crisisAlert.service that
// crisisPaging.service uses, built on ONE vi.fn so existing tests that make
// the pager return true / false / throw keep reading the same way.
//
//   vi.mock('./crisisAlert.service.js', async () =>
//     (await import('../testing/alertMock.js')).alertModuleMock(sendCrisisAlertMock));
//
// The mock may return a boolean (one channel, accepted or not), or a full
// AlertDelivery when a test cares about the individual channels. A structured
// page (utils/pageMessage) reaches the pager as its bridge text, the text the
// on-call reads on the iMessage channel.
import type { AlertChannelResult, AlertDelivery } from '../services/crisisAlert.service.js';
import { pageText, type PageMessage } from '../utils/pageMessage.js';

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
  sendCrisisAlert: (message: string | PageMessage) => Promise<unknown>;
  sendCrisisAlertDetailed: (message: string | PageMessage) => Promise<AlertDelivery>;
} {
  return {
    sendCrisisAlert: async (message) => pager(pageText(message)),
    sendCrisisAlertDetailed: async (message) => {
      const answer = await pager(pageText(message));
      if (answer !== null && typeof answer === 'object') return answer as AlertDelivery;
      const ok = answer === true;
      return { delivered: ok, skipped: null, channels: [channelResult('imessage', ok)] };
    },
  };
}
