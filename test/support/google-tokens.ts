import {
  type CryptoKey,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose';

import { GoogleTokenVerifier } from '../../lambda/auth/google-id-token';

export const WEB_CLIENT_ID = 'web-client.apps.googleusercontent.com';
export const GOOGLE_SUB = '108234567890123456789';

/** Signs tokens like Google does, with a key pair made for the test. */
export class FakeGoogle {
  private constructor(
    private readonly privateKey: CryptoKey,
    readonly keys: JWTVerifyGetKey,
  ) {}

  static async create(): Promise<FakeGoogle> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };
    return new FakeGoogle(privateKey, createLocalJWKSet({ keys: [jwk] }));
  }

  verifier(): GoogleTokenVerifier {
    return new GoogleTokenVerifier({ audiences: [WEB_CLIENT_ID], keys: this.keys });
  }

  async idToken(
    overrides: {
      sub?: string;
      audience?: string;
      issuer?: string;
      email?: string;
      emailVerified?: boolean;
      issuedSecondsAgo?: number;
      privateKey?: CryptoKey;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = now - (overrides.issuedSecondsAgo ?? 10);

    return new SignJWT({
      email: overrides.email ?? 'gardener@example.com',
      email_verified: overrides.emailVerified ?? true,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(overrides.sub ?? GOOGLE_SUB)
      .setAudience(overrides.audience ?? WEB_CLIENT_ID)
      .setIssuer(overrides.issuer ?? 'https://accounts.google.com')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(overrides.privateKey ?? this.privateKey);
  }
}
