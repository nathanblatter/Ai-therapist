// Account lifecycle against the sign-in provider (auth-service-33 Squawk,
// ai-therapist-396 Cognito): which provider is written, in what order, and
// what a provider failure leaves behind. The db, both providers and the pool
// admin client are mocked: no database, no network.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  getUserById: vi.fn(),
  setSquawkUserId: vi.fn(),
  getSquawkUserId: vi.fn(),
  setCognitoSub: vi.fn(),
  replaceCognitoSub: vi.fn(),
  setCognitoTotpEnrolledAt: vi.fn(),
  getUserByUsernameForCognito: vi.fn(),
  deleteSessionsForUser: vi.fn(),
}));
vi.mock('../db/index.js', () => db);

const squawk = vi.hoisted(() => {
  class SquawkError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
    ) {
      super(`squawk ${status} ${code}`);
    }
  }
  return {
    SquawkError,
    enabled: vi.fn(() => false),
    createPasswordUser: vi.fn(),
    setPassword: vi.fn(),
    setRole: vi.fn(),
    deleteUser: vi.fn(),
  };
});
vi.mock('./squawk.service.js', () => squawk);

const cognito = vi.hoisted(() => ({ enabled: vi.fn(() => false) }));
vi.mock('./cognito.service.js', () => cognito);

const pool = vi.hoisted(() => {
  class CognitoAdminError extends Error {
    constructor(
      public readonly code: string,
      public readonly operation = 'Op',
      public readonly awsName = 'SomeException',
    ) {
      super(`cognito ${operation} ${awsName}`);
      this.name = 'CognitoAdminError';
    }
  }
  return {
    CognitoAdminError,
    createUser: vi.fn(),
    setPassword: vi.fn(),
    setRole: vi.fn(),
    deleteUser: vi.fn(),
    getUserSub: vi.fn(),
    setTotpEnabled: vi.fn(),
    globalSignOut: vi.fn(),
  };
});
vi.mock('./cognitoAdmin.service.js', () => pool);

const email = vi.hoisted(() => ({ clearEmailIfIneligible: vi.fn() }));
vi.mock('./researcherEmail.service.js', () => email);

const {
  registerAccount,
  updateAccount,
  removeAccount,
  resetAuthenticator,
  PASSWORD_REJECTED_MESSAGE,
  NOT_IN_POOL_MESSAGE,
} = await import('./accounts.service.js');

const ROW = { userid: 7, username: 'p_one', role: 'participant' };

function expectNoPoolCalls(): void {
  expect(pool.createUser).not.toHaveBeenCalled();
  expect(pool.setPassword).not.toHaveBeenCalled();
  expect(pool.setRole).not.toHaveBeenCalled();
  expect(pool.deleteUser).not.toHaveBeenCalled();
}

function expectNoSquawkCalls(): void {
  expect(squawk.createPasswordUser).not.toHaveBeenCalled();
  expect(squawk.setPassword).not.toHaveBeenCalled();
  expect(squawk.setRole).not.toHaveBeenCalled();
  expect(squawk.deleteUser).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  cognito.enabled.mockReturnValue(false);
  squawk.enabled.mockReturnValue(false);
  db.createUser.mockResolvedValue({ ...ROW });
  db.updateUser.mockResolvedValue({ ...ROW });
  db.deleteUser.mockResolvedValue({ userid: 7, username: 'p_one' });
  db.getUserById.mockResolvedValue({ ...ROW });
  db.setCognitoSub.mockResolvedValue(undefined);
  db.replaceCognitoSub.mockResolvedValue(undefined);
  db.setCognitoTotpEnrolledAt.mockResolvedValue(undefined);
  db.getUserByUsernameForCognito.mockResolvedValue(null);
  db.deleteSessionsForUser.mockResolvedValue(0);
  pool.getUserSub.mockResolvedValue(null);
  pool.globalSignOut.mockResolvedValue(undefined);
  db.setSquawkUserId.mockResolvedValue(undefined);
  db.getSquawkUserId.mockResolvedValue(null);
  email.clearEmailIfIneligible.mockResolvedValue(undefined);
  pool.createUser.mockResolvedValue({ sub: 'sub-123' });
  pool.setPassword.mockResolvedValue(undefined);
  pool.setRole.mockResolvedValue(undefined);
  pool.deleteUser.mockResolvedValue(undefined);
});

