import { useState, useEffect } from 'react';
import { Shield, Key, Copy, CheckCircle } from 'react-feather';

export default function MFASetup() {
  const [mfaStatus, setMfaStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [setupStep, setSetupStep] = useState(null); // 'init', 'verify', 'complete'
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState(null);
  const [token, setToken] = useState('');
  const [backupCodes, setBackupCodes] = useState([]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  // Fetch MFA status on load
  useEffect(() => {
    fetchMFAStatus();
  }, []);

  const fetchMFAStatus = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/mfa/status', {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to fetch MFA status');

      const data = await response.json();
      setMfaStatus(data.mfa);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const startSetup = async () => {
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/mfa/setup/init', {
        method: 'POST',
        credentials: 'include'
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to initialize MFA setup');
      }

      const data = await response.json();
      setQrCode(data.qrCode);
      setSecret(data.secret);
      setSetupStep('verify');
    } catch (err) {
      setError(err.message);
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
      const response = await fetch('/api/mfa/setup/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to verify token');
      }

      const data = await response.json();
      setBackupCodes(data.backupCodes);
      setSetupStep('complete');
      setSuccessMessage('MFA enabled successfully!');

      // Refresh status after short delay
      setTimeout(fetchMFAStatus, 1000);
    } catch (err) {
      setError(err.message);
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
      const response = await fetch('/api/mfa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to disable MFA');
      }

      setSuccessMessage('MFA disabled successfully');
      setPassword('');
      fetchMFAStatus();
    } catch (err) {
      setError(err.message);
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
      const response = await fetch('/api/mfa/regenerate-backup-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to regenerate backup codes');
      }

      const data = await response.json();
      setBackupCodes(data.backupCodes);
      setSetupStep('complete');
      setSuccessMessage('Backup codes regenerated successfully!');
      setPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text) => {
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
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Shield className="text-byuRoyal" />
          Multi-Factor Authentication (MFA)
        </h2>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

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
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${
              mfaStatus.enabled
                ? 'bg-green-100 text-green-800'
                : 'bg-yellow-100 text-yellow-800'
            }`}>
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
                    className="bg-byuRoyal text-white px-4 py-2 rounded hover:bg-byuNavy disabled:bg-gray-300"
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
                className="bg-byuRoyal text-white px-6 py-3 rounded hover:bg-byuNavy disabled:bg-gray-300"
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
                <button
                  onClick={() => copyToClipboard(secret)}
                  className="text-byuRoyal hover:text-byuNavy"
                >
                  <Copy size={16} />
                </button>
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <h4 className="font-semibold mb-2">Step 2: Enter Verification Code</h4>
            <p className="text-sm text-gray-600 mb-3">
              Enter the 6-digit code from your authenticator app:
            </p>

            <div className="flex gap-2">
              <input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                maxLength="6"
                className="border rounded px-4 py-2 text-2xl font-mono tracking-wider w-48"
              />

              <button
                onClick={verifySetup}
                disabled={token.length !== 6 || loading}
                className="bg-byuRoyal text-white px-6 py-2 rounded hover:bg-byuNavy disabled:bg-gray-300"
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
            <p className="font-semibold text-yellow-800 mb-2">⚠️ Save Your Backup Codes</p>
            <p className="text-sm text-yellow-700">
              These backup codes can be used to access your account if you lose your authenticator device.
              Each code can only be used once. Store them in a secure location.
            </p>
          </div>

          <div className="border rounded p-4 bg-gray-50">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold">Your Backup Codes</h4>
              <button
                onClick={copyAllBackupCodes}
                className="text-byuRoyal hover:text-byuNavy flex items-center gap-1 text-sm"
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
                  <button
                    onClick={() => copyToClipboard(code)}
                    className="text-gray-400 hover:text-byuRoyal"
                  >
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
            className="bg-byuRoyal text-white px-6 py-2 rounded hover:bg-byuNavy"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
