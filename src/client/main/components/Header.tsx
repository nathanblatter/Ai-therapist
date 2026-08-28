// Header.jsx
import React from 'react';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, X, ChevronUp, ChevronDown, MessageSquare } from 'react-feather';
import CopyButton from '../../shared/components/CopyButton';

interface HeaderProps {
  sessionId: string | null;
  timeRemaining: number | null;
  /** Toggle the async-messaging view (present only for logged-in users
   *  between sessions — caseworker portal). */
  onOpenMessages?: () => void;
  messagesOpen?: boolean;
  messagesUnread?: number;
}

// localStorage key for the header collapse preference (persists across sessions).
const HEADER_COLLAPSED_KEY = 'aithx.headerCollapsed';

const Header = ({ sessionId, timeRemaining, onOpenMessages, messagesOpen = false, messagesUnread = 0 }: HeaderProps) => {
  const [username, setUsername] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // Collapsed state. Start expanded so SSR and first client render agree, then
  // hydrate the persisted preference from localStorage in an effect (below).
  const [isCollapsed, setIsCollapsed] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  // Load the persisted collapse preference on mount (client-only).
  useEffect(() => {
    try {
      if (localStorage.getItem(HEADER_COLLAPSED_KEY) === 'true') {
        setIsCollapsed(true);
      }
    } catch {
      // localStorage unavailable (private mode / SSR) — keep the default.
    }
  }, []);

  const toggleCollapsed = () => {
    setIsCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem(HEADER_COLLAPSED_KEY, next ? 'true' : 'false');
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  };

  // Close the mobile menu when tapping outside it or pressing Escape
  useEffect(() => {
    if (!isMenuOpen) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isMenuOpen]);
  function capitalizeFirst(str: string | null): string | null {
  if (!str || typeof str !== "string") return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

  // Format time remaining as MM:SS
  const formatTimeRemaining = (ms: number | null): string | null => {
    if (ms === null || ms === undefined) return null;
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Determine timer color based on time remaining
  const getTimerColor = (ms: number | null): string => {
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
    <header
      className={`bg-navy text-white font-sans transition-all duration-200 ${
        isCollapsed ? 'py-1.5 px-3' : 'p-3 md:p-6 [@media(max-height:500px)]:py-1.5'
      }`}
      role="banner"
    >
      <div className="max-w-5xl mx-auto relative">
        {/* Collapse / expand toggle — grab this to shrink the header to a slim bar.
            The choice is persisted to localStorage so it sticks across sessions. */}
        <button
          onClick={toggleCollapsed}
          className="absolute right-0 top-0 bg-royal hover:bg-blue-700 rounded-full p-1.5 min-h-[36px] min-w-[36px] flex items-center justify-center z-10"
          aria-label={isCollapsed ? 'Expand header' : 'Collapse header'}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? 'Expand header' : 'Collapse header'}
        >
          {isCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>

        {isCollapsed ? (
          /* Slim collapsed bar: title + live timer + Call 988 stay reachable. */
          <div className="flex items-center gap-3 pr-10">
            <h1 className="text-base font-bold whitespace-nowrap">AI Therapist Assistant</h1>
            {timeRemaining !== null && (
              <span
                className={`text-sm font-mono ${getTimerColor(timeRemaining)}`}
                role="timer"
                aria-live="polite"
                aria-label="Session time remaining"
              >
                {formatTimeRemaining(timeRemaining)}
              </span>
            )}
            <a
              href="tel:988"
              className="ml-auto bg-royal hover:bg-red-700 px-3 py-1 rounded-full text-xs font-semibold flex items-center justify-center min-h-[36px]"
              aria-label="Call the 988 Suicide & Crisis Lifeline at 988"
            >
              Call 988
            </a>
          </div>
        ) : (
        <>
        <h1 className="text-2xl md:text-5xl [@media(max-height:500px)]:text-base font-bold text-center">AI Therapist Assistant</h1>
        {username && (
          <p className="text-center text-lg text-lightBlue mt-2 [@media(max-height:500px)]:hidden" aria-label={`Logged in as ${username}`}>
            Welcome, {capitalizeFirst(username)}
          </p>
        )}
         {/* Show Session ID if it exists */}
         {sessionId && (
          <p className="text-center text-lg text-gray-300 mt-1 flex justify-center items-center gap-2" role="status" aria-label="Active session">
          <span>Session ID:</span>
          <code className="bg-royal px-2 py-1 rounded font-bold text-white" title="Session ID (Copy this value into the form)" aria-label={`Session ID: ${sessionId}`}>{sessionId}</code>
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
        <p className="mt-2 text-xs sm:text-sm md:text-base leading-relaxed [@media(max-height:500px)]:hidden">
          If you experience emotional distress, crisis, or worsening mental health symptoms at any point during your session please reach out immediately to the 988 Suicide & Crisis Lifeline at
          <a href="tel:988" className="text-blue-300 underline ml-1" title="988 Suicide & Crisis Lifeline">988</a> or visit
          <a href="https://988lifeline.org" target="_blank" rel="noopener noreferrer" className="text-blue-300 underline ml-1" title="988 Suicide & Crisis Lifeline website">988lifeline.org</a> for support. You are not alone—help is available.
        </p>
        <nav className="mt-3 md:mt-4 [@media(max-height:500px)]:mt-1.5 flex flex-row items-center gap-2 sm:gap-4 justify-center" role="navigation" aria-label="Main navigation">
          {/* Call 988 stays visible at every size — never behind a menu */}
          <a
            href="tel:988"
            className="bg-royal hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold text-center min-h-[44px] flex items-center justify-center"
            aria-label="Call the 988 Suicide & Crisis Lifeline at 988"
          >
            Call 988
          </a>

          {/* Full button row on sm+ screens */}
          <div className="hidden sm:flex flex-row flex-wrap items-center gap-2 sm:gap-4 justify-center">
            <a
              href="https://988lifeline.org"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-royal hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold text-center min-h-[44px] flex items-center justify-center"
              aria-label="Visit crisis resources page (opens in new tab)"
            >
              Crisis Resources
            </a>

            {(userRole === 'researcher' || userRole === 'therapist') && (
              <a
                href="/admin/"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-royal hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold text-center min-h-[44px] flex items-center justify-center"
                aria-label="Open Admin Portal (opens in new tab)"
              >
                Admin Portal
              </a>
            )}
            {onOpenMessages && (
              <button
                onClick={onOpenMessages}
                className="relative bg-royal hover:bg-blue-700 px-4 py-2 rounded-full text-sm font-semibold text-center min-h-[44px] flex items-center justify-center gap-1.5"
                aria-label={messagesOpen ? 'Back to home' : `Open messages${messagesUnread > 0 ? `, ${messagesUnread} unread` : ''}`}
              >
                <MessageSquare size={16} aria-hidden="true" />
                {messagesOpen ? 'Home' : 'Messages'}
                {!messagesOpen && messagesUnread > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                    {messagesUnread > 99 ? '99+' : messagesUnread}
                  </span>
                )}
              </button>
            )}
            <button
              onClick={() => navigate('/profile')}
              className="bg-royal hover:bg-blue-700 px-4 py-2 rounded-full text-sm font-semibold text-center min-h-[44px] flex items-center justify-center"
              aria-label="View my profile"
            >
              Profile
            </button>
            <button onClick={handleLogout} className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-full text-sm font-semibold text-center min-h-[44px] flex items-center justify-center" title="Logout">Logout</button>
          </div>

          {/* Compact menu on mobile */}
          <div className="relative sm:hidden" ref={menuRef}>
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="bg-royal hover:bg-blue-700 px-4 py-2 rounded-full text-sm font-semibold min-h-[44px] min-w-[44px] flex items-center justify-center gap-2"
              aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={isMenuOpen}
              aria-haspopup="true"
            >
              {isMenuOpen ? <X size={18} /> : <Menu size={18} />}
              <span>Menu</span>
            </button>
            {isMenuOpen && (
              <div className="absolute right-0 mt-2 w-52 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-50 text-left" role="menu">
                <a
                  href="https://988lifeline.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-100"
                  role="menuitem"
                  onClick={() => setIsMenuOpen(false)}
                >
                  Crisis Resources
                </a>
                {(userRole === 'researcher' || userRole === 'therapist') && (
                  <a
                    href="/admin/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-100"
                    role="menuitem"
                    onClick={() => setIsMenuOpen(false)}
                  >
                    Admin Portal
                  </a>
                )}
                {onOpenMessages && (
                  <button
                    onClick={() => { setIsMenuOpen(false); onOpenMessages(); }}
                    className="block w-full text-left px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-100"
                    role="menuitem"
                  >
                    {messagesOpen ? 'Home' : `Messages${messagesUnread > 0 ? ` (${messagesUnread})` : ''}`}
                  </button>
                )}
                <button
                  onClick={() => { setIsMenuOpen(false); navigate('/profile'); }}
                  className="block w-full text-left px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-100"
                  role="menuitem"
                >
                  Profile
                </button>
                <button
                  onClick={() => { setIsMenuOpen(false); handleLogout(); }}
                  className="block w-full text-left px-4 py-3 text-sm font-medium text-red-600 hover:bg-red-50"
                  role="menuitem"
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </nav>
        </>
        )}
      </div>
    </header>
  );
};

export default Header;