describe('no provider configured', () => {
  it('only writes the local row', async () => {
    await expect(registerAccount('p_one', 'a long passphrase', 'participant')).resolves.toEqual(ROW);
    await updateAccount(7, { password: 'another passphrase', role: 'therapist', username: 'renamed' });
    await removeAccount(7);
    expect(db.createUser).toHaveBeenCalledWith('p_one', 'a long passphrase', 'participant');
    expect(db.updateUser).toHaveBeenCalledTimes(1);
    expect(db.deleteUser).toHaveBeenCalledTimes(1);
    // One read, for the role comparison that decides whether sessions end
    // (getUserById selects no provider column, so it is safe on a database
    // without migrations 106, 129 or 131). An update that sends no role reads nothing.
    expect(db.getUserById).toHaveBeenCalledTimes(1);
    db.getUserById.mockClear();
    await updateAccount(7, { password: 'another passphrase' });
    expect(db.getUserById).not.toHaveBeenCalled();
    // The Squawk link column does not exist on a legacy-mode database.
    expect(db.getSquawkUserId).not.toHaveBeenCalled();
    expectNoPoolCalls();
    expectNoSquawkCalls();
  });
});

describe('Cognito configured', () => {
  beforeEach(() => cognito.enabled.mockReturnValue(true));

  describe('registerAccount', () => {
    it('writes the row, then the pool user, then the subject', async () => {
      const order: string[] = [];
      db.createUser.mockImplementation(async () => {
        order.push('row');
        return { ...ROW };
      });
      pool.createUser.mockImplementation(async () => {
        order.push('pool');
        return { sub: 'sub-123' };
      });
      const user = await registerAccount('p_one', 'a long passphrase', 'participant', { orgId: 3 });
      expect(order).toEqual(['row', 'pool']);
      expect(db.createUser).toHaveBeenCalledWith('p_one', 'a long passphrase', 'participant', { orgId: 3 });
      expect(pool.createUser).toHaveBeenCalledWith('p_one', 'a long passphrase', 'participant');
      expect(db.setCognitoSub).toHaveBeenCalledWith(7, 'sub-123');
      expect(user).toEqual({ ...ROW, cognito_sub: 'sub-123' });
      expect(db.deleteUser).not.toHaveBeenCalled();
    });

    it('rolls the row back and says the username is taken when the pool has it', async () => {
      pool.createUser.mockRejectedValue(new pool.CognitoAdminError('username_taken'));
      const err = await registerAccount('p_one', 'a long passphrase', 'participant').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('Username already exists');
      expect((err as Error).name).toBe('Error');
      expect(db.deleteUser).toHaveBeenCalledWith(7);
      expect(db.setCognitoSub).not.toHaveBeenCalled();
    });

    it('rolls the row back with a clean error when the pool refuses the password', async () => {
      pool.createUser.mockRejectedValue(new pool.CognitoAdminError('password_rejected'));
      await expect(registerAccount('p_one', 'a long passphrase', 'participant')).rejects.toMatchObject({
        name: 'AccountSyncError',
        code: 'password_rejected',
        message: PASSWORD_REJECTED_MESSAGE,
      });
      expect(db.deleteUser).toHaveBeenCalledWith(7);
    });

    it('rolls the row back on any other pool failure', async () => {
      pool.createUser.mockRejectedValue(new pool.CognitoAdminError('failed'));
      await expect(registerAccount('p_one', 'a long passphrase', 'participant')).rejects.toMatchObject({
        name: 'AccountSyncError',
        message: 'Sign-in service rejected the new account',
        code: undefined,
      });
      expect(db.deleteUser).toHaveBeenCalledWith(7);
    });

    it('still surfaces the pool failure when the local rollback fails too', async () => {
      pool.createUser.mockRejectedValue(new Error('socket hang up'));
      db.deleteUser.mockRejectedValue(new Error('db down'));
      await expect(registerAccount('p_one', 'a long passphrase', 'participant')).rejects.toMatchObject({
        name: 'AccountSyncError',
      });
    });

    it('does not call the pool when the local row cannot be created', async () => {
      db.createUser.mockRejectedValue(new Error('Username already exists'));
      await expect(registerAccount('p_one', 'a long passphrase', 'participant')).rejects.toThrow(
        'Username already exists',
      );
      expectNoPoolCalls();
    });

    it('keeps the finished account when the subject is missing or cannot be stored', async () => {
      pool.createUser.mockResolvedValueOnce({ sub: null });
      await expect(registerAccount('p_one', 'a long passphrase', 'participant')).resolves.toEqual(ROW);
      expect(db.setCognitoSub).not.toHaveBeenCalled();

      db.setCognitoSub.mockRejectedValue(new Error('db down'));
      await expect(registerAccount('p_one', 'a long passphrase', 'participant')).resolves.toEqual(ROW);
      expect(db.deleteUser).not.toHaveBeenCalled();
      expect(pool.deleteUser).not.toHaveBeenCalled();
    });
  });

  describe('updateAccount', () => {
    it('writes the row, then the password, then the role, by username', async () => {
      const order: string[] = [];
      db.updateUser.mockImplementation(async () => {
        order.push('row');
        return { ...ROW, role: 'therapist' };
      });
      pool.setPassword.mockImplementation(async () => void order.push('password'));
      pool.setRole.mockImplementation(async () => void order.push('role'));
      const updated = await updateAccount(7, { password: 'another passphrase', role: 'therapist' });
      expect(order).toEqual(['row', 'password', 'role']);
      expect(pool.setPassword).toHaveBeenCalledWith('p_one', 'another passphrase');
      expect(pool.setRole).toHaveBeenCalledWith('p_one', 'therapist');
      expect(email.clearEmailIfIneligible).toHaveBeenCalledWith(7, 'therapist');
      expect(updated.role).toBe('therapist');
    });

    it('mirrors only what changed', async () => {
      await updateAccount(7, { role: 'researcher' });
      expect(pool.setRole).toHaveBeenCalledWith('p_one', 'researcher');
      expect(pool.setPassword).not.toHaveBeenCalled();
    });

    it('refuses a rename before anything is written', async () => {
      await expect(updateAccount(7, { username: 'renamed' })).rejects.toThrow('Username cannot be changed');
      expect(db.updateUser).not.toHaveBeenCalled();
      expectNoPoolCalls();
    });

    it('lets an unchanged username through without a pool call', async () => {
      await updateAccount(7, { username: 'p_one' });
      expect(db.updateUser).toHaveBeenCalledTimes(1);
      expectNoPoolCalls();
    });

    it('surfaces a pool failure and leaves the local change in place', async () => {
      pool.setRole.mockRejectedValue(new pool.CognitoAdminError('failed'));
      await expect(updateAccount(7, { role: 'therapist' })).rejects.toMatchObject({
        name: 'AccountSyncError',
        message: 'Sign-in service rejected the change',
      });
      expect(db.updateUser).toHaveBeenCalledTimes(1);
      expect(db.deleteUser).not.toHaveBeenCalled();
    });

    it('does not change the role in the pool when the password was refused', async () => {
      pool.setPassword.mockRejectedValue(new pool.CognitoAdminError('password_rejected'));
      await expect(updateAccount(7, { password: 'another passphrase', role: 'therapist' })).rejects.toMatchObject({
        name: 'AccountSyncError',
        code: 'password_rejected',
        message: PASSWORD_REJECTED_MESSAGE,
      });
      expect(pool.setRole).not.toHaveBeenCalled();
    });

    describe('an account the pool does not have', () => {
      beforeEach(() => {
        pool.setPassword.mockRejectedValue(new pool.CognitoAdminError('user_not_found'));
        pool.setRole.mockRejectedValue(new pool.CognitoAdminError('user_not_found'));
      });

      it("a new password moves it into the pool with the row's role and links the row", async () => {
        db.updateUser.mockResolvedValue({ ...ROW, role: 'therapist', cognito_sub: 'stale-sub' });
        const updated = await updateAccount(7, { password: 'another passphrase' });
        expect(pool.createUser).toHaveBeenCalledWith('p_one', 'another passphrase', 'therapist');
        expect(db.replaceCognitoSub).toHaveBeenCalledWith(7, 'sub-123');
        expect(updated.cognito_sub).toBe('sub-123');
        // Created with its role: no separate role call, and the row is kept.
        expect(pool.setRole).not.toHaveBeenCalled();
        expect(db.deleteUser).not.toHaveBeenCalled();
      });

      it('a new password and a new role together create it with the new role', async () => {
        db.updateUser.mockResolvedValue({ ...ROW, role: 'researcher' });
        await updateAccount(7, { password: 'another passphrase', role: 'researcher' });
        expect(pool.createUser).toHaveBeenCalledWith('p_one', 'another passphrase', 'researcher');
        expect(pool.setRole).not.toHaveBeenCalled();
      });

      it('a role change alone cannot move it: says how to', async () => {
        await expect(updateAccount(7, { role: 'therapist' })).rejects.toMatchObject({
          name: 'AccountSyncError',
          message: NOT_IN_POOL_MESSAGE,
        });
        expect(pool.createUser).not.toHaveBeenCalled();
      });

      it('a refused password or a failed creation is surfaced, and the row is kept', async () => {
        pool.createUser.mockRejectedValueOnce(new pool.CognitoAdminError('password_rejected'));
        await expect(updateAccount(7, { password: 'another passphrase' })).rejects.toMatchObject({
          code: 'password_rejected',
        });
        pool.createUser.mockRejectedValueOnce(new pool.CognitoAdminError('failed'));
        await expect(updateAccount(7, { password: 'another passphrase' })).rejects.toMatchObject({
          name: 'AccountSyncError',
          message: 'Sign-in service rejected the change',
        });
        expect(db.deleteUser).not.toHaveBeenCalled();
        expect(db.replaceCognitoSub).not.toHaveBeenCalled();
      });

      it('keeps the account when the link cannot be stored (the first sign-in links by username)', async () => {
        db.replaceCognitoSub.mockRejectedValue(new Error('db down'));
        await expect(updateAccount(7, { password: 'another passphrase' })).resolves.toMatchObject({ userid: 7 });
      });
    });

    it('does not call the pool when the row does not exist', async () => {
      db.getUserById.mockResolvedValue(null);
      db.updateUser.mockRejectedValue(new Error('User not found'));
      await expect(updateAccount(99, { role: 'therapist' })).rejects.toThrow('User not found');
      expectNoPoolCalls();
    });
  });

  describe('removeAccount', () => {
    it('deletes the row, then the pool user by username', async () => {
      const order: string[] = [];
      db.deleteUser.mockImplementation(async () => {
        order.push('row');
        return { userid: 7, username: 'p_one' };
      });
      pool.deleteUser.mockImplementation(async () => void order.push('pool'));
      await expect(removeAccount(7)).resolves.toEqual({ userid: 7, username: 'p_one' });
      expect(order).toEqual(['row', 'pool']);
      expect(pool.deleteUser).toHaveBeenCalledWith('p_one');
    });

    it('treats an account the pool never had as deleted', async () => {
      pool.deleteUser.mockRejectedValue(new pool.CognitoAdminError('user_not_found'));
      await expect(removeAccount(7)).resolves.toEqual({ userid: 7, username: 'p_one' });
    });

    it('surfaces a pool failure; the row is already gone', async () => {
      pool.deleteUser.mockRejectedValue(new pool.CognitoAdminError('failed'));
      await expect(removeAccount(7)).rejects.toMatchObject({ name: 'AccountSyncError' });
      expect(db.deleteUser).toHaveBeenCalledWith(7);
    });

    it('does not call the pool when the row does not exist', async () => {
      db.deleteUser.mockRejectedValue(new Error('User not found'));
      await expect(removeAccount(99)).rejects.toThrow('User not found');
      expectNoPoolCalls();
    });
  });
});

