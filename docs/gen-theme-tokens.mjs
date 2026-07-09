// Generates src/client/shared/theme-tokens.css from Tailwind's default palette.
// Re-run with: node gen-theme-tokens.mjs <repo-root>
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const root = process.argv[2] || '.';
const require = createRequire(path.resolve(root, 'package.json'));
const colors = require('tailwindcss/colors');
const out = path.join(root, 'src/client/shared/theme-tokens.css');

const FAMILIES = ['gray', 'red', 'green', 'blue', 'yellow', 'purple', 'indigo', 'orange', 'amber', 'emerald'];
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)).join(' ');
};

const varLine = (name, hex) => `  --c-${name}: ${hexToRgb(hex)};`;

// ---- Light (default) values: Tailwind defaults + brand ----
let light = [];
light.push(varLine('white', '#ffffff'));
light.push(varLine('navy', '#002E5D'));
light.push(varLine('royal', '#0047BA'));
light.push(varLine('lightBlue', '#BDD6E6'));
for (const fam of FAMILIES) {
  for (const s of STEPS) light.push(varLine(`${fam}-${s}`, colors[fam][s]));
}

// Semantic aliases (light)
const semanticLight = `
  /* Semantic tokens — prefer these in new code */
  --t-surface: var(--c-white);
  --t-surface-muted: var(--c-gray-50);
  --t-ink: var(--c-gray-900);
  --t-ink-muted: var(--c-gray-500);
  --t-brand: var(--c-royal);
  --t-brand-strong: var(--c-navy);
  --t-brand-soft: var(--c-lightBlue);
  --t-accent: var(--c-royal);
  --t-orb-a: 0 71 186;
  --t-orb-b: 124 192 255;`;

// ---- Dark values ----
// Status families: flip tints/shades so chips (bg-*-50/100 + text-*-800/900)
// invert cleanly, but keep the rich 400-700 range for buttons.
const darkStatusMap = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 400, 500: 500, 600: 600, 700: 700, 800: 200, 900: 100, 950: 50 };
// Gray ramp is hand-tuned (page/card/hover layering + readable text).
const darkGray = {
  50: '#111827', 100: '#374151', 200: '#4B5563', 300: '#6B7280',
  400: '#94A3B8', 500: '#9CA3AF', 600: '#D1D5DB', 700: '#E5E7EB',
  800: '#F3F4F6', 900: '#F9FAFB', 950: '#FFFFFF',
};

let dark = [];
dark.push(varLine('white', '#1F2937'));
dark.push(varLine('navy', '#0B2946'));
dark.push(varLine('royal', '#1D5FD6'));
dark.push(varLine('lightBlue', '#9EC5DD'));
for (const s of STEPS) dark.push(varLine(`gray-${s}`, darkGray[s]));
for (const fam of FAMILIES) {
  if (fam === 'gray') continue;
  for (const s of STEPS) dark.push(varLine(`${fam}-${s}`, colors[fam][darkStatusMap[s]]));
}

const semanticDark = `
  --t-surface: var(--c-white);
  --t-surface-muted: var(--c-gray-50);
  --t-ink: var(--c-gray-900);
  --t-ink-muted: var(--c-gray-500);
  --t-brand: var(--c-royal);
  --t-brand-strong: var(--c-navy);
  --t-brand-soft: var(--c-lightBlue);
  --t-accent: var(--c-royal);
  --t-orb-a: 59 130 246;
  --t-orb-b: 34 211 238;
  color-scheme: dark;`;

// Dark fixups: utilities whose single token is used for two jobs
// (light text on colored buttons vs. dark text on light surfaces).
const textFixFamilies = FAMILIES.filter((f) => f !== 'gray');
const darkFixups = [
  `[data-theme="dark"] .text-white { color: #fff; }`,
  `[data-theme="dark"] .text-navy { color: rgb(var(--c-lightBlue)); }`,
  `[data-theme="dark"] .text-royal { color: #8AB4F8; }`,
  `[data-theme="dark"] .bg-gray-600 { background-color: #4B5563; }`,
  `[data-theme="dark"] .bg-gray-700 { background-color: #374151; }`,
  `[data-theme="dark"] .bg-gray-800 { background-color: #374151; }`,
  `[data-theme="dark"] .bg-gray-900 { background-color: #1F2937; }`,
  `[data-theme="dark"] .hover\\:bg-gray-600:hover { background-color: #6B7280; }`,
  `[data-theme="dark"] .hover\\:bg-gray-700:hover { background-color: #4B5563; }`,
  `[data-theme="dark"] .hover\\:bg-gray-800:hover { background-color: #1F2937; }`,
  `[data-theme="dark"] .hover\\:bg-gray-900:hover { background-color: #4B5563; }`,
  ...textFixFamilies.flatMap((f) => [
    `[data-theme="dark"] .text-${f}-500 { color: ${colors[f][400]}; }`,
    `[data-theme="dark"] .text-${f}-600 { color: ${colors[f][400]}; }`,
    `[data-theme="dark"] .text-${f}-700 { color: ${colors[f][300]}; }`,
  ]),
];

// ---- Calm light presets: retint brand + soft surfaces only ----
const presets = {
  sage: {
    navy: '#22452F', royal: '#3F7052', lightBlue: '#CDE3D2',
    'gray-50': '#F4F7F4', 'gray-100': '#E7EEE8',
    orbA: '#3F7052', orbB: '#A8D5B5',
  },
  ocean: {
    navy: '#0C3A4A', royal: '#0E7490', lightBlue: '#BFE5EF',
    'gray-50': '#F2F8FA', 'gray-100': '#E3EFF3',
    orbA: '#0E7490', orbB: '#67E8F9',
  },
  dusk: {
    navy: '#33294D', royal: '#63549C', lightBlue: '#DAD3EC',
    'gray-50': '#F6F5FA', 'gray-100': '#ECEAF4',
    orbA: '#63549C', orbB: '#C4B5FD',
  },
};

const presetBlock = (name, p) => `
/* ${name} — calm light preset */
:root[data-theme="${name}"] {
${varLine('navy', p.navy)}
${varLine('royal', p.royal)}
${varLine('lightBlue', p.lightBlue)}
${varLine('gray-50', p['gray-50'])}
${varLine('gray-100', p['gray-100'])}
  --t-orb-a: ${hexToRgb(p.orbA)};
  --t-orb-b: ${hexToRgb(p.orbB)};
}`;

const css = `/* ============================================================
 * Theme tokens — GENERATED by scratchpad/gen-theme-tokens.mjs.
 * All Tailwind color utilities in this app resolve to these CSS
 * variables (see tailwind.config.js), so a [data-theme] attribute
 * on <html> re-skins the whole UI. Values are "R G B" triplets so
 * Tailwind opacity modifiers keep working.
 * Themes: default (classic blue) | sage | ocean | dusk | dark
 * ============================================================ */

:root {
${light.join('\n')}
${semanticLight}
}
${Object.entries(presets).map(([n, p]) => presetBlock(n, p)).join('\n')}

/* dark — full dark mode (used by participants and the admin portal) */
:root[data-theme="dark"] {
${dark.join('\n')}
${semanticDark}
}

/* Dark-mode fixups: a few utilities are dual-use (e.g. text-white as
 * "light text on colored button" vs white as a themeable surface), so
 * they get explicit values instead of the flipped ramp. */
${darkFixups.join('\n')}
[data-theme="dark"] body { color: rgb(229 231 235); }
`;

fs.writeFileSync(out, css);
console.log(`wrote ${out} (${css.length} bytes)`);
