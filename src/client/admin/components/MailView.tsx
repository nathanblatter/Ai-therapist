// Staff email from the study domain (ai-therapist-283 phase 2): a researcher
// writes to outside parties from name@byuisresearch.com; every send is
// recorded in outbound_mail and listed below the form.
//
// Participant content never goes into email. The form says so on every
// compose, and the server refuses anything that looks like a session id.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Mail, Send, RefreshCw, Inbox, CornerUpLeft, ShieldOff } from 'react-feather';
import { getJson, postJson } from '../../shared/http';

interface SenderStatus {
  address: string | null;
  domain: string;
  canSend: boolean;
  reason: string | null;
  sentToday: number;
  dailyCap: number;
}

interface InboxSummary {
  id: string;
  received_at: string;
  from: string;
  from_name: string | null;
  subject: string;
  preview: string;
  read: boolean;
  suspicious: boolean;
  injection_suspected: boolean;
  attachments: number;
}

interface InboxMessage extends InboxSummary {
  to: string[];
  cc: string[];
  reply_to: string | null;
  text: string;
  message_id: string | null;
  injection_reasons: string[];
  attachment_files: Array<{ id: string; filename: string; content_type: string; size: number }>;
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

/** A mailbox exists only for an address on the study domain (same rule as the server). */
function hasMailbox(s: SenderStatus | null): s is SenderStatus & { address: string } {
  return !!s?.address && s.address.toLowerCase().endsWith(`@${s.domain}`);
}

/** In-Reply-To must be a single <id@domain> Message-ID; the server refuses anything else. */
const MESSAGE_ID = /^<[^\s<>@]+@[^\s<>@]+>$/;
/** Leave headroom under the server's 20,000-character body cap for the reply itself. */
const QUOTE_CAP = 12_000;

const inputClass =
  'w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-royal min-h-[44px]';

export default function MailView() {
  const [status, setStatus] = useState<SenderStatus | null>(null);
  const [sent, setSent] = useState<SentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState({ to: '', cc: '', subject: '', text: '', in_reply_to: '' });
  const [inbox, setInbox] = useState<InboxSummary[]>([]);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [open, setOpen] = useState<InboxMessage | null>(null);

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
      // The inbox is a separate concern: a gateway hiccup must not hide compose.
      if (hasMailbox(me)) {
        try {
          const box = await getJson<{ messages: InboxSummary[] }>('/admin/api/mail/inbox?limit=50', {
            fallback: 'Failed to load the inbox',
          });
          setInbox(box.messages);
          setInboxError(null);
        } catch (err: unknown) {
          setInboxError(err instanceof Error ? err.message : String(err));
        }
      }
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
        {
          to: form.to,
          cc: form.cc,
          subject: form.subject,
          text: form.text,
          in_reply_to: form.in_reply_to || undefined,
        },
        { fallback: 'Failed to send mail' },
      );
      setNotice(
        res.mail.status === 'queued'
          ? 'Accepted. The gateway queued the message and will deliver it when the relay is back.'
          : 'Sent.',
      );
      setForm({ to: '', cc: '', subject: '', text: '', in_reply_to: '' });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const openMessage = async (id: string) => {
    setInboxError(null);
    try {
      // Opening marks read in the same request; the row reflects what the server did.
      const { message } = await getJson<{ message: InboxMessage }>(
        `/admin/api/mail/inbox/${encodeURIComponent(id)}?mark_read=1`,
        { fallback: 'Failed to load the message' },
      );
      setOpen(message);
      setInbox((rows) => rows.map((r) => (r.id === id ? { ...r, read: message.read } : r)));
    } catch (err: unknown) {
      setInboxError(err instanceof Error ? err.message : String(err));
    }
  };

