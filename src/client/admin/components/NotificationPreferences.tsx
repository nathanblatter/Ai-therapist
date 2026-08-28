import { useEffect, useState } from 'react';
import { Bell, Save } from 'react-feather';
import Panel from './ui/Panel';
import {
  fetchNotificationPreferences,
  saveNotificationPreferences,
  type NotificationPreferences as Prefs,
} from '../hooks/useNotifications';

// Per-user notification delivery preferences (email mode, urgent override,
// digest hour, in-app toggle). Self-scoped server-side.

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:00 ${suffix}`;
}

export default function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchNotificationPreferences()
      .then(setPrefs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load preferences'))
      .finally(() => setLoading(false));
  }, []);

  const update = (patch: Partial<Prefs>) => {
    setPrefs((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
  };

  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    setError(null);
    try {
      const next = await saveNotificationPreferences(prefs);
      setPrefs(next);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save preferences');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Notification preferences" icon={Bell}>
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !prefs ? (
        <p className="text-sm text-red-600">{error ?? 'Failed to load preferences'}</p>
      ) : (
        <div className="space-y-4 max-w-md">
          <div>
            <label className="block text-sm font-medium text-ink mb-1" htmlFor="pref-email-mode">
              Email delivery
            </label>
            <select
              id="pref-email-mode"
              value={prefs.email_mode}
              onChange={(e) => update({ email_mode: e.target.value as Prefs['email_mode'] })}
              className="w-full border border-gray-300 rounded-lg p-2 text-sm"
            >
              <option value="immediate">Immediate — email me as things happen</option>
              <option value="digest">Daily digest — one summary email a day</option>
              <option value="off">Off — in-app only</option>
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={prefs.urgent_email_immediate}
              onChange={(e) => update({ urgent_email_immediate: e.target.checked })}
            />
            Always email urgent safety items immediately
          </label>

          <div>
            <label className="block text-sm font-medium text-ink mb-1" htmlFor="pref-digest-hour">
              Daily digest time
            </label>
            <select
              id="pref-digest-hour"
              value={prefs.digest_hour_local}
              onChange={(e) => update({ digest_hour_local: Number(e.target.value) })}
              className="w-full border border-gray-300 rounded-lg p-2 text-sm"
              disabled={prefs.email_mode === 'off'}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={prefs.in_app_enabled}
              onChange={(e) => update({ in_app_enabled: e.target.checked })}
            />
            Show in-app notifications
          </label>

          <p className="text-xs text-gray-500">
            For privacy, emails never include client names or content — log in to see details.
          </p>

          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="bg-navy text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-60"
            >
              <Save size={14} />
              {saving ? 'Saving…' : 'Save preferences'}
            </button>
            {saved && <span className="text-sm text-green-700">Saved</span>}
          </div>
        </div>
      )}
    </Panel>
  );
}
