import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import AdminApp from './components/AdminApp';
import { restorePendingDeepLink } from './utils/pendingDeepLink';
import '../shared/base.css';

// Add hydrated class to prevent FOUC
document.body.classList.add('hydrated');

// A crisis page link opened while signed out went through /login, which kept
// its hash; put it back before AdminApp reads location.hash on mount.
try {
  restorePendingDeepLink(window.sessionStorage, window.location, Date.now(), (url) =>
    window.history.replaceState(null, '', url),
  );
} catch {
  /* storage unavailable: open the dashboard as usual */
}

// Admin is a plain SPA (no SSR) — render into the empty root.
ReactDOM.createRoot(document.getElementById('root') as Element).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