describe('resetAuthenticator', () => {
  const STAFF = { userid: 7, username: 'dr_one', role: 'therapist' };
  beforeEach(() => {
    db.getUserById.mockResolvedValue({ ...STAFF });
    pool.setTotpEnabled.mockResolvedValue(undefined);
  });

  it('switches the challenge off, forgets the enrolment, revokes pool tokens and ends app sessions', async () => {
    cognito.enabled.mockReturnValue(true);
    await expect(resetAuthenticator(7)).resolves.toMatchObject({ userid: 7, username: 'dr_one' });
    expect(pool.setTotpEnabled).toHaveBeenCalledWith('dr_one', false);
    expect(db.setCognitoTotpEnrolledAt).toHaveBeenCalledWith(7, null);
    expect(pool.globalSignOut).toHaveBeenCalledWith('dr_one');
    expect(db.deleteSessionsForUser).toHaveBeenCalledWith(7);
  });

  it('is refused for an account that is not staff, before the pool is touched', async () => {
    cognito.enabled.mockReturnValue(true);
    db.getUserById.mockResolvedValue({ ...ROW });
    await expect(resetAuthenticator(7)).rejects.toMatchObject({ name: 'AccountSyncError', code: 'not_staff' });
    expect(pool.setTotpEnabled).not.toHaveBeenCalled();
    expect(db.deleteSessionsForUser).not.toHaveBeenCalled();
  });

  it('is refused when Cognito is not the provider', async () => {
    await expect(resetAuthenticator(7)).rejects.toMatchObject({ name: 'AccountSyncError' });
    squawk.enabled.mockReturnValue(true);
    await expect(resetAuthenticator(7)).rejects.toMatchObject({ name: 'AccountSyncError' });
    expect(pool.setTotpEnabled).not.toHaveBeenCalled();
  });

  it('reports an unknown account, an account the pool does not have, and a pool failure', async () => {
    cognito.enabled.mockReturnValue(true);
    db.getUserById.mockResolvedValueOnce(null);
    await expect(resetAuthenticator(99)).rejects.toThrow('User not found');
    pool.setTotpEnabled.mockRejectedValueOnce(new pool.CognitoAdminError('user_not_found'));
    await expect(resetAuthenticator(7)).rejects.toThrow(NOT_IN_POOL_MESSAGE);
    pool.setTotpEnabled.mockRejectedValueOnce(new pool.CognitoAdminError('failed'));
    await expect(resetAuthenticator(7)).rejects.toMatchObject({ name: 'AccountSyncError' });
    // Nothing after the failed pool call ran.
    expect(db.deleteSessionsForUser).not.toHaveBeenCalled();
  });

  it('a failure after the reset (token revocation, session cleanup) does not undo or fail it', async () => {
    cognito.enabled.mockReturnValue(true);
    pool.globalSignOut.mockRejectedValue(new pool.CognitoAdminError('failed'));
    db.deleteSessionsForUser.mockRejectedValue(new Error('db down'));
    db.setCognitoTotpEnrolledAt.mockRejectedValue(new Error('db down'));
    await expect(resetAuthenticator(7)).resolves.toMatchObject({ userid: 7 });
  });
});

