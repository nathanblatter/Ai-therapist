// Project-wide ambient type augmentations for the server.
import "express-session";
import type { Server as SocketIOServer } from "socket.io";

// Fields we store on the express session (set at login / MFA).
declare module "express-session" {
  interface SessionData {
    userId?: number;
    username?: string;
    userRole?: string;
    user?: SessionUser;
    mfaVerified?: boolean;
    tempMFASecret?: string;
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
}

export type UserRole = "therapist" | "researcher" | "participant";
