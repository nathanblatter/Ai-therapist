// Staff email from the study domain (ai-therapist-283 phase 2): a researcher
// writes to outside parties from name@byuisresearch.com; every send is
// recorded in outbound_mail and listed below the form.
//
// Participant content never goes into email. The form says so on every
// compose, and the server refuses anything that looks like a session id.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Mail, Send, RefreshCw } from 'react-feather';
import { getJson, postJson } from '../../shared/http';

interface SenderStatus {
  address: string | null;
  domain: string;
  canSend: boolean;
  reason: string | null;
  sentToday: number;
  dailyCap: number;
}

interface SentRow {
  mail_id: number;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  status: 'sent' | 'queued' | 'failed';
  error: string | null;
  created_at: string;
}

const inputClass =
  'w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-royal min-h-[44px]';

export default function MailView() {
  const [status, setStatus] = useState<SenderStatus | null>(null);
  const [sent, setSent] = useState<SentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState({ to: '', cc: '', subject: '', text: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [me, list] = await Promise.all([
        getJson<SenderStatus>('/admin/api/mail/me', { fallback: 'Failed to load mail status' }),
        getJson<{ mail: SentRow[] }>('/admin/api/mail/sent?limit=50', { fallback: 'Failed to load sent mail' }),
      ]);
      setStatus(me);
      setSent(list.mail);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await postJson<{ mail: { status: string } }>(
        '/admin/api/mail/send',
        { to: form.to, cc: form.cc, subject: form.subject, text: form.text },
        { fallback: 'Failed to send mail' },
      );
      setNotice(
        res.mail.status === 'queued'
          ? 'Accepted. The gateway queued the message and will deliver it when the relay is back.'
          : 'Sent.',
      );
      setForm({ to: '', cc: '', subject: '', text: '' });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <Mail size={22} aria-hidden="true" /> Mail
        </h1>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 min-h-[44px] px-2"
          aria-label="Refresh"
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm text-green-800" role="status">
          {notice}
        </div>
      )}

      {loading && !status ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : status ? (
        <section className="bg-white rounded-lg shadow p-6 space-y-4" aria-labelledby="compose-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="compose-heading" className="text-lg font-semibold text-gray-800">
              Compose
            </h2>
            <p className="text-sm text-gray-600">
              From{' '}
              {status.address ? (
                <span className="font-mono text-xs">{status.address}</span>
              ) : (
                <span className="italic">no study address yet</span>
              )}
              {' · '}
              {status.sentToday}/{status.dailyCap} today
            </p>
          </div>

          <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900 flex gap-2">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5 text-amber-600" aria-hidden="true" />
            <span>
              Participant content never goes into email: no names, usernames, session ids, transcript excerpts or
              anything that could identify a participant. This is for correspondence with outside parties (vendors, the
              PI, the IRB office). Every message is recorded.
            </span>
          </div>

          {!status.canSend ? (
            <p className="text-sm text-gray-700">{status.reason}</p>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label htmlFor="mail-to" className="block text-sm font-medium text-gray-700 mb-1">
                  To (comma-separated)
                </label>
                <input
                  id="mail-to"
                  type="text"
                  required
                  value={form.to}
                  onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
                  className={inputClass}
                  placeholder="someone@example.com"
                />
              </div>
              <div>
                <label htmlFor="mail-cc" className="block text-sm font-medium text-gray-700 mb-1">
                  Cc (optional)
                </label>
                <input
                  id="mail-cc"
                  type="text"
                  value={form.cc}
                  onChange={(e) => setForm((f) => ({ ...f, cc: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="mail-subject" className="block text-sm font-medium text-gray-700 mb-1">
                  Subject
                </label>
                <input
                  id="mail-subject"
                  type="text"
                  required
                  maxLength={200}
                  value={form.subject}
                  onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="mail-text" className="block text-sm font-medium text-gray-700 mb-1">
                  Message (plain text)
                </label>
                <textarea
                  id="mail-text"
                  required
                  rows={10}
                  maxLength={20000}
                  value={form.text}
                  onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-royal font-mono text-sm"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={sending}
                  className="flex items-center gap-2 bg-royal text-white px-4 py-2 rounded-md hover:bg-royal/90 disabled:opacity-50 min-h-[44px]"
                >
                  <Send size={16} aria-hidden="true" /> {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      <section className="bg-white rounded-lg shadow overflow-hidden" aria-labelledby="sent-heading">
        <h2 id="sent-heading" className="text-lg font-semibold text-gray-800 px-6 pt-5 pb-3">
          Sent
        </h2>
        {sent.length === 0 ? (
          <p className="px-6 pb-5 text-sm text-gray-500">Nothing sent yet.</p>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  When
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  To
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Subject
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sent.map((m) => (
                <tr key={m.mail_id}>
                  <td className="px-6 py-3 text-sm text-gray-700 whitespace-nowrap">
                    {new Date(m.created_at).toLocaleString()}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-700 font-mono text-xs">
                    {m.to_addresses.join(', ')}
                    {m.cc_addresses.length > 0 ? ` (cc ${m.cc_addresses.join(', ')})` : ''}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-900">{m.subject}</td>
                  <td className="px-6 py-3 text-sm">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                        m.status === 'sent'
                          ? 'bg-green-100 text-green-800'
                          : m.status === 'queued'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-red-100 text-red-800'
                      }`}
                      title={m.error ?? undefined}
                    >
                      {m.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