describe('app sessions end with the account change that outdates them (review C5)', () => {
  const modes: [string, () => void][] = [
    ['no provider', () => {}],
    ['Cognito', () => cognito.enabled.mockReturnValue(true)],
  ];

  it.each(modes)("a role change ends the account's sessions (%s)", async (_label, setUp) => {
    setUp();
    db.updateUser.mockResolvedValue({ ...ROW, role: 'therapist' });
    await updateAccount(7, { role: 'therapist' });
    expect(db.deleteSessionsForUser).toHaveBeenCalledWith(7);
  });

  // The User Management form sends the role with every save. Ending sessions
  // whenever a role was SENT signed a researcher out for fixing their own
  // email, and a participant out mid-session for a corrected username.
  it.each(modes)('saving the same role again ends nothing (%s)', async (_label, setUp) => {
    setUp();
    await updateAccount(7, { username: 'p_one', role: 'participant' });
    await updateAccount(7, { role: 'participant', password: 'another passphrase' });
    expect(db.deleteSessionsForUser).not.toHaveBeenCalled();
  });

  it.each(modes)("a deletion ends the account's sessions (%s)", async (_label, setUp) => {
    setUp();
    await removeAccount('07');
    // By the row's id, not the route parameter: "07" matches no stored session.
    expect(db.deleteSessionsForUser).toHaveBeenCalledWith(7);
  });

  it('a password change alone does not', async () => {
    cognito.enabled.mockReturnValue(true);
    await updateAccount(7, { password: 'another passphrase' });
    expect(db.deleteSessionsForUser).not.toHaveBeenCalled();
  });

  it('a failed session cleanup does not fail the change', async () => {
    db.deleteSessionsForUser.mockRejectedValue(new Error('db down'));
    db.updateUser.mockResolvedValue({ ...ROW, role: 'therapist' });
    await expect(updateAccount(7, { role: 'therapist' })).resolves.toMatchObject({ userid: 7 });
    await expect(removeAccount(7)).resolves.toMatchObject({ userid: 7 });
  });

  it("also closes the account's open sockets, which hold the role they connected with", async () => {
    const disconnectSockets = vi.fn();
    const inRoom = vi.fn(() => ({ disconnectSockets }));
    const g = globalThis as unknown as { io?: unknown };
    const before = g.io;
    g.io = { in: inRoom };
    try {
      db.updateUser.mockResolvedValue({ ...ROW, role: 'therapist' });
      await updateAccount(7, { role: 'therapist' });
      expect(inRoom).toHaveBeenCalledWith('user:7');
      expect(disconnectSockets).toHaveBeenCalledWith(true);
    } finally {
      g.io = before;
    }
  });
});

