import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Key } from 'react-feather';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [userId, setUserId] = useState(null);
  const [mfaToken, setMfaToken] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      // Debug logging
      console.log('Login response:', data);
      console.log('MFA required?', data.mfaRequired);
      console.log('Success?', data.success);

      // Check if MFA is required
      if (data.mfaRequired) {
        console.log('Setting MFA required to true');
        setMfaRequired(true);
        setUserId(data.userId);
        setLoading(false);
        return;
      }

      if (response.ok && data.success) {
        // Use full page navigation to ensure proper SSR hydration with authenticated session
        window.location.href = '/';
      } else {
        setError(data.error || 'Login failed');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleMFASubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const body = { username, password };

      if (useBackupCode) {
        body.backupCode = backupCode.trim().toUpperCase();
      } else {
        body.mfaToken = mfaToken.trim();
      }

      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Use full page navigation to ensure proper SSR hydration with authenticated session
        window.location.href = '/';
      } else {
        setError(data.error || 'Invalid verification code');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-byuNavy to-byuRoyal">
      <div className="max-w-md w-full mx-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 space-y-8">
          <div className="text-center">
            <h1 className="text-4xl font-bold text-byuNavy mb-2">
              AI Therapist Assistant
            </h1>
            <p className="text-lg text-gray-600">
              {mfaRequired ? 'Two-Factor Authentication' : 'Sign in to start your session'}
            </p>
          </div>

          {!mfaRequired ? (
            // Initial login form
            <form className="space-y-6" onSubmit={handleSubmit}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">
                    Username
                  </label>
                  <input
                    id="username"
                    name="username"
                    type="text"
                    required
                    className="appearance-none relative block w-full px-4 py-3 border border-gray-300 placeholder-gray-400 text-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal focus:border-transparent transition-all sm:text-sm"
                    placeholder="Enter your username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={loading}
                  />
                </div>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                    Password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    required
                    className="appearance-none relative block w-full px-4 py-3 border border-gray-300 placeholder-gray-400 text-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal focus:border-transparent transition-all sm:text-sm"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                  />
                </div>
              </div>

              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-4">
                  <p className="text-sm text-red-800 font-medium">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="group relative w-full flex justify-center py-3 px-4 border border-transparent text-base font-semibold rounded-lg text-white bg-byuRoyal hover:bg-byuNavy focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-byuRoyal transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
              >
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          ) : (
            // MFA verification form
            <div className="space-y-6">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
                <Shield className="text-byuRoyal flex-shrink-0 mt-0.5" size={20} />
                <div>
                  <p className="text-sm text-blue-900 font-medium">
                    Two-factor authentication is enabled
                  </p>
                  <p className="text-xs text-blue-700 mt-1">
                    Enter the verification code from your authenticator app
                  </p>
                </div>
              </div>

              <form className="space-y-4" onSubmit={handleMFASubmit}>
                {!useBackupCode ? (
                  <div>
                    <label htmlFor="mfaToken" className="block text-sm font-medium text-gray-700 mb-1">
                      Authentication Code
                    </label>
                    <input
                      id="mfaToken"
                      name="mfaToken"
                      type="text"
                      required
                      maxLength="6"
                      className="appearance-none relative block w-full px-4 py-3 border border-gray-300 placeholder-gray-400 text-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal focus:border-transparent transition-all text-center text-2xl font-mono tracking-widest"
                      placeholder="000000"
                      value={mfaToken}
                      onChange={(e) => setMfaToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      disabled={loading}
                      autoFocus
                    />
                  </div>
                ) : (
                  <div>
                    <label htmlFor="backupCode" className="block text-sm font-medium text-gray-700 mb-1">
                      Backup Code
                    </label>
                    <input
                      id="backupCode"
                      name="backupCode"
                      type="text"
                      required
                      maxLength="8"
                      className="appearance-none relative block w-full px-4 py-3 border border-gray-300 placeholder-gray-400 text-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-byuRoyal focus:border-transparent transition-all text-center text-xl font-mono tracking-wider uppercase"
                      placeholder="A1B2C3D4"
                      value={backupCode}
                      onChange={(e) => setBackupCode(e.target.value.toUpperCase().slice(0, 8))}
                      disabled={loading}
                      autoFocus
                    />
                  </div>
                )}

                {error && (
                  <div className="rounded-lg bg-red-50 border border-red-200 p-4">
                    <p className="text-sm text-red-800 font-medium">{error}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || (!useBackupCode && mfaToken.length !== 6) || (useBackupCode && backupCode.length !== 8)}
                  className="group relative w-full flex justify-center py-3 px-4 border border-transparent text-base font-semibold rounded-lg text-white bg-byuRoyal hover:bg-byuNavy focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-byuRoyal transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                >
                  {loading ? 'Verifying...' : 'Verify & Sign In'}
                </button>

                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setUseBackupCode(!useBackupCode);
                      setMfaToken('');
                      setBackupCode('');
                      setError('');
                    }}
                    className="text-sm text-byuRoyal hover:text-byuNavy font-medium flex items-center justify-center gap-1"
                  >
                    <Key size={14} />
                    {useBackupCode ? 'Use authenticator code instead' : 'Use backup code instead'}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setMfaRequired(false);
                      setMfaToken('');
                      setBackupCode('');
                      setUseBackupCode(false);
                      setError('');
                    }}
                    className="text-sm text-gray-600 hover:text-gray-800"
                  >
                    ← Back to login
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="text-center pt-4 border-t border-gray-200">
            <p className="text-sm text-gray-500">
              If you experience emotional distress or crisis, please contact{' '}
              <a href="tel:8014223035" className="text-byuRoyal hover:underline font-medium">
                <br/>BYU CAPS: (801) 422-3035
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
