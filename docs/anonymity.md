# Anonymity Assurance for AI Conversation Logs

## Overview

This document describes the technical and procedural safeguards implemented to ensure that personally identifiable information (PII) and protected health information (PHI) are removed from AI conversation logs before they are used for research purposes. The system achieves anonymity through a **multi-layered defense-in-depth approach** combining automated AI redaction with mandatory human verification.

## Anonymization Architecture

### Layer 1: Dual-Pass Automated Redaction

All conversation messages undergo **two sequential passes** through an AI redaction model before being considered for research use.

**Why Two Passes?**
- The first pass identifies and redacts obvious PII/PHI
- The second pass reviews the already-redacted output to catch any identifiers that may have been missed due to:
  - Complex sentence structures
  - Contextual references (e.g., "my doctor at [previously mentioned hospital]")
  - Edge cases in entity recognition
  - Unusual formatting or misspellings of identifying information

**Technical Implementation:**
```
Original Message → Pass 1 (AI Redaction) → Pass 2 (AI Verification) → Redacted Output
```

Each pass uses OpenAI's GPT 5.2 model with explicit HIPAA Safe Harbor instructions, targeting all 18 Safe Harbor identifiers:

| Category | Examples |
|----------|----------|
| Names | Full names, nicknames, usernames |
| Geographic Data | Street addresses, cities, counties, ZIP codes (smaller than state) |
| Dates | Birth dates, appointment dates, ages over 89 |
| Contact Information | Phone numbers, fax numbers, email addresses |
| Government IDs | Social Security numbers, driver's license numbers |
| Medical Identifiers | Medical record numbers, health plan beneficiary numbers |
| Financial Identifiers | Account numbers, certificate/license numbers |
| Device/Vehicle IDs | Serial numbers, license plate numbers, device identifiers |
| Digital Identifiers | URLs, IP addresses |
| Biometric Data | Fingerprints, voiceprints, photographic images |
| Other Unique Identifiers | Any characteristic that could uniquely identify an individual |

**Redaction Format:**
All identified PII is replaced with standardized placeholders (e.g., `[REDACTED: NAME]`, `[REDACTED: DATE]`, `[REDACTED: PHONE]`) that preserve the semantic structure of the conversation while removing identifying information.

### Layer 2: Human Verification

**All redacted messages are subject to mandatory human review** before inclusion in any research dataset. A trained Research Assistant (RA) monitors and verifies redacted content through a dedicated verification interface (`/redact` endpoint).

**Verification Workflow:**
1. The RA accesses batches of redacted messages through the secure verification interface
2. Each message displays:
   - The redacted content (never the original)
   - Message metadata (role, type, timestamp)
   - Unique message identifier
3. The RA reviews each message for any PII that may have escaped automated redaction
4. If PII is detected, the RA manually edits the redacted content to remove it
5. All manual corrections are logged with timestamps

**Key Safeguards:**
- RAs only see redacted content, never original messages containing PII
- The verification interface requires authenticated access with the "researcher" role
- Manual edits update only the redacted field, preserving audit trails
- Random sampling ensures comprehensive coverage across all conversation types

### Layer 3: Data Separation

The database architecture maintains strict separation between original and redacted content:

| Field | Access | Purpose |
|-------|--------|---------|
| `content` | Therapists only | Clinical care |
| `content_redacted` | Researchers | Anonymized research data |

- Research exports **only include redacted content**
- Original content is never accessible to researchers
- Role-based access controls enforce this separation at the API level

### Layer 4: Automated Content Deletion

**Original message content is automatically and permanently deleted** after a configurable retention period (default: 24 hours). This ensures that PII is not retained longer than necessary for clinical purposes.

**How It Works:**
1. A scheduled job runs daily at a configured time (default: 3:00 AM)
2. For each message older than the retention period:
   - Verifies that redaction has completed successfully
   - Permanently sets the original `content` field to NULL
   - Logs the deletion in an audit table for compliance documentation

**Safeguards:**
- Content is **only deleted after redaction is confirmed complete**
- Messages with redaction errors are flagged and skipped (not deleted)
- All deletions are logged with timestamps, counts, and trigger source (scheduled vs. manual)
- Administrators can trigger manual wipes and adjust settings through the admin interface

