import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getUserByIdMock, setUserEmailMock, findUserByEmailMock, listEmailsWithPrefixMock } = vi.hoisted(() => ({
  getUserByIdMock: vi.fn(),
  setUserEmailMock: vi.fn(),
  findUserByEmailMock: vi.fn(),
  listEmailsWithPrefixMock: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  getUserById: getUserByIdMock,
  setUserEmail: setUserEmailMock,
  findUserByEmail: findUserByEmailMock,
  listEmailsWithPrefix: listEmailsWithPrefixMock,
}));

import {
  studyAddressSlug,
  isValidEmailAddress,
  setAccountEmail,
  validateAccountEmail,
  clearEmailIfIneligible,
  provisionStudyAddress,
  EmailAccountError,
} from './researcherEmail.service.js';

beforeEach(() => {
  getUserByIdMock.mockReset();
  findUserByEmailMock.mockReset().mockResolvedValue(null);
  listEmailsWithPrefixMock.mockReset().mockResolvedValue([]);
  setUserEmailMock.mockReset().mockImplementation(async (userid: number, email: string | null) => ({
    userid,
    username: 'x',
    role: 'researcher',
    email,
  }));
  delete process.env.STUDY_EMAIL_DOMAIN;
});

describe('studyAddressSlug', () => {
  it('lower-cases, keeps dots and hyphens, collapses everything else', () => {
    expect(studyAddressSlug('Nathan Blatter')).toBe('nathan-blatter');
    expect(studyAddressSlug('j.gaskin')).toBe('j.gaskin');
    expect(studyAddressSlug('ra_2026!!')).toBe('ra-2026');
  });
  it('never leaves consecutive dots or dot/hyphen runs (dot-atom rule)', () => {
    expect(studyAddressSlug('j..gaskin')).toBe('j-gaskin');
    expect(studyAddressSlug('ra_.x')).toBe('ra-x');
  });
  it('reduces an email-shaped username to its local part', () => {
    expect(studyAddressSlug('cw@example.com')).toBe('cw');
  });
  it('never returns an empty or dangling slug', () => {
    expect(studyAddressSlug('---')).toBe('user');
    expect(studyAddressSlug('.hidden.')).toBe('hidden');
    expect(studyAddressSlug('a'.repeat(60)).length).toBe(40);
  });
});

describe('isValidEmailAddress', () => {
  it('accepts a plain address and rejects junk', () => {
    expect(isValidEmailAddress('r@byuisresearch.com')).toBe(true);
    expect(isValidEmailAddress('not an email')).toBe(false);
    expect(isValidEmailAddress('a@b')).toBe(false);
  });
});

describe('setAccountEmail', () => {
  it('refuses participants no matter who asks (anonymity)', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 7, username: 'p7', role: 'participant' });
    await expect(setAccountEmail(7, 'p7@example.com')).rejects.toMatchObject({ status: 403 });
    expect(setUserEmailMock).not.toHaveBeenCalled();
  });
  it('normalizes, checks uniqueness, and writes', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'ra', role: 'researcher' });
    const row = await setAccountEmail(3, '  RA@BYUisResearch.com ');
    expect(setUserEmailMock).toHaveBeenCalledWith(3, 'ra@byuisresearch.com');
    expect(row.email).toBe('ra@byuisresearch.com');
  });
  it('rejects an address held by another account, including a lost write race', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'ra', role: 'researcher' });
    findUserByEmailMock.mockResolvedValue({ userid: 9, username: 'other', role: 'therapist' });
    await expect(setAccountEmail(3, 'ra@byuisresearch.com')).rejects.toMatchObject({ status: 409 });
    findUserByEmailMock.mockResolvedValue(null);
    setUserEmailMock.mockRejectedValueOnce(new Error('Email already in use'));
    await expect(setAccountEmail(3, 'ra@byuisresearch.com')).rejects.toMatchObject({ status: 409 });
  });
  it('validateAccountEmail judges eligibility against the role the edit will leave', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'cw', role: 'caseworker' });
    await expect(validateAccountEmail(3, 'cw@byuisresearch.com', 'participant')).rejects.toMatchObject({ status: 403 });
    expect((await validateAccountEmail(3, 'CW@byuisresearch.com', 'therapist')).email).toBe('cw@byuisresearch.com');
    expect((await validateAccountEmail(3, null, 'participant')).email).toBeNull();
  });
  it('clearEmailIfIneligible drops the address only when the new role is not staff', async () => {
    await clearEmailIfIneligible(3, 'participant');
    expect(setUserEmailMock).toHaveBeenCalledWith(3, null);
    setUserEmailMock.mockClear();
    await clearEmailIfIneligible(3, 'therapist');
    expect(setUserEmailMock).not.toHaveBeenCalled();
  });
  it('clears with null and 404s on a missing account', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'ra', role: 'therapist', email: 'x@y.com' });
    await setAccountEmail(3, null);
    expect(setUserEmailMock).toHaveBeenCalledWith(3, null);
    getUserByIdMock.mockResolvedValue(null);
    await expect(setAccountEmail(99, null)).rejects.toBeInstanceOf(EmailAccountError);
  });
});

describe('provisionStudyAddress', () => {
  it('assigns <slug>@byuisresearch.com', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'Jane Doe', role: 'researcher' });
    const { address } = await provisionStudyAddress(3);
    expect(address).toBe('jane-doe@byuisresearch.com');
    expect(setUserEmailMock).toHaveBeenCalledWith(3, 'jane-doe@byuisresearch.com');
  });
  it('is idempotent for an account already on the study domain', async () => {
    getUserByIdMock.mockResolvedValue({
      userid: 3,
      username: 'jane',
      role: 'researcher',
      email: 'Jane@byuisresearch.com',
    });
    const { address } = await provisionStudyAddress(3);
    expect(address).toBe('jane@byuisresearch.com');
    expect(setUserEmailMock).not.toHaveBeenCalled();
  });
  it('steps to the first free suffix from one lookup', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'jane', role: 'therapist' });
    listEmailsWithPrefixMock.mockResolvedValue(['jane@byuisresearch.com', 'Jane-2@byuisresearch.com']);
    const { address } = await provisionStudyAddress(3);
    expect(address).toBe('jane-3@byuisresearch.com');
    expect(listEmailsWithPrefixMock).toHaveBeenCalledWith('jane', 'byuisresearch.com');
  });
  it('re-reads after losing a write race', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'jane', role: 'therapist' });
    listEmailsWithPrefixMock.mockResolvedValueOnce([]).mockResolvedValueOnce(['jane@byuisresearch.com']);
    setUserEmailMock
      .mockRejectedValueOnce(new Error('Email already in use'))
      .mockImplementationOnce(async (userid: number, email: string | null) => ({
        userid,
        username: 'jane',
        role: 'therapist',
        email,
      }));
    const { address } = await provisionStudyAddress(3);
    expect(address).toBe('jane-2@byuisresearch.com');
  });
  it('honours STUDY_EMAIL_DOMAIN and refuses participants', async () => {
    process.env.STUDY_EMAIL_DOMAIN = 'Example.org';
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'jane', role: 'caseworker' });
    expect((await provisionStudyAddress(3)).address).toBe('jane@example.org');
    getUserByIdMock.mockResolvedValue({ userid: 4, username: 'p', role: 'participant' });
    await expect(provisionStudyAddress(4)).rejects.toMatchObject({ status: 403 });
  });
});
