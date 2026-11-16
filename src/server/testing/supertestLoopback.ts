// Vitest setup file: every server that supertest starts binds 127.0.0.1.
//
// supertest's request(app) and request.agent(app) call app.listen(0), which
// binds the IPv6 wildcard (`::`, dual-stack), and then send the request to
// http://127.0.0.1:<port>. On macOS the kernel can hand that ephemeral port to
// the wildcard listener while another process already listens on
// 127.0.0.1:<port> (a VS Code helper does, for one), and IPv4 loopback traffic
// goes to the more specific bind: the request is answered by the other
// process. That is how route tests flaked with 401s and 404s their own app
// cannot produce (ai-therapist-279). Binding 127.0.0.1 itself makes the port
// exclusive for exactly the address the request goes to.
//
// Listening on an explicit host completes asynchronously (Node resolves the
// host first), while supertest reads the port synchronously when the request
// is created. So the bind starts where supertest would have listened, and the
// request is sent once it has completed. The server is still closed by the
// request that started it, as before.
import type { AddressInfo, Server } from 'node:net';
import supertest from 'supertest';

const LOOPBACK = '127.0.0.1';
const PATCHED = Symbol.for('ai-therapist.supertestLoopback');

type EndCallback = (err: unknown, res?: unknown) => void;

interface SupertestTest {
  url: string;
  _server?: Server;
  serverAddress(app: Server, path: string): string;
  end(fn?: EndCallback): SupertestTest;
}

interface PendingRequest {
  app: Server;
  path: string;
  listening: Promise<void>;
}

/** Servers whose loopback bind is in flight (shared by concurrent agent requests). */
const binding = new WeakMap<Server, Promise<void>>();
/** Requests created against a server that was not listening yet. */
const pendingRequests = new WeakMap<SupertestTest, PendingRequest>();

function listenOnLoopback(app: Server): Promise<void> {
  const inFlight = binding.get(app);
  if (inFlight) return inFlight;
  const listening = new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      binding.delete(app);
      reject(err);
    };
    app.once('error', onError);
    app.listen(0, LOOPBACK, () => {
      app.off('error', onError);
      binding.delete(app);
      resolve();
    });
  });
  binding.set(app, listening);
  return listening;
}

const testProto = (supertest as unknown as { Test: { prototype: SupertestTest & { [PATCHED]?: true } } }).Test
  .prototype;

if (!testProto[PATCHED]) {
  testProto[PATCHED] = true;
  const originalServerAddress = testProto.serverAddress;
  const originalEnd = testProto.end;

  testProto.serverAddress = function (this: SupertestTest, app: Server, path: string): string {
    if (app.address()) return originalServerAddress.call(this, app, path);
    // Same contract as supertest: only the request that starts the server
    // closes it; concurrent agent requests share the in-flight bind.
    if (!binding.has(app)) this._server = app;
    pendingRequests.set(this, { app, path, listening: listenOnLoopback(app) });
    // Placeholder with the final host and path (agent cookies are matched on
    // those when the request is created); the port is filled in by end().
    return `http://${LOOPBACK}${path}`;
  };

  testProto.end = function (this: SupertestTest, fn?: EndCallback): SupertestTest {
    const pending = pendingRequests.get(this);
    if (!pending) return originalEnd.call(this, fn);
    pendingRequests.delete(this);
    pending.listening.then(
      () => {
        const { port } = pending.app.address() as AddressInfo;
        this.url = `http://${LOOPBACK}:${port}${pending.path}`;
        originalEnd.call(this, fn);
      },
      (err: unknown) => fn?.(err),
    );
    return this;
  };
}
