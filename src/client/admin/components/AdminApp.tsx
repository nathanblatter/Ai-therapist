import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { BarChart2, List, Download, Users, Activity, Settings, AlertCircle, Key, AlertTriangle, CheckSquare, FileText, Trash2, BookOpen, Clipboard, FilePlus, X, EyeOff, UserCheck, Target, Inbox, ArrowUpCircle, MessageSquare, Box, Info, RefreshCw } from "react-feather";
import AdminHeader from "./AdminHeader";
import SandboxBanner from "./SandboxBanner";
import useAuth from "../hooks/useAuth";
import ToastContainer from "../../shared/components/Toast";
import DemoSwitcher from "../../shared/components/DemoSwitcher";
import ErrorBoundary from "../../shared/components/ErrorBoundary";

// Heavy, independently-navigable views are code-split so the initial admin
// bundle stays small.
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
const RedactionReview = lazy(() => import("./RedactionReview"));
const CaseloadView = lazy(() => import("./CaseloadView"));
const CaseworkerDashboard = lazy(() => import("./CaseworkerDashboard"));
const WorkQueue = lazy(() => import("./WorkQueue"));
const NotificationPreferences = lazy(() => import("./NotificationPreferences"));
const EscalationInbox = lazy(() => import("./escalations/EscalationInbox"));
const MessagingInbox = lazy(() => import("./MessagingInbox"));
const SandboxInvites = lazy(() => import("./SandboxInvites"));
const QualtricsSync = lazy(() => import("./QualtricsSync"));
const SurveyData = lazy(() => import("./SurveyData"));

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

// Role-dependent landing view (caseworker portal): caseworker lands on
// triage, therapist on caseload, everyone else on sessions.
function landingViewFor(role: string | null): string {
  if (role === 'caseworker') return 'triage';
  if (role === 'therapist') return 'caseload';
  return 'sessions';
}

