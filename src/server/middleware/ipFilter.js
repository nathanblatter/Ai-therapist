// IP Geolocation filtering middleware
// Restricts participants to US-based access only
// Allows therapists and researchers to access from anywhere

import geoip from 'geoip-lite';

/**
 * Get client IP address from request
 * Handles proxies and load balancers
 */
function getClientIp(req) {
  // Check common headers for proxied requests
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for can contain multiple IPs, take the first one
    return forwarded.split(',')[0].trim();
  }

  // Check other common proxy headers
  return req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         req.socket.remoteAddress ||
         req.connection.socket?.remoteAddress;
}

/**
 * Check if IP address is from the United States
 * @param {string} ip - IP address to check
 * @returns {boolean} - True if US-based, false otherwise
 */
function isUsBasedIp(ip) {
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
export function restrictParticipantsToUs(req, res, next) {
  // Skip IP check for admin routes - therapists/researchers handle their own auth
  if (req.path.startsWith('/admin')) {
    return next();
  }

  // Skip IP check for authentication routes
  if (req.path === '/api/login' || req.path === '/api/logout') {
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
