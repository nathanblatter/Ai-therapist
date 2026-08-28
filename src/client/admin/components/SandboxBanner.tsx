// Persistent amber banner shown across the admin SPA for sandbox accounts
// (caseworker portal, spec section 4). Purely presentational: the integrator
// mounts it in AdminApp when the auth-status payload reports is_sandbox.
// This banner + the /join-sandbox page ARE the sandbox disclosure (spec
// section 6: deliberately not a consent_documents row — fake clients never
// log in, so participant consent never fires in a sandbox).
import { AlertTriangle } from 'react-feather';

export default function SandboxBanner() {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2 bg-amber-100 border-b border-amber-300 text-amber-900 text-sm"
      role="status"
    >
      <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
      <span>
        <span className="font-semibold">Sandbox environment</span> — all client data is synthetic.
        Do not enter real patient information.
      </span>
    </div>
  );
}