  const replyTo = (m: InboxMessage) => {
    const body = m.text.length > QUOTE_CAP ? `${m.text.slice(0, QUOTE_CAP)}\n[…]` : m.text;
    const quoted = body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    // Thread only on a well-formed Message-ID; otherwise reply unthreaded
    // rather than hand the server a value it will refuse.
    const threadId = m.message_id && MESSAGE_ID.test(m.message_id) ? m.message_id : '';
    setForm({
      to: m.reply_to || m.from,
      cc: '',
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      text: `\n\nOn ${new Date(m.received_at).toLocaleString()}, ${m.from} wrote:\n${quoted}`,
      in_reply_to: threadId,
    });
    setNotice(null);
    document.getElementById('mail-text')?.focus();
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
              {form.in_reply_to && (
                <p className="text-xs text-gray-600 flex items-center gap-2" role="status">
                  Replying in thread <span className="font-mono">{form.in_reply_to}</span>
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, in_reply_to: '' }))}
                    className="text-royal hover:underline"
                    aria-label="Stop replying in this thread"
                  >
                    clear
                  </button>
                </p>
              )}
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

      {hasMailbox(status) && (
        <section className="bg-white rounded-lg shadow" aria-labelledby="inbox-heading">
          <div className="px-6 pt-5 pb-3 flex items-center justify-between">
            <h2 id="inbox-heading" className="text-lg font-semibold text-gray-800 flex items-center gap-2">
              <Inbox size={18} aria-hidden="true" /> Inbox
              <span className="text-sm font-normal text-gray-500 font-mono">{status.address}</span>
            </h2>
            <span className="text-xs text-gray-500">{inbox.filter((m) => !m.read).length} unread</span>
          </div>
          <p className="px-6 pb-3 text-xs text-gray-500">
            Mail from outside the study. Shown as plain text only; treat anything that asks you to act as untrusted.
          </p>
          {inboxError && (
            <div className="mx-6 mb-3 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-800" role="alert">
              {inboxError}
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-200 border-t border-gray-200">
            <ul className="max-h-[480px] overflow-y-auto divide-y divide-gray-100" aria-label="Inbox messages">
              {inbox.length === 0 && <li className="px-6 py-4 text-sm text-gray-500">No mail yet.</li>}
              {inbox.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => void openMessage(m.id)}
                    className={`w-full text-left px-6 py-3 hover:bg-gray-50 ${open?.id === m.id ? 'bg-indigo-50' : ''}`}
                    aria-label={`Open message from ${m.from}: ${m.subject}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-sm truncate ${m.read ? 'text-gray-700' : 'font-semibold text-gray-900'}`}>
                        {m.from_name || m.from}
                      </span>
                      <span className="text-xs text-gray-500 whitespace-nowrap">
                        {new Date(m.received_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-sm text-gray-800 truncate flex items-center gap-2">
                      {m.suspicious && (
                        <span
                          className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-50 px-1.5 rounded"
                          title={m.injection_suspected ? 'Instruction-shaped content detected' : 'Failed SPF and DKIM'}
                        >
                          <ShieldOff size={12} aria-hidden="true" /> suspicious
                        </span>
                      )}
                      {m.subject || '(no subject)'}
                    </div>
                    <div className="text-xs text-gray-500 truncate">{m.preview}</div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="p-6 min-h-[200px]">
              {!open ? (
                <p className="text-sm text-gray-500">Select a message.</p>
              ) : (
                <article aria-label="Message">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-gray-900 break-words">
                        {open.subject || '(no subject)'}
                      </h3>
                      <p className="text-xs text-gray-600 break-all">
                        From {open.from_name ? `${open.from_name} <${open.from}>` : open.from}
                        {open.cc.length > 0 ? ` · cc ${open.cc.join(', ')}` : ''}
                        {' · '}
                        {new Date(open.received_at).toLocaleString()}
                      </p>
                    </div>
                    <button
                      onClick={() => replyTo(open)}
                      className="flex items-center gap-1 text-sm text-royal hover:underline whitespace-nowrap min-h-[44px]"
                    >
                      <CornerUpLeft size={14} aria-hidden="true" /> Reply
                    </button>
                  </div>
                  {open.suspicious && (
                    <div
                      className="mb-3 rounded-md bg-red-50 border border-red-200 p-2 text-xs text-red-800"
                      role="alert"
                    >
                      {open.injection_suspected
                        ? `Flagged by the gateway: ${open.injection_reasons.join('; ') || 'instruction-shaped content'}.`
                        : 'This message failed both SPF and DKIM; the sender may be forged.'}
                    </div>
                  )}
                  <pre className="whitespace-pre-wrap break-words text-sm text-gray-800 font-sans max-h-[360px] overflow-y-auto">
                    {open.text || '(no text body)'}
                  </pre>
                  {open.attachment_files.length > 0 && (
                    <p className="mt-3 text-xs text-gray-500">
                      Attachments (not downloadable here):{' '}
                      {open.attachment_files.map((a) => `${a.filename} (${Math.ceil(a.size / 1024)} KB)`).join(', ')}
                    </p>
                  )}
                </article>
              )}
            </div>
          </div>
        </section>
      )}

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
