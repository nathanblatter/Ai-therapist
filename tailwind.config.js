/** @type {import('tailwindcss').Config} */

// Every color family used in the app resolves to CSS variables defined in
// src/client/shared/theme-tokens.css, so existing utility classes keep
// working while a [data-theme] attribute on <html> re-skins the whole UI.
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const varScale = (family) =>
  Object.fromEntries(STEPS.map((s) => [s, `rgb(var(--c-${family}-${s}) / <alpha-value>)`]));
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: [
    "./src/client/main/index.html",
    "./src/client/admin/admin.html",
    "./src/client/**/*.{jsx,tsx,js,ts}"
  ],
  theme: {
    extend: {
      colors: {
        // Brand (themeable)
        navy: token('c-navy'),
        royal: token('c-royal'),
        lightBlue: token('c-lightBlue'),
        white: token('c-white'),
        // Palette families routed through theme variables
        gray: varScale('gray'),
        red: varScale('red'),
        green: varScale('green'),
        blue: varScale('blue'),
        yellow: varScale('yellow'),
        purple: varScale('purple'),
        indigo: varScale('indigo'),
        orange: varScale('orange'),
        amber: varScale('amber'),
        emerald: varScale('emerald'),
        // Semantic tokens — prefer these in new code
        surface: token('t-surface'),
        'surface-muted': token('t-surface-muted'),
        ink: token('t-ink'),
        'ink-muted': token('t-ink-muted'),
        brand: token('t-brand'),
        'brand-strong': token('t-brand-strong'),
        'brand-soft': token('t-brand-soft'),
        accent: token('t-accent'),
      },
    },
  },
  plugins: [],
};
