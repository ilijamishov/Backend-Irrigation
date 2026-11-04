import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';

import {
  AccessPolicyBuilder,
  type ControllerAccess,
  MAX_POLICY_DOCUMENT_LENGTH,
  MAX_POLICY_DOCUMENTS,
} from '../lambda/controllers/access-policy';
import { CognitoTokenVerifier } from '../lambda/controllers/cognito-token';
import {
  createAuthorizerHandler,
  TOKEN_HEADER,
  type TokenChecker,
} from '../lambda/controllers/iot-authorizer';

const PREFIX = 'arn:aws:iot:us-east-1:123456789012:';
const USER = '0458f4a8-1234-5678-9abc-def012345678';
const OWNED = '1C8F57371AA4';
const MANAGED = 'AAAAAAAAAAAA';
const NOW = 1_800_000_000;

const builder = new AccessPolicyBuilder(PREFIX);

function resourcesFor(
  documents: ReturnType<AccessPolicyBuilder['build']>,
  action: string,
): string[] {
  return documents
    .flatMap((document) => document.Statement)
    .filter((statement) => statement.Action === action)
    .flatMap((statement) => statement.Resource);
}

describe('AccessPolicyBuilder', () => {
  const both: ControllerAccess[] = [
    { deviceId: OWNED, role: 'owner' },
    { deviceId: MANAGED, role: 'manager' },
  ];

  it('lets the user connect only under their own client IDs', () => {
    expect(resourcesFor(builder.build(USER, []), 'iot:Connect')).toEqual([
      `${PREFIX}client/${USER}-*`,
    ]);
  });

  it('gives a user without controllers nothing but the connection', () => {
    const documents = builder.build(USER, []);

    expect(documents).toHaveLength(1);
    expect(documents[0].Statement).toHaveLength(1);
  });

  it('lets both roles subscribe to and receive their controllers only', () => {
    const documents = builder.build(USER, both);

    expect(resourcesFor(documents, 'iot:Subscribe')).toEqual([
      `${PREFIX}topicfilter/esp32-irrigation/${OWNED}/*`,
      `${PREFIX}topicfilter/esp32-irrigation/${MANAGED}/*`,
    ]);
    expect(resourcesFor(documents, 'iot:Receive')).toEqual([
      `${PREFIX}topic/esp32-irrigation/${OWNED}/*`,
      `${PREFIX}topic/esp32-irrigation/${MANAGED}/*`,
    ]);
  });

  it('lets only the Owner send the controller configuration', () => {
    const published = resourcesFor(builder.build(USER, both), 'iot:Publish');

    expect(published).toEqual([
      `${PREFIX}topic/esp32-irrigation/${OWNED}/command`,
      `${PREFIX}topic/esp32-irrigation/${OWNED}/schedule`,
      `${PREFIX}topic/esp32-irrigation/${OWNED}/config`,
      `${PREFIX}topic/esp32-irrigation/${MANAGED}/command`,
      `${PREFIX}topic/esp32-irrigation/${MANAGED}/schedule`,
    ]);
  });

  it('never allows a retained message', () => {
    expect(JSON.stringify(builder.build(USER, both))).not.toContain('RetainPublish');
  });

  it('holds well over the 10 controllers a user is expected to have', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      deviceId: index.toString(16).toUpperCase().padStart(12, '0'),
      role: 'owner' as const,
    }));

    const documents = builder.build(USER, many);

    expect(resourcesFor(documents, 'iot:Subscribe')).toHaveLength(30);
    expect(documents.length).toBeLessThanOrEqual(MAX_POLICY_DOCUMENTS);
    for (const document of documents) {
      expect(JSON.stringify(document).length).toBeLessThanOrEqual(MAX_POLICY_DOCUMENT_LENGTH);
    }
  });

  it('stays within the limits of AWS IoT however many controllers there are', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tooMany = Array.from({ length: 500 }, (_, index) => ({
      deviceId: index.toString(16).toUpperCase().padStart(12, '0'),
      role: 'owner' as const,
    }));

    const documents = builder.build(USER, tooMany);

    expect(documents).toHaveLength(MAX_POLICY_DOCUMENTS);
    for (const document of documents) {
      expect(JSON.stringify(document).length).toBeLessThanOrEqual(MAX_POLICY_DOCUMENT_LENGTH);
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the authorizer', () => {
  const valid: TokenChecker = {
    verify: async (token) =>
      token === 'good' ? { userId: USER, expiresAt: NOW + 3600 } : null,
  };
  const access = {
    accessOf: jest.fn(async () => [{ deviceId: OWNED, role: 'owner' as const }]),
  };
  const handler = createAuthorizerHandler(valid, access, builder, () => NOW);

  const withHeader = (token: string, name = TOKEN_HEADER) => ({
    protocolData: { http: { headers: { [name]: token } } },
  });

  beforeEach(() => access.accessOf.mockClear());

  it('allows a valid token, with the policy of its user', async () => {
    const answer = await handler(withHeader('good'));

    expect(answer.isAuthenticated).toBe(true);
    expect(access.accessOf).toHaveBeenCalledWith(USER);
    expect(resourcesFor(answer.policyDocuments, 'iot:Connect')).toEqual([
      `${PREFIX}client/${USER}-*`,
    ]);
  });

  it('finds the token whatever the case of the header', async () => {
    const answer = await handler(withHeader('good', 'X-Irrigation-Token'));

    expect(answer.isAuthenticated).toBe(true);
  });

  it('accepts the token from where AWS IoT puts it', async () => {
    const answer = await handler({ token: 'good' });

    expect(answer.isAuthenticated).toBe(true);
  });

  it.each([
    ['no token', {}],
    ['an empty token', withHeader('')],
    ['a bad token', withHeader('bad')],
  ])('refuses %s, without reading any access', async (_name, event) => {
    const answer = await handler(event);

    expect(answer.isAuthenticated).toBe(false);
    expect(answer.policyDocuments).toEqual([]);
    expect(access.accessOf).not.toHaveBeenCalled();
  });

  it('refuses when the access cannot be read, and logs only the type', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = createAuthorizerHandler(
      valid,
      { accessOf: async () => Promise.reject(new Error('private detail')) },
      builder,
      () => NOW,
    );

    const answer = await failing(withHeader('good'));

    expect(answer.isAuthenticated).toBe(false);
    expect(error.mock.calls.join(' ')).not.toContain('private detail');
    error.mockRestore();
  });

  it('gives a principal of letters and digits only', async () => {
    const answer = await handler(withHeader('good'));

    expect(answer.principalId).toMatch(/^[a-zA-Z0-9]{1,128}$/);
  });

  it('ends the connection when the token expires', async () => {
    expect((await handler(withHeader('good'))).disconnectAfterInSeconds).toBe(3600);
  });

  it.each([
    ['nearly expired', NOW + 10, 300],
    ['valid for days', NOW + 10 * 86_400, 86_400],
  ])('keeps the connection time within the limits for a token %s', async (_n, expiresAt, seconds) => {
    const bounded = createAuthorizerHandler(
      { verify: async () => ({ userId: USER, expiresAt }) },
      access,
      builder,
      () => NOW,
    );

    expect((await bounded(withHeader('good'))).disconnectAfterInSeconds).toBe(seconds);
  });

  it('refreshes the policy as often as AWS IoT allows', async () => {
    expect((await handler(withHeader('good'))).refreshAfterInSeconds).toBe(300);
  });
});

