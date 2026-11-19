// Chat session lifecycle (ai-therapist-307): a scenario that throws must not
// leave its session active, and no scenario may run inside a session it did
// not start. Driven against an in-memory stand-in for /api/chat/* with the
// server's one-active-session-per-user rule; no server, database or network.
import { describe, expect, it, vi } from 'vitest';
import { HarnessClient, StaleChatSessionError, type Agent } from './harnessClient.js';

/** /api/chat/start, /message and /end for ONE participant account, with the
 *  same alreadyActive answer chat.routes.ts gives. */
class FakeChatServer {
  sessions = new Map<string, { status: 'active' | 'ended'; messages: string[] }>();
  private n = 0;
  failNextMessage = false;
  failEnd = false;
  ends: string[] = [];

  private active(): string | null {
    for (const [id, s] of this.sessions) if (s.status === 'active') return id;
    return null;
  }

  handle(url: string, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    if (url === '/api/chat/start') {
      const existing = this.active();
      if (existing) return { status: 200, body: { sessionId: existing, alreadyActive: true } };
      const id = `chat_${++this.n}`;
      this.sessions.set(id, { status: 'active', messages: [] });
      return { status: 200, body: { sessionId: id, opening: 'Hi, I am an AI.' } };
    }
    if (url === '/api/chat/message') {
      const s = this.sessions.get(String(body.sessionId));
      if (!s || s.status !== 'active') return { status: 400, body: { error: 'Session is not active' } };
      if (this.failNextMessage) {
        this.failNextMessage = false;
        return { status: 500, body: { error: 'upstream 429' } };
      }
      s.messages.push(String(body.message));
      return { status: 200, body: { response: 'ok', sessionId: body.sessionId } };
    }
    if (url === '/api/chat/end') {
      const s = this.sessions.get(String(body.sessionId));
      if (!s) return { status: 404, body: { error: 'Session not found' } };
      if (this.failEnd) return { status: 500, body: { error: 'down' } };
      this.ends.push(String(body.sessionId));
      if (s.status === 'ended') return { status: 200, body: { alreadyEnded: true } };
      s.status = 'ended';
      return { status: 200, body: { success: true } };
    }
    return { status: 404, body: {} };
  }

  agent(): Agent {
    return {
      post: (url: string) => ({
        send: async (body: Record<string, unknown>) => ({ ...this.handle(url, body), headers: {} }),
      }),
    } as unknown as Agent;
  }
}

function setup() {
  const server = new FakeChatServer();
  const client = new HarnessClient({} as never, {} as never, 'v1');
  return { server, client };
}

/** One chat scenario the way runChatScenario drives it. */
async function scenario(client: HarnessClient, server: FakeChatServer, messages: string[]): Promise<string> {
  const agent = server.agent();
  const { sessionId } = await client.startFreshChat(agent);
  await client.driveChatSession(agent, sessionId, async () => {
    for (const m of messages) await client.chatMessage(agent, sessionId, m);
  });
  return sessionId;
}

