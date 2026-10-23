// Pure rendering for note copy/print (ai-therapist-199): the structured
// S/O/A/P order, header fields (client reference, session date, clinician,
// signature state) and HTML escaping.
import { describe, it, expect } from 'vitest';
import type { CareNoteRow } from '../../../../server/db/careNotes.queries';
import { noteToPlainText, noteToPrintableHtml, noteHeaderLines, signatureState } from './noteExport';

const signed: CareNoteRow = {
  note_id: 42,
  org_id: 1,
  client_id: 7,
  author_id: 3,
  author_name: 'Dr. Example',
  author_role: 'therapist',
  note_type: 'progress',
  case_note_kind: null,
  session_id: 'sess_abc',
  seed_source: 'ai_soap',
  seed_model: 'gpt-test',
  content: {
    plan: 'Follow up <next week>',
    subjective: 'Reports low mood',
    assessment: 'Mild',
    objective: 'Flat affect',
  },
  status: 'signed',
  shared_with_care_team: false,
  signed_at: '2026-10-20T15:00:00.000Z',
  sign_hash: 'abc123',
  amends_note_id: null,
  created_at: '2026-10-20T14:00:00.000Z',
  updated_at: '2026-10-20T15:00:00.000Z',
};

describe('noteToPlainText', () => {
  it('renders S/O/A/P in order with headers, signer and signed-at', () => {
    const text = noteToPlainText(signed, { clientLabel: 'client-007', sessionDate: '2026-10-20T13:00:00.000Z' });
    const idx = (s: string) => text.indexOf(s);
    expect(text.startsWith('PROGRESS NOTE (SOAP)')).toBe(true);
    expect(idx('SUBJECTIVE')).toBeLessThan(idx('OBJECTIVE'));
    expect(idx('OBJECTIVE')).toBeLessThan(idx('ASSESSMENT'));
    expect(idx('ASSESSMENT')).toBeLessThan(idx('PLAN'));
    expect(text).toContain('Client: client-007');
    expect(text).toContain('Clinician: Dr. Example (therapist)');
    expect(text).toContain('Signature: Signed ' + new Date(signed.signed_at as string).toLocaleString());
    expect(text).toContain('Signature hash: abc123');
    expect(text).toContain('(sess_abc)');
    expect(text).toContain('Follow up <next week>');
  });

  it('falls back to the client id and marks drafts unsigned', () => {
    const draft: CareNoteRow = {
      ...signed,
      status: 'draft',
      signed_at: null,
      sign_hash: null,
      seed_source: null,
      seed_model: null,
    };
    const text = noteToPlainText(draft);
    expect(text).toContain('Client: #7');
    expect(text).toContain('Signature: Draft - unsigned');
    expect(text).not.toContain('Signature hash');
    expect(text).not.toContain('Provenance');
  });

  it('uses the case-note field order for case notes', () => {
    const caseNote: CareNoteRow = {
      ...signed,
      note_type: 'case',
      case_note_kind: 'safety_check',
      content: { outcome: 'Scheduled', narrative: 'Called client', contact_method: 'phone' },
    };
    const text = noteToPlainText(caseNote);
    expect(text.startsWith('CASE NOTE - SAFETY CHECK')).toBe(true);
    expect(text.indexOf('NARRATIVE')).toBeLessThan(text.indexOf('CONTACT METHOD'));
    expect(text.indexOf('CONTACT METHOD')).toBeLessThan(text.indexOf('OUTCOME'));
  });
});

describe('noteToPrintableHtml', () => {
  it('escapes content and carries the header fields', () => {
    const html = noteToPrintableHtml(signed, { clientLabel: 'client-007' });
    expect(html).toContain('Follow up &lt;next week&gt;');
    expect(html).not.toContain('<next week>');
    expect(html).toContain('<th>Client</th><td>client-007</td>');
    expect(html).toContain('<th>Clinician</th><td>Dr. Example (therapist)</td>');
    expect(html).toContain('<h2>Subjective</h2>');
    expect(html).toContain('@media print');
    expect(html).not.toContain('class="banner"');
  });

  it('banners a draft so an unsigned print is never mistaken for a record', () => {
    const html = noteToPrintableHtml({ ...signed, status: 'draft', signed_at: null });
    expect(html).toContain('DRAFT - not signed');
  });
});

describe('signatureState / header lines', () => {
  it('distinguishes amended from signed and includes the amends link', () => {
    expect(signatureState({ ...signed, status: 'amended' })).toBe('Signed, superseded by amendment');
    const lines = noteHeaderLines({ ...signed, amends_note_id: 41 });
    expect(lines).toContainEqual(['Amends', 'note #41']);
  });
});
