import { useEffect, useState } from 'react';
import { Shield, LogIn } from 'react-feather';
import { HttpError, getJson, postJson } from '../../shared/http';
import { COGNITO_START } from '../lib/signInMode';

// Authenticator-app setup for staff under Cognito sign-in (ai-therapist-396).
// The server holds a staff sign-in that had no authenticator and sends the
// browser to /login?enrol=totp; this finishes it. Nothing here is a signed-in
// session until the code is accepted.
type Step = 'loading' | 'scan' | 'expired';

export default function TotpEnrol() {
  const [step, setStep] = useState<Step>('loading');
  const [username, setUsername] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getJson<{ pending: boolean; username?: string }>('/api/auth/cognito/totp/status');
        if (cancelled) return;
        if (!status.pending) return setStep('expired');
        setUsername(status.username ?? '');
        const begun = await postJson<{ secret: string; qrCode: string }>('/api/auth/cognito/totp/begin');
        if (cancelled) return;
        setSecret(begun.secret);
        setQrCode(begun.qrCode);
        setStep('scan');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Setup could not start.');
        setStep('expired');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const verify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const done = await postJson<{ redirect?: string }>('/api/auth/cognito/totp/verify', { code });
      // Full page navigation, as after any sign-in, so SSR sees the session.
      window.location.href =
        typeof done.redirect === 'string' && /^\/(?!\/)/.test(done.redirect) ? done.redirect : '/admin';
    } catch (err) {
      setBusy(false);
      setCode('');
      if (err instanceof HttpError && err.body?.code === 'code_mismatch') {
        setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : 'Setup did not finish.');
      setStep('expired');
    }
  };

  if (step === 'loading') {
    return <p className="text-sm text-gray-500 text-center">Preparing your authenticator setup...</p>;
  }

  if (step === 'expired') {
    return (
      <div className="space-y-6">
        <div className="rounded-lg bg-red-50 border border-red-200 p-4">
          <p className="text-sm text-red-800 font-medium">
            {error || 'This setup step expired. Sign in again to set up your authenticator app.'}
          </p>
        </div>
        <a
          href={COGNITO_START}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 border border-transparent text-base font-semibold rounded-lg text-white bg-royal hover:bg-navy focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-royal transition-all shadow-lg"
        >
          <LogIn size={18} />
          Sign in again
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
        <Shield className="text-royal flex-shrink-0 mt-0.5" size={20} />
        <div>
          <p className="text-sm text-blue-900 font-medium">Set up your authenticator app</p>
          <p className="text-xs text-blue-700 mt-1">
            Staff accounts{username ? ` (${username})` : ''} sign in with a password and a code. Scan this with an
            authenticator app, then enter the 6-digit code it shows. You will be asked for a code at every sign-in.
          </p>
        </div>
      </div>
      <div className="flex flex-col items-center gap-3">
        <img src={qrCode} alt="Authenticator setup QR code" className="w-48 h-48" />
        <p className="text-xs text-gray-600 text-center">
          Cannot scan? Enter this key in the app:
          <code className="block mt-1 font-mono text-xs break-all text-gray-900">{secret}</code>
        </p>
      </div>
      <form className="space-y-4" onSubmit={verify}>
        <div>
          <label htmlFor="enrolCode" className="block text-sm font-medium text-gray-700 mb-1">
            Authentication code
          </label>
          <input
            id="enrolCode"
            name="enrolCode"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            maxLength={6}
            className="appearance-none relative block w-full px-4 py-3 border border-gray-300 placeholder-gray-400 text-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-royal focus:border-transparent transition-all text-center text-2xl font-mono tracking-widest"
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            disabled={busy}
            autoFocus
          />
        </div>
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4">
            <p className="text-sm text-red-800 font-medium">{error}</p>
          </div>
        )}
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="w-full flex justify-center py-3 px-4 border border-transparent text-base font-semibold rounded-lg text-white bg-royal hover:bg-navy focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-royal transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
        >
          {busy ? 'Checking...' : 'Finish setup and sign in'}
        </button>
      </form>
    </div>
  );
}