describe('HarnessClient chat lifecycle (ai-therapist-307)', () => {
  it('startChat refuses a pre-existing active session instead of reusing it', async () => {
    const { server, client } = setup();
    // A session left open by something else (an earlier scenario, a crash).
    server.handle('/api/chat/start', {});
    const err = await client.startChat(server.agent()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleChatSessionError);
    expect((err as StaleChatSessionError).sessionId).toBe('chat_1');
  });

  it('a scenario whose turn throws still ends its session, and the next scenario gets a new one', async () => {
    const { server, client } = setup();
    server.failNextMessage = true;
    await expect(scenario(client, server, ['first beat'])).rejects.toThrow(/chat message failed: 500/);
    expect(server.sessions.get('chat_1')?.status).toBe('ended');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = await scenario(client, server, ['second scenario beat']);
    expect(second).toBe('chat_2');
    // The second scenario's text never landed in the first scenario's session.
    expect(server.sessions.get('chat_1')?.messages).toEqual([]);
    expect(server.sessions.get('chat_2')?.messages).toEqual(['second scenario beat']);
    expect(client.staleSessionsEnded).toEqual([]);
  });

  it('startFreshChat ends a leaked session, reports it, and starts a new one', async () => {
    const { server, client } = setup();
    server.handle('/api/chat/start', {}); // leaked chat_1
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sessionId } = await client.startFreshChat(server.agent());
    expect(sessionId).toBe('chat_2');
    expect(server.sessions.get('chat_1')?.status).toBe('ended');
    expect(client.staleSessionsEnded).toEqual(['chat_1']);
    expect(errors.mock.calls.flat().join(' ')).toMatch(/HARNESS LEAK.*chat_1/);
  });

  it('fails loudly when the leaked session cannot be ended', async () => {
    const { server, client } = setup();
    server.handle('/api/chat/start', {});
    server.failEnd = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(client.startFreshChat(server.agent())).rejects.toThrow(/chat end failed for chat_1: 500/);
  });

  it('refuses a session id the client has already handed to an earlier scenario', async () => {
    const { client } = setup();
    let calls = 0;
    const agent = {
      post: () => ({
        send: async () => ({
          status: 200,
          body: { sessionId: 'chat_same', opening: null },
          headers: {},
          calls: ++calls,
        }),
      }),
    } as unknown as Agent;
    await client.startChat(agent);
    await expect(client.startChat(agent)).rejects.toThrow(/chat_same, a session an earlier scenario already used/);
  });

  it('keeps the turn error when the teardown end also fails', async () => {
    const { server, client } = setup();
    const agent = server.agent();
    const { sessionId } = await client.startFreshChat(agent);
    server.failEnd = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      client.driveChatSession(agent, sessionId, async () => {
        throw new Error('beat exploded');
      }),
    ).rejects.toThrow('beat exploded');
  });

  it('endOpenChats ends whatever a runner left open and records each session started', async () => {
    const { server, client } = setup();
    const agent = server.agent();
    const { sessionId } = await client.startChat(agent);
    expect(await client.endOpenChats()).toEqual([sessionId]);
    expect(await client.endOpenChats()).toEqual([]);
    expect(server.sessions.get(sessionId)?.status).toBe('ended');
    client.noteSession('redteam_rt_1');
    expect(client.sessionsStarted).toEqual([sessionId, 'redteam_rt_1']);
  });
});

describe('chat start options (multi-session scenarios)', () => {
  /** An agent that records every body posted to /api/chat/start. */
  function recordingAgent(server: FakeChatServer, starts: Array<Record<string, unknown>>): Agent {
    return {
      post: (url: string) => ({
        send: async (body: Record<string, unknown>) => {
          if (url === '/api/chat/start') starts.push(body);
          return { ...server.handle(url, body), headers: {} };
        },
      }),
    } as unknown as Agent;
  }

  it('sends only the language when a scenario gives no check-in', async () => {
    const { server, client } = setup();
    const starts: Array<Record<string, unknown>> = [];
    await client.startFreshChat(recordingAgent(server, starts));
    expect(starts).toEqual([{ language: 'en' }]);
  });

  it('sends the pre-session check-in with the start, as the client form does', async () => {
    const { server, client } = setup();
    const starts: Array<Record<string, unknown>> = [];
    await client.startFreshChat(recordingAgent(server, starts), { checkin: { mood: 3, topic: 'same as always' } });
    expect(starts).toEqual([{ language: 'en', checkin: { mood: 3, topic: 'same as always' } }]);
  });

  it('keeps the check-in when it has to end a leaked session and start again', async () => {
    const { server, client } = setup();
    server.handle('/api/chat/start', {}); // a session some earlier scenario left open
    const starts: Array<Record<string, unknown>> = [];
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await client.startFreshChat(recordingAgent(server, starts), { checkin: { mood: 2 } });
    quiet.mockRestore();
    expect(starts).toHaveLength(2);
    expect(starts[1]).toEqual({ language: 'en', checkin: { mood: 2 } });
  });
});
