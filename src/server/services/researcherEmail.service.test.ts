import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getUserByIdMock, setUserEmailMock, findUserByEmailMock } = vi.hoisted(() => ({
  getUserByIdMock: vi.fn(),
  setUserEmailMock: vi.fn(),
  findUserByEmailMock: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  getUserById: getUserByIdMock,
  setUserEmail: setUserEmailMock,
  findUserByEmail: findUserByEmailMock,
}));

import {
  studyAddressSlug,
  isValidEmailAddress,
  setAccountEmail,
  provisionStudyAddress,
  EmailAccountError,
} from './researcherEmail.service.js';

beforeEach(() => {
  getUserByIdMock.mockReset();
  findUserByEmailMock.mockReset().mockResolvedValue(null);
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
  it('rejects an address held by another account', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'ra', role: 'researcher' });
    findUserByEmailMock.mockResolvedValue({ userid: 9, username: 'other', role: 'therapist' });
    await expect(setAccountEmail(3, 'ra@byuisresearch.com')).rejects.toMatchObject({ status: 409 });
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
  it('steps to the next suffix when the slug is taken', async () => {
    getUserByIdMock.mockResolvedValue({ userid: 3, username: 'jane', role: 'therapist' });
    findUserByEmailMock.mockImplementation(async (addr: string) =>
      addr === 'jane@byuisresearch.com' ? { userid: 1, username: 'jane1', role: 'researcher' } : null,
    );
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
