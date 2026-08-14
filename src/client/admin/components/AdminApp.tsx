import { useState, useEffect, lazy, Suspense } from "react";
import { BarChart2, List, Download, Users, Activity, Settings, AlertCircle, Key, AlertTriangle, CheckSquare, FileText, Trash2, BookOpen, Clipboard, FilePlus, X } from "react-feather";
import AdminHeader from "./AdminHeader";
import ToastContainer from "../../shared/components/Toast";
import DemoSwitcher from "../../shared/components/DemoSwitcher";
import ErrorBoundary from "../../shared/components/ErrorBoundary";

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
const AdverseEvents = lazy(() => import("./AdverseEvents"));
const StudyOps = lazy(() => import("./StudyOps"));
const EvalsView = lazy(() => import("./EvalsView"));
const ParticipantProfile = lazy(() => import("./ParticipantProfile"));

// The subset of the users-table row the profile page needs up front.
export interface ProfileUserSummary {
  userid: number;
  username: string;
  role: string;
  preferred_voice?: string | null;
  preferred_language?: string | null;
  mfa_enabled?: boolean;
  memory_enabled?: boolean;
  risk_context_share_enabled?: boolean;
  created_at?: string | null;
}

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
  // Participant profile drill-down from the Users table (ai-therapist-110);
  // mirrors the selectedSessionId/SessionDetail pattern.
  const [selectedUser, setSelectedUser] = useState<ProfileUserSummary | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [isClient, setIsClient] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  // Deployment posture (migration 060): 'research' shows every study surface;
  // 'clinical' (therapist pilot) hides the research-only nav items. UI framing
  // only — server-side authorization is unchanged.
  const [deploymentMode, setDeploymentMode] = useState<'research' | 'clinical'>('research');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // Adverse-event deadline reminder: count of overdue + due-soon drafts, shown
  // as a red badge on the Adverse Events nav item (ai-therapist-95).
  const [aeReminderCount, setAeReminderCount] = useState(0);

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

  // Fetch the deployment mode once; anything but an explicit 'clinical' keeps
  // the research default (missing row, demo fixtures, fetch failure).
  useEffect(() => {
    fetch('/admin/api/config/deployment_mode', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data?.value?.mode === 'clinical') setDeploymentMode('clinical');
      })
      .catch(() => { /* keep research default */ });
  }, []);

  // Fetch AE deadline counts once on mount for the nav badge.
  useEffect(() => {
    fetch('/admin/api/adverse-events?status=draft', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data?.counts) setAeReminderCount((data.counts.overdue ?? 0) + (data.counts.due_soon ?? 0));
      })
      .catch(() => { /* nav badge is best-effort */ });
  }, []);

  const handleViewSession = (sessionId: string, editMode = false) => {
    setSelectedSessionId(sessionId);
    setIsEditMode(editMode);
  };

  const handleCloseSession = () => {
    setSelectedSessionId(null);
    setIsEditMode(false);
  };

  // Grouped navigation (ai-therapist-120). researchOnly marks study-specific
  // surfaces that are hidden when deployment_mode is 'clinical' (therapist
  // pilot framing). demoVisible opens a researcher-gated item to magic-link
  // demo accounts, whose entire admin API is served synthetic fixtures
  // (demo.routes.ts). MFA Security lives in the header account area, not here.
  type NavItem = { id: string; label: string; icon: typeof Activity; researcherOnly?: boolean; researchOnly?: boolean; demoVisible?: boolean };
  const navGroups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: 'Operations',
      items: [
        { id: 'live', label: 'Live Monitoring', icon: Activity },
        { id: 'sessions', label: 'Sessions', icon: List },
        // Historic id: 'dashboard' renders the Analytics view.
        { id: 'dashboard', label: 'Analytics', icon: BarChart2 },
      ],
    },
    {
      label: 'Safety',
      items: [
        { id: 'crisis', label: 'Crisis Management', icon: AlertTriangle },
        { id: 'adverse-events', label: 'Adverse Events', icon: FilePlus },
      ],
    },
    {
      label: 'People',
      items: [
        { id: 'users', label: 'Users', icon: Users, researcherOnly: true, demoVisible: true },
        { id: 'user-sessions', label: 'User Sessions', icon: Key, researcherOnly: true },
        { id: 'rate-limits', label: 'Rate Limits', icon: AlertCircle },
      ],
    },
    {
      label: 'Research',
      items: [
        { id: 'prompts', label: 'System Prompts', icon: FileText, researcherOnly: true },
        { id: 'knowledge', label: 'Knowledge Base', icon: BookOpen, researcherOnly: true },
        { id: 'evals', label: 'Evals', icon: CheckSquare, researcherOnly: true },
        { id: 'consent', label: 'Consent Versions', icon: Clipboard, researcherOnly: true, researchOnly: true },
        { id: 'study-ops', label: 'Study Ops', icon: Clipboard, researcherOnly: true, researchOnly: true },
        { id: 'export', label: 'Export', icon: Download, researchOnly: true },
      ],
    },
    {
      label: 'System',
      items: [
        { id: 'config', label: 'System Config', icon: Settings, researcherOnly: true },
        { id: 'retention', label: 'Data Retention', icon: Trash2, researcherOnly: true },
      ],
    },
  ];

  // Filter nav items based on user role and deployment posture; drop groups
  // left empty for this user.
  const visibleGroups = navGroups
    .map(group => ({
      ...group,
      items: group.items.filter(item => {
        if (item.researchOnly && deploymentMode === 'clinical') {
          return false;
        }
        if (item.researcherOnly) {
          return userRole === 'researcher' || (item.demoVisible === true && userRole === 'demo');
        }
        return true;
      }),
    }))
    .filter(group => group.items.length > 0);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <AdminHeader onMenuClick={() => setIsSidebarOpen(true)} onMfaClick={() => setCurrentView('mfa')} />
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
          <nav className="p-4 pt-0 md:pt-4 overflow-y-auto h-full">
            {visibleGroups.map(group => (
              <div key={group.label} className="mb-4">
                <p className="px-4 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {group.label}
                </p>
                <div className="space-y-1">
                  {group.items.map(item => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          setCurrentView(item.id);
                          setIsSidebarOpen(false);
                        }}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg transition ${
                          currentView === item.id
                            ? 'bg-royal text-white'
                            : 'text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        <Icon size={20} />
                        <span className="font-medium">{item.label}</span>
                        {item.id === 'adverse-events' && aeReminderCount > 0 && (
                          <span className="ml-auto bg-red-600 text-white rounded-full px-2 py-0.5 text-xs font-bold">
                            {aeReminderCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <div className="flex-1 overflow-auto">
          {isClient ? (
            <ErrorBoundary resetKey={currentView}>
            <Suspense fallback={<ViewLoading />}>
              {currentView === 'dashboard' && <Analytics />}
              {currentView === 'sessions' && <SessionList onViewSession={handleViewSession} />}
              {currentView === 'live' && <LiveMonitoring onViewSession={handleViewSession} />}
              {currentView === 'crisis' && <CrisisManagement />}
              {currentView === 'adverse-events' && <AdverseEvents />}
              {currentView === 'rate-limits' && <RateLimitedUsers />}
              {currentView === 'mfa' && <MFASetup />}
              {currentView === 'users' && <UserManagement onViewUser={setSelectedUser} />}
              {currentView === 'user-sessions' && <UserSessions />}
              {currentView === 'prompts' && <SystemPrompts />}
              {currentView === 'knowledge' && <KnowledgeBase />}
              {currentView === 'consent' && <ConsentVersions />}
              {currentView === 'study-ops' && <StudyOps />}
              {currentView === 'evals' && <EvalsView />}
              {currentView === 'retention' && <DataRetention />}
              {currentView === 'config' && <SystemConfig />}
              {currentView === 'export' && <ExportPanel />}
            </Suspense>
            </ErrorBoundary>
          ) : (
            <ViewLoading />
          )}
        </div>
      </main>

      {selectedUser && (
        <Suspense fallback={null}>
          <ParticipantProfile
            user={selectedUser}
            userRole={userRole}
            onClose={() => setSelectedUser(null)}
            onViewSession={(sessionId) => handleViewSession(sessionId)}
          />
        </Suspense>
      )}

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
