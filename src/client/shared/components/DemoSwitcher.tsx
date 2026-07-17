import { useEffect, useState } from 'react';

// Persistent demo navigation bar shown to magic-link 'demo' accounts in BOTH the
// therapy bot (main SPA) and the clinician dashboard (admin SPA), so a visitor
// can move between the two. Renders nothing for everyone else. Cross-app links
// use plain <a href> because the bot and admin are separate SPAs.
interface DemoSwitcherProps {
  context: 'bot' | 'admin' | 'landing';
  // Pass the role if the host already knows it, to skip the extra fetch.
  role?: string | null;
}

export default function DemoSwitcher({ context, role: roleProp }: DemoSwitcherProps) {
  const [role, setRole] = useState<string | null | undefined>(roleProp);

  useEffect(() => {
    if (roleProp !== undefined) {
      setRole(roleProp);
      return;
    }
    let active = true;
    fetch('/api/auth/status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active) setRole(d?.user?.role ?? null);
      })
      .catch(() => {
        if (active) setRole(null);
      });
    return () => {
      active = false;
    };
  }, [roleProp]);

  if (role !== 'demo') return null;

  const note =
    context === 'admin'
      ? 'Synthetic data — nothing here is real and changes are not saved.'
      : 'Live demo — capped at 5 sessions/day, 5 minutes each.';

  const link = (href: string, label: string, active: boolean) => (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`px-3 py-1 rounded-md text-sm font-medium transition ${
        active ? 'bg-amber-500 text-white' : 'text-amber-900 hover:bg-amber-200'
      }`}
    >
      {label}
    </a>
  );

  return (
    <div className="bg-amber-100 border-b border-amber-300 px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="text-amber-900 font-semibold text-sm">Demo mode</span>
      <nav className="flex items-center gap-1">
        {link('/demo', 'Overview', context === 'landing')}
        {link('/', 'Therapy bot', context === 'bot')}
        {link('/admin', 'Clinician dashboard', context === 'admin')}
      </nav>
      <span className="text-amber-800 text-xs">{note}</span>
    </div>
  );
}
