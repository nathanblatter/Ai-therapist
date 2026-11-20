// Runs scripts/recording-gaps-check.test.ts (headless Chromium, ai-therapist-384)
// with the main Vitest config's resolver. Not part of `npm test`.
import { defineConfig } from 'vitest/config';
import base from '../vitest.config';

export default defineConfig({
  plugins: base.plugins,
  test: {
    environment: 'node',
    include: ['scripts/recording-gaps-check.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test', OPENAI_API_KEY: '' },
  },
});
