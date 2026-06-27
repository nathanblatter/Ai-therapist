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
    // Set before any test module loads. OPENAI_API_KEY makes getOpenAIKey()
    // short-circuit before touching AWS Secrets Manager — several modules call
    // it at import time (e.g. redaction.service), so tests must never depend on
    // AWS credentials being present.
    env: {
      OPENAI_API_KEY: 'sk-test-key',
      SESSION_SECRET: 'test-session-secret',
      NODE_ENV: 'test',
    },
  },
});
