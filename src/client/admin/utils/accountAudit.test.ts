import { describe, it, expect } from 'vitest';
import { auditActionLabel, auditActorText, auditDetailText } from './accountAudit';

describe('account audit wording', () => {
  it('names every action the server records, and passes an unknown one through', () => {
    for (const a of [
      'account_created',
      'account_deleted',
      'role_changed',
      'password_changed',
      'username_changed',
      'email_changed',
      'authenticator_reset',
    ]) {
      expect(auditActionLabel(a)).not.toBe(a);
    }
    expect(auditActionLabel('something_new')).toBe('something_new');
  });

  it('says what changed', () => {
    expect(auditDetailText({ action: 'role_changed', detail: { from: 'participant', to: 'therapist' } })).toBe(
      'participant to therapist',
    );
    expect(auditDetailText({ action: 'username_changed', detail: { from: 'a', to: 'b', self: true } })).toBe('a to b');
    expect(
      auditDetailText({ action: 'account_created', detail: { role: 'participant', via: 'user_management' } }),
    ).toBe('participant, via User Management');
    expect(auditDetailText({ action: 'account_deleted', detail: { role: 'therapist' } })).toBe('therapist');
    expect(
      auditDetailText({ action: 'account_deleted', detail: { role: 'therapist', signInServiceRemoved: false } }),
    ).toContain('could not be removed');
    expect(auditDetailText({ action: 'password_changed', detail: { self: true } })).toBe('by the account holder');
    expect(auditDetailText({ action: 'password_changed', detail: {} })).toBe('');
    expect(auditDetailText({ action: 'email_changed', detail: { set: true } })).toBe('address set');
    expect(auditDetailText({ action: 'email_changed', detail: { set: false } })).toBe('address cleared');
    expect(auditDetailText({ action: 'email_changed', detail: { set: true, provisioned: true } })).toBe(
      'study address provisioned',
    );
    expect(auditDetailText({ action: 'authenticator_reset', detail: { role: 'caseworker' } })).toBe('caseworker');
  });

  it('shows nothing for a detail it does not understand', () => {
    expect(auditDetailText({ action: 'role_changed', detail: null })).toBe('');
    expect(auditDetailText({ action: 'role_changed', detail: { from: 1, to: {} } })).toBe('');
    expect(auditDetailText({ action: 'something_new', detail: { secret: 'x' } })).toBe('');
  });

  it('names the actor, or says it is unknown', () => {
    expect(auditActorText({ actor_username: 'r1', actor_user_id: 1 })).toBe('r1');
    expect(auditActorText({ actor_username: null, actor_user_id: 7 })).toBe('user 7');
    expect(auditActorText({ actor_username: null, actor_user_id: null })).toBe('unknown');
  });
});
