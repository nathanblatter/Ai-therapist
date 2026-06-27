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
  },
});
