// Header.jsx
import React from 'react';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import CopyButton from '../../shared/components/CopyButton';


const Header = ({ sessionId, timeRemaining }) => {
  const [username, setUsername] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const navigate = useNavigate();
  function capitalizeFirst(str) {
  if (!str || typeof str !== "string") return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

  // Format time remaining as MM:SS
  const formatTimeRemaining = (ms) => {
    if (ms === null || ms === undefined) return null;
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Determine timer color based on time remaining
  const getTimerColor = (ms) => {
    if (ms === null || ms === undefined) return '';
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds <= 60) return 'text-red-400 font-bold'; // Last minute - red
    if (totalSeconds <= 300) return 'text-yellow-300 font-bold'; // Last 5 minutes - yellow
    return 'text-green-300'; // More than 5 minutes - green
  };


  useEffect(() => {
    // Fetch auth status to get username and role
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
        navigate('/login');
      }
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  return (
    <header className="bg-byuNavy text-white p-4 md:p-6 font-sans" role="banner">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl md:text-5xl font-bold text-center">AI Therapist Assistant</h1>
        {username && (
          <p className="text-center text-lg text-byuLightBlue mt-2" aria-label={`Logged in as ${username}`}>
            Welcome, {capitalizeFirst(username)}
          </p>
        )}
         {/* Show Session ID if it exists */}
         {sessionId && (
          <p className="text-center text-lg text-gray-300 mt-1 flex justify-center items-center gap-2" role="status" aria-label="Active session">
          <span>Session ID:</span>
          <code className="bg-byuRoyal px-2 py-1 rounded font-bold text-white" title="Session ID (Copy this value into the form)" aria-label={`Session ID: ${sessionId}`}>{sessionId}</code>
          <CopyButton textToCopy={sessionId} />
        </p>

        )}

        {/* Show Session Timer if active */}
        {timeRemaining !== null && (
          <div className="text-center mt-2" role="timer" aria-label="Session time remaining">
            <p className={`text-2xl font-mono ${getTimerColor(timeRemaining)}`} aria-live="polite">
              Time Remaining: {formatTimeRemaining(timeRemaining)}
            </p>
            {timeRemaining <= 60000 && (
              <p className="text-red-300 text-sm mt-1 animate-pulse" role="alert" aria-live="assertive">
                Your session will end soon!
              </p>
            )}
          </div>
        )}
        <p className="mt-2 text-sm md:text-base leading-relaxed">
          If you experience emotional distress, crisis, or worsening mental health symptoms at any point during your session please reach out immediately to BYU's Counseling and Psychological Services crisis line at 
          <a href="tel:8014223035" className="text-blue-300 underline ml-1" title="BYU Counseling and Psychological Services Crisis Line">(801) 422-3035</a> or visit 
          <a href="https://caps.byu.edu" target="_blank" rel="noopener noreferrer" className="text-blue-300 underline ml-1" title="BYU Counseling and Psychological services Website">caps.byu.edu</a> for support. You are not alone—help is available.
        </p>
        <nav className="mt-4 flex flex-col sm:flex-row items-center gap-2 sm:gap-4 justify-center" role="navigation" aria-label="Main navigation">
          <a
            href="tel:8014223035"
            className="bg-byuRoyal hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold w-full sm:w-auto text-center min-h-[44px] flex items-center justify-center"
            aria-label="Call BYU Counseling and Psychological Services at 801-422-3035"
          >
            Call CAPS
          </a>
          <a
            href="https://caps.byu.edu/for-students-in-crisis"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-byuRoyal hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold w-full sm:w-auto text-center min-h-[44px] flex items-center justify-center"
            aria-label="Visit BYU Crisis Resources page (opens in new tab)"
          >
            Crisis Resources
          </a>

          {(userRole === 'researcher' || userRole === 'therapist') && (
            <a
              href="/admin/"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-byuRoyal hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold w-full sm:w-auto text-center min-h-[44px] flex items-center justify-center"
              aria-label="Open Admin Portal (opens in new tab)"
            >
              Admin Portal
            </a>
          )}
          <button
            onClick={() => navigate('/profile')}
            className="bg-byuRoyal hover:bg-blue-700 px-4 py-2 rounded-full text-sm font-semibold w-full sm:w-auto text-center min-h-[44px] flex items-center justify-center"
            aria-label="View my profile"
          >
            Profile
          </button>
          <button onClick={handleLogout} className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold w-full sm:w-auto text-center" title="Logout">Logout</button>
        </nav>
        
      </div>
    </header>
  );
};

export default Header;