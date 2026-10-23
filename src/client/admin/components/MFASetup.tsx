import { useState, useEffect } from 'react';
import { Shield, Key, Copy, CheckCircle, AlertTriangle } from 'react-feather';
import {
  decodeCreationOptions,
  deviceName,
  encodeAttestation,
  isCancelled,
  passkeysSupported,
} from '../../shared/lib/webauthn';
import { getJson, postJson } from '../../shared/http';

interface PasskeyMeta {
  id: string;
  name: string;
  created_at: string;
}

/** Passkeys on the signed-in account, through Squawk (auth-service-33).
 *  Registering one converts a password account: Squawk deletes the hash, so
 *  from then on the person signs in with the passkey (a researcher can set a
 *  new password, which converts it back). Hidden when Squawk is not configured. */
function PasskeyCard() {
  const [state, setState] = useState<{ enabled: boolean; linked: boolean; passkeys: PasskeyMeta[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const cfg = await getJson<{ enabled: boolean }>('/api/auth/squawk/config');
      if (!cfg.enabled) {
        setState({ enabled: false, linked: false, passkeys: [] });
        return;
      }
      const data = await getJson<{ linked: boolean; passkeys: PasskeyMeta[] }>('/api/auth/squawk/passkeys');
      setState({ enabled: true, linked: data.linked, passkeys: data.passkeys ?? [] });
    } catch {
      setState({ enabled: false, linked: false, passkeys: [] });
    }
  };

  useEffect(() => {
    load();
  }, []);

  const register = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const begin = await postJson<{
        challenge_id?: string;
        options?: { publicKey: Parameters<typeof decodeCreationOptions>[0] };
        error?: string;
      }>('/api/auth/squawk/passkeys/begin', undefined, { fallback: 'Could not start passkey registration.' });
      if (!begin.challenge_id || !begin.options)
        throw new Error(begin.error || 'Could not start passkey registration.');
      const cred = await navigator.credentials.create({ publicKey: decodeCreationOptions(begin.options.publicKey) });
      if (!cred) throw new Error('No passkey was created.');
      await postJson(
        '/api/auth/squawk/passkeys/finish',
        {
          challenge_id: begin.challenge_id,
          name: deviceName(),
          credential: encodeAttestation(cred as PublicKeyCredential),
        },
        { fallback: 'Passkey registration failed.' },
      );
      setMessage('Passkey registered. From now on this account signs in with a passkey instead of a password.');
      await load();
    } catch (err) {
      setError(
        isCancelled(err)
          ? 'Passkey prompt was cancelled.'
          : err instanceof Error
            ? err.message
            : 'Passkey registration failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!state || !state.enabled) return null;
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-start gap-3">
        <Key className="text-royal flex-shrink-0 mt-0.5" size={20} />
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Passkeys</h3>
          <p className="text-sm text-gray-600 mt-1">
            Sign in with Face ID, Touch ID or a security key instead of a password. Registering a passkey replaces the
            password on this account.
          </p>
        </div>
      </div>
      {state.passkeys.length > 0 ? (
        <ul className="text-sm text-gray-700 divide-y divide-gray-100">
          {state.passkeys.map((p) => (
            <li key={p.id} className="py-2 flex justify-between">
              <span>{p.name}</span>
              <span className="text-gray-400">{new Date(p.created_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No passkeys registered on this account.</p>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {message && <p className="text-sm text-green-700">{message}</p>}
      {!state.linked ? (
        <p className="text-sm text-gray-500">
          This account has not signed in through Squawk yet. Sign out and back in, then register a passkey.
        </p>
      ) : passkeysSupported() ? (
        <button
          type="button"
          onClick={register}
          disabled={busy}
          className="px-4 py-2 bg-royal text-white rounded-lg text-sm font-semibold hover:bg-navy disabled:opacity-50"
        >
          {busy ? 'Waiting for your device...' : 'Register a passkey on this device'}
        </button>
      ) : (
        <p className="text-sm text-gray-500">This browser does not support passkeys.</p>
      )}
    </div>
  );
}

interface MFAStatus {
  enabled: boolean;
  backupCodesRemaining: number;
  enabledAt?: string;
}

export default function MFASetup() {
  const [mfaStatus, setMfaStatus] = useState<MFAStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupStep, setSetupStep] = useState<string | null>(null); // 'init', 'verify', 'complete'
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Fetch MFA status on load
  useEffect(() => {
    fetchMFAStatus();
  }, []);

  const fetchMFAStatus = async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await getJson<{ mfa: MFAStatus }>('/api/mfa/status', { fallback: 'Failed to fetch MFA status' });
      setMfaStatus(data.mfa);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const startSetup = async () => {
    setError(null);
    setLoading(true);

    try {
      const data = await postJson<{ qrCode: string; secret: string }>('/api/mfa/setup/init', undefined, {
        fallback: 'Failed to initialize MFA setup',
      });
      setQrCode(data.qrCode);
      setSecret(data.secret);
      setSetupStep('verify');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const verifySetup = async () => {
    if (!token || token.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const data = await postJson<{ backupCodes: string[] }>(
        '/api/mfa/setup/verify',
        { token },
        { fallback: 'Failed to verify token' },
      );
      setBackupCodes(data.backupCodes);
      setSetupStep('complete');
      setSuccessMessage('MFA enabled successfully!');

      // Refresh status after short delay
      setTimeout(fetchMFAStatus, 1000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const disableMFA = async () => {
    if (!password) {
      setError('Please enter your password');
      return;
    }

    if (!confirm('Are you sure you want to disable MFA? This will make your account less secure.')) {
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await postJson('/api/mfa/disable', { password }, { fallback: 'Failed to disable MFA' });

      setSuccessMessage('MFA disabled successfully');
      setPassword('');
      fetchMFAStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const regenerateBackupCodes = async () => {
    if (!password) {
      setError('Please enter your password');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const data = await postJson<{ backupCodes: string[] }>(
        '/api/mfa/regenerate-backup-codes',
        { password },
        { fallback: 'Failed to regenerate backup codes' },
      );
      setBackupCodes(data.backupCodes);
      setSetupStep('complete');
      setSuccessMessage('Backup codes regenerated successfully!');
      setPassword('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setSuccessMessage('Copied to clipboard!');
    setTimeout(() => setSuccessMessage(null), 2000);
  };

  const copyAllBackupCodes = () => {
    const text = backupCodes.join('\n');
    copyToClipboard(text);
  };

  if (loading && !qrCode) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Loading MFA settings...</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PasskeyCard />
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Shield className="text-royal" />
          Multi-Factor Authentication (MFA)
        </h2>
      </div>

      {error && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">{error}</div>}

      {successMessage && (
        <div className="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded flex items-center gap-2">
          <CheckCircle size={20} />
          {successMessage}
        </div>
      )}

      {/* MFA Status */}
      {mfaStatus && !setupStep && (
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Current Status</h3>
            <span
              className={`px-3 py-1 rounded-full text-sm font-medium ${
                mfaStatus.enabled ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
              }`}
            >
              {mfaStatus.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>

          {mfaStatus.enabled ? (
            <div className="space-y-4">
              <p className="text-gray-600">
                MFA is protecting your account. You have {mfaStatus.backupCodesRemaining} backup codes remaining.
              </p>

              {mfaStatus.enabledAt && (
                <p className="text-sm text-gray-500">
                  Enabled on: {new Date(mfaStatus.enabledAt).toLocaleDateString()}
                </p>
              )}

              <div className="border-t pt-4 space-y-3">
                <h4 className="font-semibold">Manage MFA</h4>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Enter password to regenerate backup codes or disable MFA
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your password"
                    className="border rounded px-3 py-2 w-full max-w-md"
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={regenerateBackupCodes}
                    disabled={!password || loading}
                    className="bg-royal text-white px-4 py-2 rounded hover:bg-navy disabled:bg-gray-300"
                  >
                    Regenerate Backup Codes
                  </button>

                  <button
                    onClick={disableMFA}
                    disabled={!password || loading}
                    className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 disabled:bg-gray-300"
                  >
                    Disable MFA
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-gray-600">
                Secure your account with two-factor authentication. You'll need your phone with an authenticator app.
              </p>

              <button
                onClick={startSetup}
                disabled={loading}
                className="bg-royal text-white px-6 py-3 rounded hover:bg-navy disabled:bg-gray-300"
              >
                Enable MFA
              </button>
            </div>
          )}
        </div>
      )}

      {/* Setup Step: QR Code */}
      {setupStep === 'verify' && qrCode && (
        <div className="bg-white p-6 rounded-lg shadow space-y-4">
          <h3 className="text-lg font-semibold">Step 1: Scan QR Code</h3>

          <p className="text-gray-600">
            Scan this QR code with your authenticator app (Google Authenticator, Authy, Microsoft Authenticator, etc.)
          </p>

          <div className="flex flex-col items-center gap-4 p-4 bg-gray-50 rounded">
            <img src={qrCode} alt="MFA QR Code" className="w-64 h-64" />

            <div className="text-center">
              <p className="text-sm text-gray-600 mb-2">Can't scan? Enter this code manually:</p>
              <div className="flex items-center gap-2 bg-white px-4 py-2 rounded border">
                <code className="text-sm font-mono">{secret}</code>
                <button onClick={() => copyToClipboard(secret ?? '')} className="text-royal hover:text-navy">
                  <Copy size={16} />
                </button>
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <h4 className="font-semibold mb-2">Step 2: Enter Verification Code</h4>
            <p className="text-sm text-gray-600 mb-3">Enter the 6-digit code from your authenticator app:</p>

            <div className="flex gap-2">
              <input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                maxLength={6}
                className="border rounded px-4 py-2 text-2xl font-mono tracking-wider w-48"
              />

              <button
                onClick={verifySetup}
                disabled={token.length !== 6 || loading}
                className="bg-royal text-white px-6 py-2 rounded hover:bg-navy disabled:bg-gray-300"
              >
                Verify & Enable
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Setup Complete: Backup Codes */}
      {setupStep === 'complete' && backupCodes.length > 0 && (
        <div className="bg-white p-6 rounded-lg shadow space-y-4">
          <div className="flex items-center gap-2 text-green-600">
            <CheckCircle />
            <h3 className="text-lg font-semibold">MFA Enabled Successfully!</h3>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 p-4 rounded">
            <p className="font-semibold text-yellow-800 mb-2 flex items-center gap-1.5">
              <AlertTriangle size={14} aria-hidden="true" /> Save Your Backup Codes
            </p>
            <p className="text-sm text-yellow-700">
              These backup codes can be used to access your account if you lose your authenticator device. Each code can
              only be used once. Store them in a secure location.
            </p>
          </div>

          <div className="border rounded p-4 bg-gray-50">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold">Your Backup Codes</h4>
              <button
                onClick={copyAllBackupCodes}
                className="text-royal hover:text-navy flex items-center gap-1 text-sm"
              >
                <Copy size={16} />
                Copy All
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {backupCodes.map((code, index) => (
                <div
                  key={index}
                  className="bg-white border rounded px-3 py-2 font-mono text-sm flex items-center justify-between"
                >
                  <span>{code}</span>
                  <button onClick={() => copyToClipboard(code)} className="text-gray-400 hover:text-royal">
                    <Copy size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={() => {
              setSetupStep(null);
              setBackupCodes([]);
              setQrCode(null);
              setSecret(null);
              setToken('');
            }}
            className="bg-royal text-white px-6 py-2 rounded hover:bg-navy"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
