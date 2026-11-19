import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The server sources use NodeNext-style `.js` import specifiers that point at
  // `.ts` files. This tiny pre-resolver lets Vitest follow them to the source.
  plugins: [
    {
      name: 'js-to-ts-resolver',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (importer && source.startsWith('.') && source.endsWith('.js')) {
          const resolved = await this.resolve(source.replace(/\.js$/, '.ts'), importer, { skipSelf: true });
          if (resolved) return resolved.id;
        }
        return null;
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // supertest servers bind 127.0.0.1 so no other process on the machine can
    // answer a test's request (ai-therapist-279; see the file's header).
    setupFiles: ['src/server/testing/supertestLoopback.ts', 'src/server/testing/shiftedClock.ts'],
    // Set before any test module loads. OPENAI_API_KEY makes getOpenAIKey()
    // short-circuit before touching AWS Secrets Manager — several modules call
    // it at import time (e.g. redaction.service), so tests must never depend on
    // AWS credentials being present.
    env: {
      OPENAI_API_KEY: 'sk-test-key',
      SESSION_SECRET: 'test-session-secret',
      NODE_ENV: 'test',
      // Tests that import the server entry (src/server/index.ts) would
      // otherwise attach the socket.io Postgres adapter to the mocked pool,
      // and its 5-second heartbeat (SELECT pg_notify) lands in whatever test
      // is running at the time (ai-therapist-279). No test exercises
      // cross-container fan-out, and index.ts already honours this switch.
      SOCKET_PG_ADAPTER: 'off',
      // No test may page anyone, whatever .env the run picks up (config/db.ts
      // loads dotenv, which never overrides a variable that is already set,
      // even to ''). Tests that exercise a channel set fictitious values
      // themselves with the transport faked.
      IMESSAGE_API_KEY: '',
      CRISIS_ALERT_PHONE: '',
      CRISIS_SMS_AWS_REGION: '',
      CRISIS_SMS_ORIGINATION_IDENTITY: '',
    },
  },
});
