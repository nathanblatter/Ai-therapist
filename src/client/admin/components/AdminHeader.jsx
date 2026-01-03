import { useState, useEffect } from 'react';

export default function AdminHeader() {
  const [username, setUsername] = useState(null);
  const [userRole, setUserRole] = useState(null);

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

  const capitalizeFirst = (str) => {
    if (!str || typeof str !== "string") return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  };

  return (
    <header className="bg-byuNavy text-white p-4 md:p-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold">AI Therapist Research & Therapist Audit Portal</h1>
          {username && (
            <p className="text-byuLightBlue mt-2 text-lg">
              Welcome, {capitalizeFirst(username)} {userRole && <span className="text-sm">({userRole})</span>}
            </p>
          )}
        </div>
        <button onClick={handleLogout} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-full text-sm font-semibold w-full sm:w-auto text-center" title="Logout">Logout</button>
      </div>
    </header>
  );
}