describe('CognitoTokenVerifier', () => {
  const REGION = 'us-east-1';
  const POOL = 'us-east-1_pool';
  const CLIENT = 'the-app-client';
  const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;

  let verifier: CognitoTokenVerifier;
  let sign: (claims: Record<string, unknown>, issuer?: string, expires?: string) => Promise<string>;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'key-1' };

    verifier = new CognitoTokenVerifier({
      region: REGION,
      userPoolId: POOL,
      appClientId: CLIENT,
      keys: createLocalJWKSet({ keys: [jwk] }),
    });

    sign = (claims, issuer = ISSUER, expires = '1h') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
        .setIssuer(issuer)
        .setSubject(USER)
        .setIssuedAt()
        .setExpirationTime(expires)
        .sign(privateKey);
  });

  const accessClaims = { token_use: 'access', client_id: CLIENT };

  it('accepts an access token of this app', async () => {
    const identity = await verifier.verify(await sign(accessClaims));

    expect(identity?.userId).toBe(USER);
    expect(identity?.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('refuses an ID token', async () => {
    expect(await verifier.verify(await sign({ token_use: 'id', client_id: CLIENT }))).toBeNull();
  });

  it('refuses a token of another app client', async () => {
    expect(
      await verifier.verify(await sign({ token_use: 'access', client_id: 'other' })),
    ).toBeNull();
  });

  it('refuses a token of another user pool', async () => {
    expect(await verifier.verify(await sign(accessClaims, 'https://example.com/other'))).toBeNull();
  });

  it('refuses an expired token', async () => {
    expect(await verifier.verify(await sign(accessClaims, ISSUER, '-1m'))).toBeNull();
  });

  it('refuses a token signed with another key', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT(accessClaims)
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(ISSUER)
      .setSubject(USER)
      .setExpirationTime('1h')
      .sign(privateKey);

    expect(await verifier.verify(forged)).toBeNull();
  });

  it('refuses something that is not a token at all', async () => {
    expect(await verifier.verify('not-a-token')).toBeNull();
  });
});
