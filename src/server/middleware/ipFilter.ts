// IP Geolocation filtering middleware
// Restricts participants to US-based access only
// Allows therapists and researchers to access from anywhere

import geoip from 'geoip-lite';
import type { Request, Response, NextFunction } from 'express';

/**
 * Get client IP address from request.
 * Uses req.ip, which honours `trust proxy` (set to 1 for the Cloudflare
 * tunnel). Never read x-forwarded-for directly: its first hop is
 * client-supplied, so trusting it lets anyone spoof a US IP.
 */
function getClientIp(req: Request): string | undefined {
  return req.ip ?? req.socket.remoteAddress ?? undefined;
}

/**
 * Check if IP address is from the United States
 * @param {string} ip - IP address to check
 * @returns {boolean} - True if US-based, false otherwise
 */
function isUsBasedIp(ip: string | undefined): boolean {
  // Handle localhost/development IPs
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.0.0.1')) {
    // In development, allow localhost
    return true;
  }

  // Look up IP geolocation
  const geo = geoip.lookup(ip);

  if (!geo) {
    // If we can't determine location, deny for security
    return false;
  }

  // Check if country code is US
  return geo.country === 'US';
}

/**
 * Middleware to restrict participant access to US-based IPs only
 * Therapists and researchers can access from anywhere
 */
export function restrictParticipantsToUs(req: Request, res: Response, next: NextFunction): Response | void {
  // Skip IP check for admin routes - therapists/researchers handle their own auth
  if (req.path.startsWith('/admin')) {
    return next();
  }

  // Skip IP check for authentication routes so therapists/researchers abroad
  // can log in (their role then exempts them below).
  if (req.path === '/api/auth/login' || req.path === '/api/auth/logout') {
    return next();
  }

  // Skip IP check for static assets
  if (req.path.startsWith('/assets') || req.path.startsWith('/dist')) {
    return next();
  }

  const clientIp = getClientIp(req);
  const userRole = req.session?.userRole;

  // If user is authenticated as therapist or researcher, allow from anywhere
  if (userRole === 'therapist' || userRole === 'researcher') {
    return next();
  }

  // For participants (or unauthenticated users), check if IP is US-based
  if (!isUsBasedIp(clientIp)) {
    return res.status(403).json({
      error: 'Access Restricted',
      message: 'This service is only available to users within the United States. If you are a therapist or researcher, please log in to access from any location.'
    });
  }

  // IP is US-based, allow access
  next();
}
