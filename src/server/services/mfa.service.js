import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { pool } from '../config/db.js';

/**
 * Generate a new MFA secret for a user
 * @param {string} username - Username for the TOTP label
 * @returns {Object} - Secret object with base32 secret and otpauth URL
 */
export function generateMFASecret(username) {
  const secret = speakeasy.generateSecret({
    name: `AI Therapy (${username})`,
    issuer: 'AI Therapy Platform',
    length: 32
  });

  return {
    secret: secret.base32,
    otpauthUrl: secret.otpauth_url
  };
}

/**
 * Generate QR code data URL from otpauth URL
 * @param {string} otpauthUrl - The otpauth:// URL
 * @returns {Promise<string>} - Data URL for QR code image
 */
export async function generateQRCode(otpauthUrl) {
  try {
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
    return qrCodeDataUrl;
  } catch (error) {
    console.error('Failed to generate QR code:', error);
    throw new Error('Failed to generate QR code');
  }
}

/**
 * Verify a TOTP token against a secret
 * @param {string} token - 6-digit TOTP token from user
 * @param {string} secret - Base32-encoded secret
 * @returns {boolean} - Whether the token is valid
 */
export function verifyTOTP(token, secret) {
  return speakeasy.totp.verify({
    secret: secret,
    encoding: 'base32',
    token: token,
    window: 2 // Allow 2 time steps before/after for clock drift (±60 seconds)
  });
}

/**
 * Generate backup codes for account recovery
 * @param {number} count - Number of backup codes to generate (default: 10)
 * @returns {Promise<{codes: string[], hashedCodes: string[]}>} - Plain codes and hashed versions
 */
export async function generateBackupCodes(count = 10) {
  const codes = [];
  const hashedCodes = [];

  for (let i = 0; i < count; i++) {
    // Generate 8-character alphanumeric code
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(code);

    // Hash the code for storage
    const hash = await bcrypt.hash(code, 10);
    hashedCodes.push(hash);
  }

  return { codes, hashedCodes };
}

/**
 * Verify a backup code against stored hashed codes
 * @param {string} code - Backup code from user
 * @param {string[]} hashedCodes - Array of hashed backup codes from database
 * @returns {Promise<{valid: boolean, remainingCodes: string[]}>} - Validation result and updated codes
 */
export async function verifyBackupCode(code, hashedCodes) {
  if (!hashedCodes || hashedCodes.length === 0) {
    return { valid: false, remainingCodes: [] };
  }

  // Check each hashed code
  for (let i = 0; i < hashedCodes.length; i++) {
    const isValid = await bcrypt.compare(code, hashedCodes[i]);

    if (isValid) {
      // Remove the used code
      const remainingCodes = [...hashedCodes];
      remainingCodes.splice(i, 1);

      return { valid: true, remainingCodes };
    }
  }

  return { valid: false, remainingCodes: hashedCodes };
}

/**
 * Enable MFA for a user
 * @param {number} userId - User ID
 * @param {string} secret - Base32-encoded TOTP secret
 * @param {string[]} hashedBackupCodes - Array of hashed backup codes
 */
export async function enableMFA(userId, secret, hashedBackupCodes) {
  await pool.query(
    `UPDATE users
     SET mfa_enabled = true,
         mfa_secret = $1,
         mfa_backup_codes = $2,
         mfa_enabled_at = CURRENT_TIMESTAMP
     WHERE userid = $3`,
    [secret, hashedBackupCodes, userId]
  );
}

/**
 * Disable MFA for a user
 * @param {number} userId - User ID
 */
export async function disableMFA(userId) {
  await pool.query(
    `UPDATE users
     SET mfa_enabled = false,
         mfa_secret = NULL,
         mfa_backup_codes = NULL,
         mfa_enabled_at = NULL,
         last_mfa_verified_at = NULL
     WHERE userid = $1`,
    [userId]
  );
}

/**
 * Update last MFA verification timestamp
 * @param {number} userId - User ID
 */
export async function updateMFAVerificationTime(userId) {
  await pool.query(
    `UPDATE users
     SET last_mfa_verified_at = CURRENT_TIMESTAMP
     WHERE userid = $1`,
    [userId]
  );
}

/**
 * Get MFA status for a user
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - MFA status object
 */
export async function getMFAStatus(userId) {
  const result = await pool.query(
    `SELECT mfa_enabled, mfa_secret, mfa_backup_codes, mfa_enabled_at, last_mfa_verified_at
     FROM users
     WHERE userid = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  const user = result.rows[0];

  return {
    enabled: user.mfa_enabled,
    enabledAt: user.mfa_enabled_at,
    lastVerifiedAt: user.last_mfa_verified_at,
    backupCodesRemaining: user.mfa_backup_codes ? user.mfa_backup_codes.length : 0,
    secret: user.mfa_secret // Only return this for internal use
  };
}

/**
 * Update backup codes after one is used
 * @param {number} userId - User ID
 * @param {string[]} remainingCodes - Updated array of hashed backup codes
 */
export async function updateBackupCodes(userId, remainingCodes) {
  await pool.query(
    `UPDATE users
     SET mfa_backup_codes = $1
     WHERE userid = $2`,
    [remainingCodes, userId]
  );
}
