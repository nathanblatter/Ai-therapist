import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

export default function ProtectedRoute({ children }) {
  const [authStatus, setAuthStatus] = useState('loading');
  const [isClient, setIsClient] = useState(false);
  const location = useLocation();

  // Detect if we're on the client
  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (isClient) {
      checkAuthStatus();
    }
  }, [isClient]);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch('/api/auth/status');
      const data = await response.json();

      if (data.authenticated) {
        setAuthStatus('authenticated');
      } else {
        setAuthStatus('unauthenticated');
      }
    } catch (err) {
      console.error('Auth check failed:', err);
      setAuthStatus('unauthenticated');
    }
  };

  // During SSR or initial client render, show loading
  if (!isClient || authStatus === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  // Only navigate on the client after auth check is complete
  if (authStatus === 'unauthenticated') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}
