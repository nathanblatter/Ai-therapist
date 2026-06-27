import { useState, useEffect } from 'react';
import { Menu } from 'react-feather';

interface AdminHeaderProps {
  onMenuClick?: () => void;
}

export default function AdminHeader({ onMenuClick }: AdminHeaderProps) {
  const [username, setUsername] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    const fetchAuthStatus = async () => {
      try {
        const response = await fetch('/api/auth/status');
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.user) {
            setUsername(data.user.username);
            setUserRole(data.user.role);
          }
        }
      } catch (error) {
        console.error('Failed to fetch auth status:', error);
      }
    };

    fetchAuthStatus();
  }, []);

  const handleLogout = async () => {
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
      });

      if (response.ok) {
        window.location.href = '/login';
      }
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const capitalizeFirst = (str: string | null) => {
    if (!str || typeof str !== "string") return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  };

  return (
    <header className="bg-navy text-white p-4 md:p-6">
      <div className="flex justify-between items-center gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {onMenuClick && (
            <button
              onClick={onMenuClick}
              className="md:hidden p-2 -ml-2 shrink-0 text-white hover:bg-white/10 rounded-lg"
              aria-label="Open navigation menu"
            >
              <Menu size={24} />
            </button>
          )}
          <div className="min-w-0">
            <h1 className="text-lg sm:text-2xl md:text-4xl font-bold leading-tight">AI Therapist Research & Therapist Audit Portal</h1>
            {username && (
              <p className="text-lightBlue mt-1 md:mt-2 text-sm md:text-lg truncate">
                Welcome, {capitalizeFirst(username)} {userRole && <span className="text-xs md:text-sm">({userRole})</span>}
              </p>
            )}
          </div>
        </div>
        <button onClick={handleLogout} className="bg-gray-700 hover:bg-gray-600 px-3 md:px-4 py-2 rounded-full text-sm font-semibold shrink-0 text-center" title="Logout">Logout</button>
      </div>
    </header>
  );
}
