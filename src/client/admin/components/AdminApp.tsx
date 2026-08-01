import { useState, useEffect, lazy, Suspense } from "react";
import { BarChart2, List, Download, Users, Activity, Settings, AlertCircle, Key, AlertTriangle, Shield, FileText, Trash2, BookOpen, Clipboard, X } from "react-feather";
import AdminHeader from "./AdminHeader";
import ToastContainer from "../../shared/components/Toast";
import DemoSwitcher from "../../shared/components/DemoSwitcher";

// Heavy, independently-navigable views are code-split so the initial admin
// bundle stays small. They're rendered client-only (see isClient gate below),
// which keeps SSR (renderToString, no Suspense streaming) safe.
const SessionList = lazy(() => import("./SessionList"));
const SessionDetail = lazy(() => import("./SessionDetail"));
const Analytics = lazy(() => import("./Analytics"));
const ExportPanel = lazy(() => import("./ExportPanel"));
const UserManagement = lazy(() => import("./UserManagement"));
const LiveMonitoring = lazy(() => import("./LiveMonitoring"));
const SystemConfig = lazy(() => import("./SystemConfig"));
const SystemPrompts = lazy(() => import("./SystemPrompts"));
const RateLimitedUsers = lazy(() => import("./RateLimitedUsers"));
const UserSessions = lazy(() => import("./UserSessions"));
const CrisisManagement = lazy(() => import("./CrisisManagement"));
const MFASetup = lazy(() => import("./MFASetup"));
const DataRetention = lazy(() => import("./DataRetention"));
const KnowledgeBase = lazy(() => import("./KnowledgeBase"));
const ConsentVersions = lazy(() => import("./ConsentVersions"));

function ViewLoading() {
  return (
    <div className="flex items-center justify-center h-full p-8 text-gray-500" role="status" aria-live="polite">
      Loading…
    </div>
  );
}

export default function AdminApp() {
  const [currentView, setCurrentView] = useState('sessions');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [isClient, setIsClient] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Handle SSR - only render interactive parts on client
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Fetch user role to determine navigation items
  useEffect(() => {
    const fetchUserRole = async () => {
      try {
        const response = await fetch('/api/auth/status', {
          credentials: 'include'
        });
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

  const handleViewSession = (sessionId: string, editMode = false) => {
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
    { id: 'crisis', label: 'Crisis Management', icon: AlertTriangle },
    { id: 'rate-limits', label: 'Rate Limits', icon: AlertCircle },
    { id: 'mfa', label: 'MFA Security', icon: Shield },
    { id: 'users', label: 'Users', icon: Users, researcherOnly: true },
    { id: 'user-sessions', label: 'User Sessions', icon: Key, researcherOnly: true },
    { id: 'prompts', label: 'System Prompts', icon: FileText, researcherOnly: true },
    { id: 'knowledge', label: 'Knowledge Base', icon: BookOpen, researcherOnly: true },
    { id: 'consent', label: 'Consent Versions', icon: Clipboard, researcherOnly: true },
    { id: 'retention', label: 'Data Retention', icon: Trash2, researcherOnly: true },
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
      <AdminHeader onMenuClick={() => setIsSidebarOpen(true)} />
      <DemoSwitcher context="admin" role={userRole} />

      <main className="flex-1 overflow-hidden flex relative">
        {/* Mobile overlay backdrop */}
        {isSidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            onClick={() => setIsSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        <aside
          className={`fixed inset-y-0 left-0 z-40 w-64 bg-white border-r shadow-sm transform transition-transform duration-200 ease-in-out md:static md:z-auto md:translate-x-0 ${
            isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between p-4 md:hidden">
            <span className="font-semibold text-gray-700">Menu</span>
            <button
              onClick={() => setIsSidebarOpen(false)}
              className="p-2 -mr-2 text-gray-500 hover:text-gray-800"
              aria-label="Close menu"
            >
              <X size={20} />
            </button>
          </div>
          <nav className="p-4 pt-0 md:pt-4 space-y-2 overflow-y-auto h-full">
            {navItems.map(item => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setCurrentView(item.id);
                    setIsSidebarOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition ${
                    currentView === item.id
                      ? 'bg-royal text-white'
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
          {isClient ? (
            <Suspense fallback={<ViewLoading />}>
              {currentView === 'dashboard' && <Analytics />}
              {currentView === 'sessions' && <SessionList onViewSession={handleViewSession} />}
              {currentView === 'live' && <LiveMonitoring onViewSession={handleViewSession} />}
              {currentView === 'crisis' && <CrisisManagement />}
              {currentView === 'rate-limits' && <RateLimitedUsers />}
              {currentView === 'mfa' && <MFASetup />}
              {currentView === 'users' && <UserManagement />}
              {currentView === 'user-sessions' && <UserSessions />}
              {currentView === 'prompts' && <SystemPrompts />}
              {currentView === 'knowledge' && <KnowledgeBase />}
              {currentView === 'consent' && <ConsentVersions />}
              {currentView === 'retention' && <DataRetention />}
              {currentView === 'config' && <SystemConfig />}
              {currentView === 'export' && <ExportPanel />}
            </Suspense>
          ) : (
            <ViewLoading />
          )}
        </div>
      </main>

      {selectedSessionId && (
        <Suspense fallback={null}>
          <SessionDetail
            sessionId={selectedSessionId}
            onClose={handleCloseSession}
            isEditMode={isEditMode}
          />
        </Suspense>
      )}

      {/* Toast Notifications */}
      <ToastContainer />
    </div>
  );
}
