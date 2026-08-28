// Project-wide ambient type augmentations for the server.
import "express-session";
import type { Server as SocketIOServer } from "socket.io";
import type { UserRole } from "../shared/roles.js";

// The role/tier vocabulary lives in src/shared/roles.ts (caseworker portal
// foundation); re-exported here so existing `from '../types.js'` imports keep
// working.
export type {
  UserRole,
  CareTeamRole,
  DataTier,
  CareTeamMember,
} from "../shared/roles.js";
export { isCareTeamRole, dataTierFor } from "../shared/roles.js";

// Fields we store on the express session (set at login / MFA).
declare module "express-session" {
  interface SessionData {
    userId?: number;
    username?: string;
    userRole?: string;
    user?: SessionUser;
    mfaVerified?: boolean;
    tempMFASecret?: string;
    /** The user's organization (069); stamped at login, lazily backfilled for
     *  pre-069 sessions by middleware/org.ts. */
    orgId?: number;
    /** Denormalized users.is_sandbox (077); stamped at login/join. */
    isSandbox?: boolean;
    /** Therapy sessions created by this (possibly anonymous) browser session. */
    ownedSessions?: string[];
    /** Has this browser session accepted the current consent screen? */
    consentAccepted?: boolean;
    /** Version of the consent copy that was accepted. */
    consentVersion?: string;
    /** When consent was accepted (ISO string). */
    consentAcceptedAt?: string;
  }
}

// `io` is published on globalThis in index.ts for cross-module event emission.
declare global {
  // eslint-disable-next-line no-var
  var io: SocketIOServer;
}

export interface SessionUser {
  userid: number;
  username: string;
  role: UserRole;
  organizationId?: number;
}
