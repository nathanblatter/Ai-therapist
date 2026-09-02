# Redaction Pipeline — Safe Harbor Evidence

**Generated:** 2026-09-02  
**Redactor:** `redactPHIBatch` (src/server/services/redaction.service.ts) — the
production per-session batch redactor, dual-pass, index-anchored with retry
and per-item fallback (ai-therapist-150 fix).  
**Method:** 17 synthetic messages (no real participant data), each
seeded with substrings from the 18 HIPAA Safe Harbor identifier categories,
run through the redactor in one batch. A case passes if none of its planted
identifiers survive in the output.

## Summary

| Metric | Result |
| --- | --- |
| Categories exercised | 16 identifier cases + 1 control |
| Planted identifiers | 20 |
| Identifiers still present after redaction | 0 |
| Cases fully redacted | 17 / 17 |
| Batch shape preserved (items in = items out) | yes |

## Per-category results

| Category | Planted | Survived | Result |
| --- | --- | --- | --- |
| 1. Names | 2 | — | redacted |
| 2. Geographic | 3 | — | redacted |
| 3. Dates | 2 | — | redacted |
| 4. Telephone | 1 | — | redacted |
| 5. Fax | 1 | — | redacted |
| 6. Email | 1 | — | redacted |
| 7. SSN | 1 | — | redacted |
| 8. Medical record # | 1 | — | redacted |
| 9. Health plan # | 1 | — | redacted |
| 10. Account # | 1 | — | redacted |
| 11. License # | 1 | — | redacted |
| 12. Vehicle | 1 | — | redacted |
| 13. Device ID | 1 | — | redacted |
| 14. URL | 1 | — | redacted |
| 15. IP address | 1 | — | redacted |
| 16-18. Other unique ID | 1 | — | redacted |
| Control (no PHI) | 0 | — | redacted |

## Redacted output (verbatim)

Synthetic inputs and their redacted forms, to show placeholder behavior and
that non-PHI clinical content is preserved:

**1. Names**  
- in:  Hi, my name is Jonathan Reyes and my sister is Maria Reyes.  
- out: Hi, my name is [REDACTED: NAME] and my sister is [REDACTED: NAME].

**2. Geographic**  
- in:  I live at 448 Oak Street, Provo, Utah 84604.  
- out: I live at [REDACTED: LOCATION].

**3. Dates**  
- in:  I was born on March 14, 1998 and admitted on 06/02/2026.  
- out: I was born on [REDACTED: DATE] and admitted on [REDACTED: DATE].

**4. Telephone**  
- in:  You can call me at (801) 555-0148 any time.  
- out: You can call me at [REDACTED: TELEPHONE NUMBER] any time.

**5. Fax**  
- in:  Send the form to our fax at 801-555-0199.  
- out: Send the form to our fax at [REDACTED: FAX NUMBER].

**6. Email**  
- in:  My email is jon.reyes47@gmail.com if you need it.  
- out: My email is [REDACTED: EMAIL ADDRESS] if you need it.

**7. SSN**  
- in:  My social security number is 528-19-4471.  
- out: My social security number is [REDACTED: SSN].

**8. Medical record #**  
- in:  The clinic listed my MRN as 00847213 on the chart.  
- out: The clinic listed my MRN as [REDACTED: MEDICAL RECORD NUMBER] on the chart.

**9. Health plan #**  
- in:  My insurance member ID is HPX9928374.  
- out: My insurance member ID is [REDACTED: HEALTH PLAN BENEFICIARY NUMBER].

**10. Account #**  
- in:  The billing account number is 4471-2205-8890.  
- out: The billing account number is [REDACTED: ACCOUNT NUMBER].

**11. License #**  
- in:  My driver license number is D19284756.  
- out: My driver license number is [REDACTED: CERTIFICATE OR LICENSE NUMBER].

**12. Vehicle**  
- in:  My car plate is 7XKR221 here in Utah.  
- out: My car plate is [REDACTED: VEHICLE IDENTIFIER] here in Utah.

**13. Device ID**  
- in:  My CPAP serial number is SN-4483-DEV-1190.  
- out: My CPAP serial number is [REDACTED: DEVICE IDENTIFIER].

**14. URL**  
- in:  My blog is at https://jonreyeswellness.com/journal.  
- out: My blog is at [REDACTED: URL].

**15. IP address**  
- in:  The app logged my IP as 172.58.203.14 last night.  
- out: The app logged my IP as [REDACTED: IP ADDRESS] last night.

**16-18. Other unique ID**  
- in:  My student ID at BYU is 09-338-2214 and everyone calls me by it.  
- out: My student ID at BYU is [REDACTED: UNIQUE IDENTIFIER] and everyone calls me by it.

**Control (no PHI)**  
- in:  I felt really anxious before my exam this week and could not sleep.  
- out: I felt really anxious before my exam this week and could not sleep.

---
Reproduce: `OPENAI_API_KEY=... node scripts/redaction-evidence.mjs`