export default function AdminApp() {
  // null until the auth-status fetch resolves — the shell shows ViewLoading
  // so the landing view can depend on the role without a sessions flash.
  const [currentView, setCurrentViewState] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // Participant profile drill-down from the Users table (ai-therapist-110);
  // mirrors the selectedSessionId/SessionDetail pattern.
  const [selectedUser, setSelectedUser] = useState<ProfileUserSummary | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);
  // Shared cached auth status: role for nav/landing, sandbox flag for the
  // persistent banner + one-time onboarding callout (all client data in a
  // sandbox account is synthetic).
  const { role: userRole, isSandbox, isCareTeam, loading: authLoading } = useAuth();
  const [sandboxCalloutDismissed, setSandboxCalloutDismissed] = useState(() => {
    try { return localStorage.getItem('sandbox-onboarding-dismissed') === '1'; } catch { return false; }
  });
  // Deployment posture (migration 060): 'research' shows every study surface;
  // 'clinical' (therapist pilot) hides the research-only nav items. UI framing
  // only — server-side authorization is unchanged.
  const [deploymentMode, setDeploymentMode] = useState<'research' | 'clinical'>('research');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // Adverse-event deadline reminder: count of overdue + due-soon drafts, shown
  // as a red badge on the Adverse Events nav item (ai-therapist-95).
  const [aeReminderCount, setAeReminderCount] = useState(0);
  // Open-escalations + unread-messages nav badges (care-team roles only).
  const [escalationCount, setEscalationCount] = useState(0);
  const [messagingUnread, setMessagingUnread] = useState(0);

  const setCurrentView = useCallback((view: string) => setCurrentViewState(view), []);

  // Once the shared auth-status fetch resolves, pick the role-dependent
  // landing view. useAuth falls back to a null role on any failure, so the
  // shell never wedges on ViewLoading.
  useEffect(() => {
    if (authLoading) return;
    setCurrentViewState(prev => prev ?? landingViewFor(userRole));
  }, [authLoading, userRole]);

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

  // Session deep link: crisis SMS pages link to /admin#session=<id> so the
  // on-call researcher lands directly on the flagged session instead of the
  // dashboard root. Read once on mount; the hash is cleared so a later reload
  // doesn't resurrect a stale session view.
  useEffect(() => {
    const match = /[#&]session=([^&]+)/.exec(window.location.hash);
    if (match) {
      setSelectedSessionId(decodeURIComponent(match[1]));
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
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

  // Open-escalations + unread-messages badges for care-team roles. Refreshed
  // on view changes so acting on items updates the counts without a reload.
  useEffect(() => {
    if (!isCareTeam) return;
    fetch('/admin/api/escalations?count_only=1', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (typeof data?.count === 'number') setEscalationCount(data.count); })
      .catch(() => { /* nav badge is best-effort */ });
    fetch('/api/admin/messaging/inbox', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (typeof data?.unread_total === 'number') setMessagingUnread(data.unread_total); })
      .catch(() => { /* nav badge is best-effort */ });
  }, [isCareTeam, currentView]);

  // Open a participant profile from views that only know the client id
  // (triage roster, work queue). Username is resolved best-effort from the
  // caller's caseload; the profile page itself is id-driven.
  const usernameCacheRef = useRef(new Map<number, string>());
  const openParticipantProfile = useCallback(async (clientId: number) => {
    const cache = usernameCacheRef.current;
    if (!cache.has(clientId)) {
      try {
        const r = await fetch('/admin/api/caseload', { credentials: 'include' });
        if (r.ok) {
          const data = await r.json();
          for (const row of [...(data.clients ?? []), ...(data.assignments ?? [])]) {
            const id = Number(row.userid ?? row.client_id);
            const name = row.username ?? row.client_username;
            if (Number.isInteger(id) && typeof name === 'string') cache.set(id, name);
          }
        }
      } catch { /* fall through to the id-only label */ }
    }
    setSelectedUser({
      userid: clientId,
      username: cache.get(clientId) ?? `client #${clientId}`,
      role: 'participant',
    });
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
  type NavItem = { id: string; label: string; icon: typeof Activity; researcherOnly?: boolean; researchOnly?: boolean; demoVisible?: boolean; roles?: string[] };
  const navGroups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: 'Operations',
      items: [
        // Caseworker portal: attention-ranked triage roster + care-team work
        // queue. Caseworkers are summaries-tier — Live Monitoring, Sessions
        // and Analytics stay hidden for them (roles allowlists below).
        { id: 'triage', label: 'Triage', icon: Target, roles: ['caseworker', 'therapist', 'researcher'] },
        { id: 'work-queue', label: 'Work Queue', icon: Inbox, roles: ['caseworker', 'therapist'] },
        { id: 'live', label: 'Live Monitoring', icon: Activity, roles: ['therapist', 'researcher', 'demo'] },
        { id: 'sessions', label: 'Sessions', icon: List, roles: ['therapist', 'researcher', 'demo'] },
        // Historic id: 'dashboard' renders the Analytics view.
        { id: 'dashboard', label: 'Analytics', icon: BarChart2, roles: ['therapist', 'researcher', 'demo'] },
      ],
    },
    {
      label: 'Safety',
      items: [
        { id: 'crisis', label: 'Crisis Management', icon: AlertTriangle },
        { id: 'escalations', label: 'Escalations', icon: ArrowUpCircle, roles: ['therapist', 'caseworker'] },
        { id: 'adverse-events', label: 'Adverse Events', icon: FilePlus, roles: ['therapist', 'caseworker', 'researcher', 'demo'] },
      ],
    },
    {
      label: 'People',
      items: [
        { id: 'users', label: 'Users', icon: Users, researcherOnly: true, demoVisible: true },
        // Caseload RBAC (ai-therapist-119): therapist sees own clients +
        // invites; researcher sees the assignment matrix. Hidden from demo
        // accounts for MVP (demoVisible: false).
        { id: 'caseload', label: 'Caseload', icon: UserCheck, demoVisible: false },
        { id: 'messages', label: 'Messages', icon: MessageSquare, roles: ['therapist', 'caseworker'] },
        { id: 'user-sessions', label: 'User Sessions', icon: Key, researcherOnly: true },
        { id: 'rate-limits', label: 'Rate Limits', icon: AlertCircle, roles: ['therapist', 'researcher', 'demo'] },
      ],
    },
    {
      label: 'Research',
      items: [
        { id: 'prompts', label: 'System Prompts', icon: FileText, researcherOnly: true },
        { id: 'knowledge', label: 'Knowledge Base', icon: BookOpen, researcherOnly: true },
        { id: 'evals', label: 'Evals', icon: CheckSquare, researcherOnly: true },
        { id: 'redaction', label: 'Redaction Review', icon: EyeOff, researcherOnly: true },
        { id: 'consent', label: 'Consent Versions', icon: Clipboard, researcherOnly: true, researchOnly: true },
        { id: 'study-ops', label: 'Study Ops', icon: Clipboard, researcherOnly: true, researchOnly: true },
        { id: 'sandbox', label: 'Sandbox Invites', icon: Box, researcherOnly: true, researchOnly: true },
        { id: 'qualtrics', label: 'Qualtrics Sync', icon: RefreshCw, researcherOnly: true, researchOnly: true },
        { id: 'survey-data', label: 'Survey Data', icon: Clipboard, researcherOnly: true, researchOnly: true },
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
        // Explicit role allowlist (caseworker portal): hidden unless the
        // resolved role is listed.
        if (item.roles && (!userRole || !item.roles.includes(userRole))) {
          return false;
        }
        // Non-researcherOnly items may still opt out of demo accounts
        // (e.g. Caseload: demoVisible: false — no synthetic fixtures for MVP).
        if (item.demoVisible === false && userRole === 'demo') {
          return false;
        }
        return true;
      }),
    }))
    .filter(group => group.items.length > 0);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <AdminHeader
        onMenuClick={() => setIsSidebarOpen(true)}
        onMfaClick={() => setCurrentView('mfa')}
        onNotificationNavigate={() => setCurrentView('work-queue')}
      />
      {isSandbox && <SandboxBanner />}
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
                        {item.id === 'escalations' && escalationCount > 0 && (
                          <span className="ml-auto bg-red-600 text-white rounded-full px-2 py-0.5 text-xs font-bold">
                            {escalationCount}
                          </span>
                        )}
                        {item.id === 'messages' && messagingUnread > 0 && (
                          <span className="ml-auto bg-royal text-white rounded-full px-2 py-0.5 text-xs font-bold">
                            {messagingUnread}
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
          {isSandbox && !sandboxCalloutDismissed && (
            <div className="mx-4 mt-4 bg-sky-50 border border-sky-200 rounded-lg p-4 flex gap-3 items-start">
              <Info size={18} className="text-sky-600 shrink-0 mt-0.5" />
              <div className="text-sm text-sky-900 flex-1">
                <p className="font-semibold">Welcome to your sandbox</p>
                <p className="mt-1">
                  A synthetic caseload has been assembled for you: browse the triage roster, work the
                  queue, review notes and escalations, and try messaging. Everything here is fake data —
                  nothing you do reaches real participants or the on-call pager.
                </p>
              </div>
              <button
                onClick={() => {
                  setSandboxCalloutDismissed(true);
                  try { localStorage.setItem('sandbox-onboarding-dismissed', '1'); } catch { /* best-effort */ }
                }}
                className="p-1 text-sky-500 hover:text-sky-800"
                aria-label="Dismiss sandbox welcome"
              >
                <X size={16} />
              </button>
            </div>
          )}
          <ErrorBoundary resetKey={currentView ?? 'loading'}>
            <Suspense fallback={<ViewLoading />}>
              {currentView === null && <ViewLoading />}
              {currentView === 'triage' && <CaseworkerDashboard onSelectClient={openParticipantProfile} />}
              {currentView === 'work-queue' && (
                <div>
                  <WorkQueue
                    role={userRole === 'caseworker' ? 'caseworker' : 'therapist'}
                    onSelectClient={openParticipantProfile}
                  />
                  <div className="px-6 pb-6">
                    <NotificationPreferences />
                  </div>
                </div>
              )}
              {currentView === 'escalations' && <EscalationInbox userRole={userRole} />}
              {currentView === 'messages' && <MessagingInbox />}
              {currentView === 'sandbox' && <SandboxInvites />}
              {currentView === 'dashboard' && <Analytics />}
              {currentView === 'sessions' && <SessionList onViewSession={handleViewSession} />}
              {currentView === 'live' && <LiveMonitoring onViewSession={handleViewSession} />}
              {currentView === 'crisis' && <CrisisManagement onOpenMessages={() => setCurrentView('messages')} />}
              {currentView === 'adverse-events' && <AdverseEvents role={userRole} />}
              {currentView === 'rate-limits' && <RateLimitedUsers />}
              {currentView === 'mfa' && <MFASetup />}
              {currentView === 'users' && <UserManagement onViewUser={setSelectedUser} />}
              {currentView === 'user-sessions' && <UserSessions />}
              {currentView === 'caseload' && <CaseloadView userRole={userRole} />}
              {currentView === 'prompts' && <SystemPrompts />}
              {currentView === 'knowledge' && <KnowledgeBase />}
              {currentView === 'consent' && <ConsentVersions />}
              {currentView === 'study-ops' && <StudyOps />}
              {currentView === 'qualtrics' && <QualtricsSync />}
              {currentView === 'survey-data' && <SurveyData />}
              {currentView === 'evals' && <EvalsView onViewSession={handleViewSession} />}
              {currentView === 'redaction' && <RedactionReview />}
              {currentView === 'retention' && <DataRetention />}
              {currentView === 'config' && <SystemConfig />}
              {currentView === 'export' && <ExportPanel />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      {selectedUser && (
        <Suspense fallback={null}>
          <ParticipantProfile
            user={selectedUser}
            userRole={userRole}
            onClose={() => setSelectedUser(null)}
            onViewSession={(sessionId) => handleViewSession(sessionId)}
            onNavigate={(view) => {
              setSelectedUser(null);
              setCurrentView(view);
            }}
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
