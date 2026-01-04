import { useState, useEffect } from "react";
import { BarChart2, List, Download, Users, Activity, Settings, AlertCircle } from "react-feather";
import AdminHeader from "./AdminHeader";
import SessionList from "./SessionList";
import SessionDetail from "./SessionDetail";
import Analytics from "./Analytics";
import ExportPanel from "./ExportPanel";
import UserManagement from "./UserManagement";
import LiveMonitoring from "./LiveMonitoring";
import SystemConfig from "./SystemConfig";
import RateLimitedUsers from "./RateLimitedUsers";

export default function AdminApp() {
  const [currentView, setCurrentView] = useState('sessions');
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [isClient, setIsClient] = useState(false);
  const [userRole, setUserRole] = useState(null);

  // Handle SSR - only render interactive parts on client
  if (typeof window !== 'undefined' && !isClient) {
    setIsClient(true);
  }

  // Fetch user role to determine navigation items
  useEffect(() => {
    const fetchUserRole = async () => {
      try {
        const response = await fetch('/api/auth/status');
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.user) {
            setUserRole(data.user.role);
          }
        }
      } catch (error) {
        console.error('Failed to fetch user role:', error);
      }
    };

    fetchUserRole();
  }, []);

  const handleViewSession = (sessionId, editMode = false) => {
    setSelectedSessionId(sessionId);
    setIsEditMode(editMode);
  };

  const handleCloseSession = () => {
    setSelectedSessionId(null);
    setIsEditMode(false);
  };

  // Base navigation items
  const allNavItems = [
    { id: 'live', label: 'Live Monitoring', icon: Activity },
    { id: 'dashboard', label: 'Dashboard', icon: BarChart2 },
    { id: 'sessions', label: 'Sessions', icon: List },
    { id: 'rate-limits', label: 'Rate Limits', icon: AlertCircle },
    { id: 'users', label: 'Users', icon: Users, researcherOnly: true },
    { id: 'config', label: 'System Config', icon: Settings, researcherOnly: true },
    { id: 'export', label: 'Export', icon: Download },

  ];

  // Filter nav items based on user role
  const navItems = allNavItems.filter(item => {
    if (item.researcherOnly) {
      return userRole === 'researcher';
    }
    return true;
  });

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <AdminHeader />

      <main className="flex-1 overflow-hidden flex">
        <aside className="w-64 bg-white border-r shadow-sm">
          <nav className="p-4 space-y-2">
            {navItems.map(item => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => setCurrentView(item.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition ${
                    currentView === item.id
                      ? 'bg-byuRoyal text-white'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <Icon size={20} />
                  <span className="font-medium">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex-1 overflow-auto">
          {currentView === 'dashboard' && <Analytics />}
          {currentView === 'sessions' && <SessionList onViewSession={handleViewSession} />}
          {currentView === 'live' && <LiveMonitoring onViewSession={handleViewSession} />}
          {currentView === 'rate-limits' && <RateLimitedUsers />}
          {currentView === 'users' && <UserManagement />}
          {currentView === 'config' && <SystemConfig />}
          {currentView === 'export' && <ExportPanel />}

        </div>
      </main>

      {selectedSessionId && (
        <SessionDetail
          sessionId={selectedSessionId}
          onClose={handleCloseSession}
          isEditMode={isEditMode}
        />
      )}
    </div>
  );
}
