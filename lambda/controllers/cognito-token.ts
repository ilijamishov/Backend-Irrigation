import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** The user a valid token belongs to, and when it stops being valid. */
export interface TokenIdentity {
  /** Cognito's stable user ID. */
  readonly userId: string;
  /** In seconds since 1970. */
  readonly expiresAt: number;
}

export interface CognitoTokenVerifierOptions {
  readonly region: string;
  readonly userPoolId: string;
  readonly appClientId: string;
  /** Overrides Cognito's keys, for tests. */
  readonly keys?: JWTVerifyGetKey;
}

/** Checks a Cognito access token: signature, issuer, app client, expiry. */
export class CognitoTokenVerifier {
  private readonly issuer: string;
  private readonly appClientId: string;
  private readonly keys: JWTVerifyGetKey;

  constructor(options: CognitoTokenVerifierOptions) {
    this.issuer = `https://cognito-idp.${options.region}.amazonaws.com/${options.userPoolId}`;
    this.appClientId = options.appClientId;
    this.keys =
      options.keys ?? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  /** Returns null for anything but a valid access token of this app. */
  async verify(token: string): Promise<TokenIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        algorithms: ['RS256'],
      });

      if (
        payload.token_use !== 'access' ||
        payload.client_id !== this.appClientId ||
        typeof payload.sub !== 'string' ||
        payload.sub.length === 0 ||
        typeof payload.exp !== 'number'
      ) {
        return null;
      }

      return { userId: payload.sub, expiresAt: payload.exp };
    } catch {
      return null;
    }
  }
}
