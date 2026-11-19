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
// request is sent once it has completed.
//
// A server this file started is closed when the LAST request using it has
// finished, not when the request that started it has. supertest closes it
// after the starting request alone, and Node's server.close() drops idle
// sockets at once: a concurrent agent request whose socket was accepted but
// whose request had not been read yet was reset (ECONNRESET), and one that had
// not connected yet was refused. Under a loaded machine that happened in the
// suite's own concurrent-agent test (ai-therapist-370).
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
/** Servers this file started, with the number of requests still using each. */
const users = new WeakMap<Server, number>();
/** Requests holding a use of a server this file started. */
const holders = new WeakMap<SupertestTest, Server>();

function hold(test: SupertestTest, app: Server): void {
  users.set(app, (users.get(app) ?? 0) + 1);
  holders.set(test, app);
}

/** Drop the request's use of its server; the last one out closes it, then `done` runs. */
function release(test: SupertestTest, done: () => void): void {
  const app = holders.get(test);
  if (!app) return done();
  holders.delete(test);
  const left = (users.get(app) ?? 1) - 1;
  if (left > 0) {
    users.set(app, left);
    return done();
  }
  users.delete(app);
  // ERR_SERVER_NOT_RUNNING (already closed) is not the request's failure.
  if (app.listening) app.close(() => done());
  else done();
}

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
    if (app.address()) {
      // A server the test started itself is the test's to close; one this
      // file started stays up until every request using it has finished.
      if (users.has(app)) hold(this, app);
      return originalServerAddress.call(this, app, path);
    }
    // Not listening: start the loopback bind, or share the one in flight.
    // supertest's own close-after-the-first-request (this._server) is not
    // used; release() closes the server after its last request instead.
    hold(this, app);
    pendingRequests.set(this, { app, path, listening: listenOnLoopback(app) });
    // Placeholder with the final host and path (agent cookies are matched on
    // those when the request is created); the port is filled in by end().
    return `http://${LOOPBACK}${path}`;
  };

  testProto.end = function (this: SupertestTest, fn?: EndCallback): SupertestTest {
    if (!holders.has(this)) return originalEnd.call(this, fn);
    const finish: EndCallback = (err, res) => release(this, () => fn?.(err, res));
    const pending = pendingRequests.get(this);
    if (!pending) return originalEnd.call(this, finish);
    pendingRequests.delete(this);
    pending.listening.then(
      () => {
        const { port } = pending.app.address() as AddressInfo;
        this.url = `http://${LOOPBACK}:${port}${pending.path}`;
        originalEnd.call(this, finish);
      },
      (err: unknown) => finish(err),
    );
    return this;
  };
}
