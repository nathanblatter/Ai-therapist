// Client-side theme + accessibility controller. The actual colors live in
// theme-tokens.css; this module just stamps data-* attributes on <html> and
// persists choices in localStorage (index.html/admin.html have a tiny inline
// bootstrap that re-applies them before first paint to avoid a flash).

export interface ThemeOption {
  value: string;
  label: string;
  description: string;
  /** Swatch colors for the theme picker UI. */
  swatch: [string, string, string];
}

export const THEMES: ThemeOption[] = [
  { value: 'default', label: 'Classic Blue', description: 'The original look', swatch: ['#002E5D', '#0047BA', '#BDD6E6'] },
  { value: 'sage', label: 'Sage', description: 'Calm greens', swatch: ['#22452F', '#3F7052', '#CDE3D2'] },
  { value: 'ocean', label: 'Ocean', description: 'Cool teals', swatch: ['#0C3A4A', '#0E7490', '#BFE5EF'] },
  { value: 'dusk', label: 'Dusk', description: 'Soft violets', swatch: ['#33294D', '#63549C', '#DAD3EC'] },
  { value: 'dark', label: 'Dark', description: 'Low light', swatch: ['#111827', '#1D5FD6', '#1F2937'] },
];

export const THEME_VALUES = THEMES.map((t) => t.value);

export interface A11yPrefs {
  fontSize: 'sm' | 'md' | 'lg' | 'xl';
  motion: 'system' | 'reduce' | 'allow';
  contrast: 'normal' | 'high';
  font: 'default' | 'dyslexic';
}

export const DEFAULT_A11Y: A11yPrefs = { fontSize: 'md', motion: 'system', contrast: 'normal', font: 'default' };

// The main participant app and the admin portal are separate pages with
// separate concerns (user preference vs. monitoring-shift convenience),
// so they persist under different keys.
export const THEME_STORAGE_KEY = 'app-theme';
export const ADMIN_THEME_STORAGE_KEY = 'admin-theme';
const A11Y_STORAGE_KEY = 'app-a11y';

const canUseDom = () => typeof document !== 'undefined';

export function applyTheme(theme: string): void {
  if (!canUseDom()) return;
  const value = THEME_VALUES.includes(theme) ? theme : 'default';
  if (value === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', value);
  }
}

export function getStoredTheme(storageKey: string = THEME_STORAGE_KEY): string {
  if (!canUseDom()) return 'default';
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored && THEME_VALUES.includes(stored) ? stored : 'default';
  } catch {
    return 'default';
  }
}

export function setTheme(theme: string, storageKey: string = THEME_STORAGE_KEY): void {
  applyTheme(theme);
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // Storage unavailable (private mode etc.) — theme still applies for the page.
  }
}

export function getStoredA11y(): A11yPrefs {
  if (!canUseDom()) return DEFAULT_A11Y;
  try {
    const raw = window.localStorage.getItem(A11Y_STORAGE_KEY);
    if (!raw) return DEFAULT_A11Y;
    return { ...DEFAULT_A11Y, ...(JSON.parse(raw) as Partial<A11yPrefs>) };
  } catch {
    return DEFAULT_A11Y;
  }
}

export function applyA11y(prefs: A11yPrefs): void {
  if (!canUseDom()) return;
  const el = document.documentElement;
  const set = (attr: string, value: string, defaultValue: string) => {
    if (value === defaultValue) el.removeAttribute(attr);
    else el.setAttribute(attr, value);
  };
  set('data-fontsize', prefs.fontSize, 'md');
  set('data-motion', prefs.motion, 'system');
  set('data-contrast', prefs.contrast, 'normal');
  set('data-font', prefs.font, 'default');
}

export function setA11y(prefs: A11yPrefs): void {
  applyA11y(prefs);
  try {
    window.localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable — prefs still apply for the page.
  }
}
