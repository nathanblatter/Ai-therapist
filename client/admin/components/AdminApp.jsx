import { useState } from "react";
import { BarChart2, List, Download, Users } from "react-feather";
import AdminHeader from "./AdminHeader";
import SessionList from "./SessionList";
import SessionDetail from "./SessionDetail";
import Analytics from "./Analytics";
import ExportPanel from "./ExportPanel";
import UserManagement from "./UserManagement";

export default function AdminApp() {
  const [currentView, setCurrentView] = useState('sessions');
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [isClient, setIsClient] = useState(false);

  // Handle SSR - only render interactive parts on client
  if (typeof window !== 'undefined' && !isClient) {
    setIsClient(true);
  }

  const handleViewSession = (sessionId) => {
    setSelectedSessionId(sessionId);
  };

  const handleCloseSession = () => {
    setSelectedSessionId(null);
  };

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: BarChart2 },
    { id: 'sessions', label: 'Sessions', icon: List },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'export', label: 'Export', icon: Download }
  ];

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
          {currentView === 'users' && <UserManagement />}
          {currentView === 'export' && <ExportPanel />}
        </div>
      </main>

      {selectedSessionId && (
        <SessionDetail
          sessionId={selectedSessionId}
          onClose={handleCloseSession}
        />
      )}
    </div>
  );
}
