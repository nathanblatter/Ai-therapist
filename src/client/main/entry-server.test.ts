import { describe, expect, it } from 'vitest';
import { render } from './entry-server';

// Smoke test for the participant app's server render (the same `render` the
// prod server imports from dist/server and the dev server loads through
// vite.ssrLoadModule). It guards the router wiring: each route must resolve
// to its element on the server without touching browser-only APIs.
describe('entry-server render', () => {
  it('renders the login page at /login', () => {
    const { html } = render('/login');
    expect(html).toContain('AI Therapist Assistant');
    // Which sign-in runs (the app's own form, or a hosted page that must take
    // the password instead) is only known in the browser, so the server never
    // renders the form: it appears once the mode is known.
    expect(html).toContain('Loading sign-in...');
    expect(html).not.toContain('Enter your username');
    expect(html).not.toContain('type="password"');
  });

  it.each(['/', '/demo', '/profile'])('renders the auth-check placeholder for protected route %s', (url) => {
    const { html } = render(url);
    // ProtectedRoute defers the auth check to the client, so SSR emits the
    // loading shell rather than the protected page or a redirect.
    expect(html).toContain('Loading...');
    expect(html).not.toContain('Loading sign-in...');
  });

  it('falls back to the login page for unknown paths', () => {
    const { html } = render('/no-such-page?x=1');
    expect(html).toContain('AI Therapist Assistant');
    expect(html).toContain('Loading sign-in...');
  });
});