describe('the provider is told about a role only when it changed', () => {
  // The edit form sends the role with every save. A needless provider call
  // would fail every edit (and drop the email step after it) while the
  // provider is down.
  it('Squawk: same role sent again makes no role call; a new one does', async () => {
    squawk.enabled.mockReturnValue(true);
    db.getSquawkUserId.mockResolvedValue('sq-1');
    await updateAccount(7, { username: 'p_one', role: 'participant' });
    expect(squawk.setRole).not.toHaveBeenCalled();
    await updateAccount(7, { role: 'therapist' });
    expect(squawk.setRole).toHaveBeenCalledWith('sq-1', 'therapist');
  });

  it('Cognito: same role sent again makes no role call; a new one does', async () => {
    cognito.enabled.mockReturnValue(true);
    await updateAccount(7, { username: 'p_one', role: 'participant' });
    expect(pool.setRole).not.toHaveBeenCalled();
    await updateAccount(7, { role: 'therapist' });
    expect(pool.setRole).toHaveBeenCalledWith('p_one', 'therapist');
  });
});

describe('a pool user re-created under the same username (review C7)', () => {
  beforeEach(() => cognito.enabled.mockReturnValue(true));

  it('a password reset relinks the row to the new subject and forgets the old enrolment', async () => {
    pool.getUserSub.mockResolvedValue('sub-new');
    db.getUserByUsernameForCognito.mockResolvedValue({ ...ROW, cognito_sub: 'sub-old' });
    await updateAccount(7, { password: 'another passphrase' });
    expect(db.replaceCognitoSub).toHaveBeenCalledWith(7, 'sub-new');
    expect(db.setCognitoTotpEnrolledAt).toHaveBeenCalledWith(7, null);
  });

  it('leaves a row alone when the subject matches, or the pool reports none', async () => {
    pool.getUserSub.mockResolvedValue('sub-same');
    db.getUserByUsernameForCognito.mockResolvedValue({ ...ROW, cognito_sub: 'sub-same' });
    await updateAccount(7, { password: 'another passphrase' });
    pool.getUserSub.mockResolvedValue(null);
    await updateAccount(7, { password: 'another passphrase' });
    expect(db.replaceCognitoSub).not.toHaveBeenCalled();
  });

  it('a failed check does not fail the password change', async () => {
    pool.getUserSub.mockRejectedValue(new pool.CognitoAdminError('failed'));
    await expect(updateAccount(7, { password: 'another passphrase' })).resolves.toMatchObject({ userid: 7 });
  });
});