**Audit Trail:**
Each wipe operation is recorded in the `content_wipe_log` table with:
- Timestamp of operation
- Number of messages wiped
- Number of messages skipped (incomplete redaction)
- Trigger type (scheduler or manual)
- User who triggered (if manual)
- Retention period in effect at time of wipe

This layer ensures that **even if unauthorized access to the database occurred**, original PII would not be present after the retention period expires.

## Process Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        MESSAGE LIFECYCLE                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  User/AI Message                                                         │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────┐                                                         │
│  │  Database   │  Original content stored (therapist access only)        │
│  │  (content)  │                                                         │
│  └──────┬──────┘                                                         │
│         │                                                                │
│         ▼                                                                │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    AUTOMATED REDACTION                          │    │
│  │  ┌─────────────┐         ┌─────────────┐                        │    │
│  │  │   Pass 1    │────────▶│   Pass 2    │                        │    │
│  │  │ AI Redaction│         │AI Verification│                      │    │
│  │  └─────────────┘         └──────┬──────┘                        │    │
│  └─────────────────────────────────┼───────────────────────────────┘    │
│                                    │                                     │
│                                    ▼                                     │
│  ┌──────────────────┐                                                    │
│  │    Database      │  Redacted content stored                           │
│  │(content_redacted)│                                                    │
│  └────────┬─────────┘                                                    │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    HUMAN VERIFICATION                           │    │
│  │  Research Assistant reviews via /redact interface               │    │
│  │  • Identifies any escaped PII                                   │    │
│  │  • Manually corrects redaction if needed                        │    │
│  │  • Documents all changes                                        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                AUTOMATED CONTENT DELETION                       │    │
│  │  After retention period (default 24h):                          │    │
│  │  • Original content field set to NULL                           │    │
│  │  • Deletion logged in audit table                               │    │
│  │  • Only redacted content remains                                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────┐                                                     │
│  │ Verified        │  Ready for research use                             │
│  │ Anonymized Data │  (Original PII permanently deleted)                 │
│  └─────────────────┘                                                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Evidence of Effectiveness

### Defense-in-Depth Strategy

The system does not rely on any single mechanism for anonymization:

| Layer | Mechanism | Failure Mode Addressed |
|-------|-----------|------------------------|
| 1a | First AI redaction pass | Catches standard PII patterns |
| 1b | Second AI redaction pass | Catches edge cases missed by first pass |
| 2 | Human verification | Catches any AI failures |
| 3 | Data separation | Prevents accidental exposure even if redaction fails |
| 4 | Automated content deletion | Eliminates PII from storage entirely after retention period |

### Compliance with HIPAA Safe Harbor

The automated redaction system is specifically designed to comply with the **HIPAA Safe Harbor de-identification standard** (45 CFR 164.514(b)(2)), which requires removal of 18 specific identifier categories. The AI model is explicitly instructed to identify and redact all 18 categories, and the prompt is designed to be:

- **Conservative**: When in doubt, redact
- **Comprehensive**: Covers all Safe Harbor categories
- **Resistant to bypass**: Ignores any embedded instructions in the text being redacted

### Human Oversight Guarantee

The key distinction between "improving privacy" and "maintaining privacy" is addressed through the **mandatory human verification layer**:

1. **No data is used for research without human review**
2. **RAs are trained** to identify PII that may not be obvious to automated systems
3. **Any PII that escapes automated redaction will be caught and manually removed** before the data enters any research dataset
4. **The verification interface provides efficient batch review** to ensure all messages can be reviewed in a timely manner

## Conclusion

Anonymity is achieved through a combination of:

1. **Dual-pass automated redaction** using state-of-the-art AI models with HIPAA Safe Harbor compliance
2. **Mandatory human verification** by trained Research Assistants with the ability to correct any escaped PII
3. **Architectural data separation** ensuring researchers never access original content
4. **Automated content deletion** permanently removing original PII from storage after the clinical retention period

This defense-in-depth approach ensures that **no personally identifiable information will be present in research datasets**, even if any individual layer were to fail. The human verification layer serves as the ultimate safeguard during the retention period, and the automated deletion layer ensures that **PII is not retained in perpetuity** - original content is permanently destroyed after clinical needs are met, leaving only verified anonymized data.

---

*Document prepared for IRB review*
*System implementation: AI-Therapist Research Platform*
