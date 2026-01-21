# Multi-Factor Authentication (MFA) Setup Guide

## Overview

Multi-Factor Authentication (MFA) adds an extra layer of security to admin accounts (therapists and researchers) by requiring a second form of verification beyond just your password.

**Security Benefits:**
- Protects against password theft
- Prevents unauthorized access even if password is compromised
- Meets HIPAA security best practices
- Uses industry-standard TOTP (Time-based One-Time Password) protocol

## What You Need

1. **Your account credentials** (username and password)
2. **A smartphone** with an authenticator app installed:
   - Google Authenticator (iOS/Android)
   - Authy (iOS/Android/Desktop)
   - Microsoft Authenticator (iOS/Android)
   - 1Password, Bitwarden, or other password managers with TOTP support

## How to Enable MFA

### Step 1: Access MFA Settings

1. Log in to the admin panel
2. Navigate to Settings or Profile (wherever MFASetup component is added)
3. Find the "Multi-Factor Authentication" section

### Step 2: Initialize Setup

1. Click "Enable MFA"
2. A QR code will be displayed

### Step 3: Scan QR Code

1. Open your authenticator app
2. Tap "Add account" or "+" button
3. Choose "Scan QR Code"
4. Point your phone camera at the QR code on screen

**Can't scan?** Tap "Enter manually" in your app and type in the secret code shown below the QR code.

### Step 4: Enter Verification Code

1. Your authenticator app will now show a 6-digit code
2. Enter this code in the verification field
3. Click "Verify & Enable"

**Important:** The code changes every 30 seconds, so enter it quickly!

### Step 5: Save Backup Codes

✅ **CRITICAL: Save your backup codes immediately!**

- You'll see 10 backup codes (8-character codes like "A1B2C3D4")
- Each code can only be used once
- These are your only way to access your account if you lose your phone
- Click "Copy All" and save them in a secure location:
  - Password manager
  - Encrypted file
  - Physical paper in a safe place
  - **DO NOT** store them in plain text on your computer

## How to Log In with MFA Enabled

### Normal Login Flow

1. Enter your username and password as usual
2. Click "Login"
3. You'll be prompted for your MFA code
4. Open your authenticator app
5. Enter the current 6-digit code
6. You're logged in!

### Using a Backup Code

If you lost your phone or authenticator app:

1. Enter username and password
2. Click "Use Backup Code" instead of entering MFA token
3. Enter one of your saved backup codes
4. **Important:** That code is now used and won't work again

## Managing Your MFA

### Check MFA Status

Go to MFA settings to see:
- Whether MFA is enabled
- When you enabled it
- How many backup codes you have left

### Regenerate Backup Codes

If you've used some backup codes or want fresh ones:

1. Go to MFA settings
2. Enter your password
3. Click "Regenerate Backup Codes"
4. Save the new codes securely
5. **Old codes are immediately invalid**

### Disable MFA

⚠️ **Not Recommended** - Only disable if absolutely necessary:

1. Go to MFA settings
2. Enter your password
3. Click "Disable MFA"
4. Confirm the action
5. Your account is now less secure (password only)

## Troubleshooting

### Problem: "Invalid token" error

**Causes:**
- Code expired (they change every 30 seconds)
- Phone's clock is wrong
- Entered code from wrong account

**Solutions:**
- Wait for a fresh code and try again quickly
- Check your phone's time settings (enable automatic time)
- Make sure you're using the code for "AI Therapy (your-username)"

### Problem: Lost phone/authenticator

**Solution:** Use a backup code

1. Click "Use Backup Code" on login
2. Enter one of your saved backup codes
3. Once logged in, go to MFA settings
4. Regenerate new backup codes
5. Set up MFA on your new device

### Problem: Lost backup codes AND phone

**Solution:** Contact system administrator

- You'll need admin help to disable MFA
- Administrator will verify your identity
- They can run: `UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE username = 'your-username';`
- You can then log in and re-enable MFA

### Problem: Codes not working even when entered correctly

**Possible cause:** Clock drift

**Solution:**
- Phone clocks must be accurate for TOTP to work
- Enable automatic time/date on your phone
- If using manual time, ensure it's within ±60 seconds of actual time

## API Endpoints (For Developers)

### Get MFA Status
```
GET /api/mfa/status
Authorization: Required (session)
Response: { enabled: boolean, backupCodesRemaining: number, ... }
```

### Initialize MFA Setup
```
POST /api/mfa/setup/init
Authorization: Required (therapist/researcher only)
Response: { secret: string, qrCode: string (data URL) }
```

### Verify Setup
```
POST /api/mfa/setup/verify
Body: { token: string }
Response: { success: true, backupCodes: string[] }
```

### Disable MFA
```
POST /api/mfa/disable
Body: { password: string }
Response: { success: true }
```

### Regenerate Backup Codes
```
POST /api/mfa/regenerate-backup-codes
Body: { password: string }
Response: { backupCodes: string[] }
```

### Login with MFA
```
POST /api/auth/login
Body: { username, password, mfaToken?, backupCode? }
Response: { mfaRequired: boolean } or { success: true, user: {...} }
```

## Database Schema

New columns added to `users` table:

```sql
mfa_enabled BOOLEAN DEFAULT FALSE
mfa_secret TEXT -- Base32-encoded TOTP secret
mfa_backup_codes TEXT[] -- Array of bcrypt-hashed backup codes
mfa_enabled_at TIMESTAMPTZ
last_mfa_verified_at TIMESTAMPTZ
```

## Security Notes

### What We Protect

✅ **Hashed:** Backup codes are bcrypt-hashed before storage
✅ **Session-based:** MFA verification required per session
✅ **Time-window:** TOTP codes accept ±60 second clock drift
✅ **Single-use:** Backup codes are deleted after use
✅ **Password-protected:** Disabling/regenerating requires password

### What Admins Should Know

- TOTP secrets are stored in plain text in database (industry standard)
- Consider encrypting `mfa_secret` column at rest if not already
- MFA is enforced server-side - clients can't bypass it
- Failed MFA attempts are logged in console
- Backup codes use bcrypt with cost factor 10

### Best Practices

1. **Require MFA for all admin accounts** (enforce via policy)
2. **Audit MFA status regularly** (who has it enabled?)
3. **Test backup code recovery** (ensure process works)
4. **Document admin override process** (for lost credentials)
5. **Monitor for suspicious activity** (unusual login times/locations)
6. **Consider session timeout** (force re-authentication after X hours)

## Migration Instructions

Run the migration:

```bash
node src/database/scripts/runMigration016.js
```

Rollback if needed:

```bash
node src/database/scripts/rollbackMigration016.js
```

## Compliance

**HIPAA Relevance:**
- Satisfies "Technical Safeguards" requirement (45 CFR § 164.312)
- Helps meet "Access Control" standards
- Part of "Authentication" controls
- Recommended for all users accessing PHI

**Audit Trail:**
- `mfa_enabled_at` tracks when MFA was enabled
- `last_mfa_verified_at` tracks last successful verification
- Console logs capture MFA events (enable, disable, backup code usage)

## Support

For issues or questions:
1. Check this guide first
2. Check server console logs
3. Contact system administrator
4. Report bugs via GitHub issues

---

**Last Updated:** January 2026
**Version:** 1.0.0
