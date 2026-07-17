import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, BarChart2, ArrowRight } from 'react-feather';

// Chooser page the magic link lands on. Lets a portfolio/resume visitor pick
// between trying the therapy bot and exploring the (synthetic) clinician
// dashboard. Only demo accounts reach it; anyone else is bounced to the app.
export default function DemoLanding() {
  const [checked, setChecked] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/auth/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (d?.authenticated && d?.user?.role === 'demo') {
          setIsDemo(true);
        } else if (d?.authenticated) {
          navigate('/', { replace: true });
        } else {
          navigate('/login', { replace: true });
        }
      })
      .catch(() => navigate('/login', { replace: true }))
      .finally(() => setChecked(true));
  }, [navigate]);

  if (!checked || !isDemo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-500">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-gradient-to-br from-navy to-royal px-4 py-10">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-8">
          <span className="inline-block bg-amber-400 text-amber-950 text-xs font-semibold px-3 py-1 rounded-full mb-4">
            Portfolio demo
          </span>
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
            AI Therapist — interactive demo
          </h1>
          <p className="text-blue-100 max-w-xl mx-auto">
            A research platform for AI-assisted voice therapy: a real-time
            therapy bot on one side, and a clinician monitoring dashboard on the
            other. Explore either — you can switch between them any time.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <a
            href="/"
            className="group bg-white rounded-2xl shadow-xl p-7 flex flex-col hover:-translate-y-1 transition-transform"
          >
            <div className="w-12 h-12 rounded-xl bg-royal/10 text-royal flex items-center justify-center mb-4">
              <Mic size={24} />
            </div>
            <h2 className="text-xl font-bold text-navy mb-2">Try the therapy bot</h2>
            <p className="text-gray-600 text-sm flex-1">
              Have a real voice or text conversation with the AI therapist —
              the actual participant experience. Sessions are capped at 5 minutes,
              5 per day.
            </p>
            <span className="mt-5 inline-flex items-center gap-1 text-royal font-semibold group-hover:gap-2 transition-all">
              Start a session <ArrowRight size={18} />
            </span>
          </a>

          <a
            href="/admin"
            className="group bg-white rounded-2xl shadow-xl p-7 flex flex-col hover:-translate-y-1 transition-transform"
          >
            <div className="w-12 h-12 rounded-xl bg-royal/10 text-royal flex items-center justify-center mb-4">
              <BarChart2 size={24} />
            </div>
            <h2 className="text-xl font-bold text-navy mb-2">View the dashboard</h2>
            <p className="text-gray-600 text-sm flex-1">
              Explore the clinician side: live monitoring, session transcripts,
              analytics, and crisis management — populated with fully synthetic
              data (no real participant information).
            </p>
            <span className="mt-5 inline-flex items-center gap-1 text-royal font-semibold group-hover:gap-2 transition-all">
              Open dashboard <ArrowRight size={18} />
            </span>
          </a>
        </div>

        <p className="text-center text-blue-200 text-xs mt-8">
          This is a sandboxed demo account. Real participant data is never shown,
          and nothing you do here is saved.
        </p>
      </div>
    </div>
  );
}
