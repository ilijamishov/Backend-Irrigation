import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Google's public signing keys, cached by `jose` between invocations. */
const GOOGLE_KEYS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * A token issued longer ago than this is refused. `google_sign_in` can't bind
 * a nonce to each sign-in, so a short window limits the replay of a stolen
 * token.
 */
export const MAX_TOKEN_AGE_SECONDS = 5 * 60;

export interface GoogleIdentity {
  /** Google's stable user ID. */
  readonly sub: string;
  readonly email?: string;
}

export class InvalidGoogleTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid Google ID token: ${reason}`);
    this.name = 'InvalidGoogleTokenError';
  }
}

export interface GoogleTokenVerifierOptions {
  /** OAuth client IDs the token may be issued for (the web client ID). */
  readonly audiences: readonly string[];
  /** Overrides Google's keys, for tests. */
  readonly keys?: JWTVerifyGetKey;
}

/** Checks a Google ID token: signature, issuer, audience, age, email. */
export class GoogleTokenVerifier {
  private readonly audiences: string[];
  private readonly keys: JWTVerifyGetKey;

  constructor(options: GoogleTokenVerifierOptions) {
    if (options.audiences.length === 0) {
      throw new Error('At least one Google client ID is required.');
    }
    this.audiences = [...options.audiences];
    this.keys = options.keys ?? createRemoteJWKSet(GOOGLE_KEYS_URL);
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!idToken) throw new InvalidGoogleTokenError('missing');

    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.keys, {
        issuer: GOOGLE_ISSUERS,
        audience: this.audiences,
        maxTokenAge: MAX_TOKEN_AGE_SECONDS,
        algorithms: ['RS256'],
      }));
    } catch (error) {
      // Only the reason's class goes into the message, never the token.
      const reason = error instanceof Error ? error.name : 'unknown';
      throw new InvalidGoogleTokenError(reason);
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new InvalidGoogleTokenError('no subject');
    }

    const email = typeof payload.email === 'string' ? payload.email : undefined;
    if (email !== undefined && payload.email_verified !== true) {
      throw new InvalidGoogleTokenError('email not verified');
    }

    return { sub: payload.sub, email };
  }
}

/** Reads the allowed client IDs from `GOOGLE_CLIENT_IDS` (comma-separated). */
export function verifierFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GoogleTokenVerifier {
  const audiences = (environment.GOOGLE_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return new GoogleTokenVerifier({ audiences });
}
