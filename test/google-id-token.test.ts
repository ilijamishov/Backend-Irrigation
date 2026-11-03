import { generateKeyPair } from 'jose';

import {
  GoogleTokenVerifier,
  InvalidGoogleTokenError,
  verifierFromEnvironment,
} from '../lambda/auth/google-id-token';
import { FakeGoogle, GOOGLE_SUB } from './support/google-tokens';

describe('Google ID token check', () => {
  let google: FakeGoogle;
  let verifier: GoogleTokenVerifier;

  beforeAll(async () => {
    google = await FakeGoogle.create();
    verifier = google.verifier();
  });

  it('accepts a fresh token for the app and returns the Google user', async () => {
    const identity = await verifier.verify(await google.idToken());

    expect(identity).toEqual({ sub: GOOGLE_SUB, email: 'gardener@example.com' });
  });

  it('accepts the issuer without https', async () => {
    const token = await google.idToken({ issuer: 'accounts.google.com' });

    await expect(verifier.verify(token)).resolves.toMatchObject({ sub: GOOGLE_SUB });
  });

  it.each([
    ['for another app', { audience: 'other-app.apps.googleusercontent.com' }],
    ['from another issuer', { issuer: 'https://evil.example.com' }],
    ['issued more than 5 minutes ago', { issuedSecondsAgo: 6 * 60 }],
    ['with an unverified email', { emailVerified: false }],
  ])('refuses a token %s', async (_, overrides) => {
    const token = await google.idToken(overrides);

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidGoogleTokenError);
  });

  it('refuses a token signed with another key', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await google.idToken({ privateKey });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidGoogleTokenError);
  });

  it('refuses a missing or malformed token', async () => {
    await expect(verifier.verify('')).rejects.toBeInstanceOf(InvalidGoogleTokenError);
    await expect(verifier.verify('not-a-jwt')).rejects.toBeInstanceOf(
      InvalidGoogleTokenError,
    );
  });

  it('never puts the token into the error message', async () => {
    const token = await google.idToken({ audience: 'other-app' });

    const error = await verifier.verify(token).catch((e: Error) => e);

    expect(String(error)).not.toContain(token);
  });

  it('reads the client IDs from the environment and needs at least one', () => {
    expect(() =>
      verifierFromEnvironment({ GOOGLE_CLIENT_IDS: 'a.apps, b.apps' }),
    ).not.toThrow();
    expect(() => verifierFromEnvironment({})).toThrow(/client ID/);
  });
});