describe('both providers configured', () => {
  beforeEach(() => {
    cognito.enabled.mockReturnValue(true);
    squawk.enabled.mockReturnValue(true);
    db.getUserById.mockResolvedValue({ ...ROW, squawk_user_id: 'sq-1' });
  });

  it('mirrors to the pool only', async () => {
    await registerAccount('p_one', 'a long passphrase', 'participant');
    await updateAccount(7, { password: 'another passphrase', role: 'therapist' });
    await removeAccount(7);
    expect(pool.createUser).toHaveBeenCalledTimes(1);
    expect(pool.setPassword).toHaveBeenCalledTimes(1);
    expect(pool.setRole).toHaveBeenCalledTimes(1);
    expect(pool.deleteUser).toHaveBeenCalledTimes(1);
    expect(db.setSquawkUserId).not.toHaveBeenCalled();
    expect(db.getSquawkUserId).not.toHaveBeenCalled();
    expectNoSquawkCalls();
  });
});

describe('only Squawk configured', () => {
  beforeEach(() => {
    squawk.enabled.mockReturnValue(true);
    // As in the real database layer: getUserById does not return the link
    // (it selects no provider column); the link has its own query. The tests
    // used to put squawk_user_id on the getUserById row, which hid that
    // nothing was ever mirrored (ai-therapist-408).
    db.getUserById.mockResolvedValue({ ...ROW });
    db.getSquawkUserId.mockResolvedValue('sq-1');
    squawk.createPasswordUser.mockResolvedValue({ id: 'sq-1' });
  });

  it('creates, updates and deletes in Squawk and never in the pool', async () => {
    const user = await registerAccount('p_one', 'a long passphrase', 'participant');
    expect(squawk.createPasswordUser).toHaveBeenCalledWith('p_one', 'a long passphrase', 'participant');
    expect(db.setSquawkUserId).toHaveBeenCalledWith(7, 'sq-1');
    expect(user).toEqual({ ...ROW, squawk_user_id: 'sq-1' });

    await updateAccount(7, { password: 'another passphrase', role: 'therapist' });
    expect(squawk.setPassword).toHaveBeenCalledWith('sq-1', 'another passphrase');
    expect(squawk.setRole).toHaveBeenCalledWith('sq-1', 'therapist');

    await removeAccount(7);
    expect(squawk.deleteUser).toHaveBeenCalledWith('sq-1');

    expect(db.setCognitoSub).not.toHaveBeenCalled();
    expectNoPoolCalls();
  });

  it('rolls the row back and maps a taken identity', async () => {
    squawk.createPasswordUser.mockRejectedValue(new squawk.SquawkError(409, 'identity_taken'));
    await expect(registerAccount('p_one', 'a long passphrase', 'participant')).rejects.toThrow(
      'Username already exists',
    );
    expect(db.deleteUser).toHaveBeenCalledWith(7);
  });

  it('an account with no Squawk link is changed locally only, and can be renamed', async () => {
    db.getSquawkUserId.mockResolvedValue(null);
    await updateAccount(7, { username: 'renamed', password: 'another passphrase', role: 'therapist' });
    await removeAccount(7);
    expectNoSquawkCalls();
  });

  it('refuses a rename of a linked account and swallows a failed Squawk delete', async () => {
    await expect(updateAccount(7, { username: 'renamed' })).rejects.toThrow('Username cannot be changed');
    squawk.deleteUser.mockRejectedValue(new squawk.SquawkError(500, 'server_error'));
    await expect(removeAccount(7)).resolves.toEqual({ userid: 7, username: 'p_one' });
  });
});
