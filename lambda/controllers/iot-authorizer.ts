import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { DynamoAccessStore } from './access-store';
import { AccessPolicyBuilder, type ControllerAccess, type PolicyDocument } from './access-policy';
import { CognitoTokenVerifier, type TokenIdentity } from './cognito-token';
import { type ConnectionRegistry, DynamoConnectionRegistry } from './connections';

/** The header the app sends its Cognito access token in. */
export const TOKEN_HEADER = 'x-irrigation-token';
/** The header the app names its MQTT client ID in: `<sub>-<installation ID>`. */
export const CLIENT_ID_HEADER = 'x-irrigation-client-id';
const INSTALLATION_ID = /^[A-Za-z0-9-]{1,64}$/;

/** AWS IoT's limits, in seconds. */
const MIN_CONNECTION_TIME = 300;
const MAX_CONNECTION_TIME = 86_400;
/** The shortest AWS IoT allows: how soon a role change reaches an open connection. */
const POLICY_REFRESH_TIME = 300;

export interface AuthorizerRequest {
  readonly token?: string;
  readonly protocolData?: {
    readonly http?: { readonly headers?: Record<string, string | undefined> };
  };
}

export type AuthorizerResponse =
  | {
      readonly isAuthenticated: false;
      readonly principalId: string;
      readonly policyDocuments: [];
      readonly disconnectAfterInSeconds: number;
      readonly refreshAfterInSeconds: number;
    }
  | {
      readonly isAuthenticated: true;
      readonly principalId: string;
      readonly policyDocuments: PolicyDocument[];
      readonly disconnectAfterInSeconds: number;
      readonly refreshAfterInSeconds: number;
    };

export interface TokenChecker {
  verify(token: string): Promise<TokenIdentity | null>;
}

export interface AccessReader {
  accessOf(userId: string): Promise<ControllerAccess[]>;
}

const REFUSED: AuthorizerResponse = {
  isAuthenticated: false,
  principalId: 'refused',
  policyDocuments: [],
  disconnectAfterInSeconds: MIN_CONNECTION_TIME,
  refreshAfterInSeconds: POLICY_REFRESH_TIME,
};

/**
 * Decides what an app connection to AWS IoT may do. Token signing is off,
 * because an app can't keep a signing key secret, so anyone can reach this:
 * a bad token is refused before anything else is read, and any failure
 * refuses. Runs at each connection and each policy refresh.
 */
export function createAuthorizerHandler(
  tokens: TokenChecker,
  access: AccessReader,
  policies: AccessPolicyBuilder,
  connections: Pick<ConnectionRegistry, 'record'>,
  now: () => number = () => Date.now() / 1000,
) {
  return async (event: AuthorizerRequest): Promise<AuthorizerResponse> => {
    const token = tokenOf(event);
    if (!token) return REFUSED;

    const identity = await tokens.verify(token);
    if (!identity) return REFUSED;

    try {
      const clientId = clientIdOf(event, identity.userId);
      // The connection ends with the token: the app reconnects with a new one.
      const connectionTime = clamp(identity.expiresAt - now());
      const [controllers] = await Promise.all([
        access.accessOf(identity.userId),
        // So a change of access can close it (docs/claiming.md §7).
        clientId
          ? connections.record(identity.userId, clientId, now() + connectionTime)
          : Promise.resolve(),
      ]);

      return {
        isAuthenticated: true,
        // Letters and digits only, by AWS IoT's rule.
        principalId: identity.userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 128),
        policyDocuments: policies.build(identity.userId, controllers, clientId),
        disconnectAfterInSeconds: connectionTime,
        refreshAfterInSeconds: POLICY_REFRESH_TIME,
      };
    } catch (error) {
      // Only the type: a message could contain request data.
      const reason = error instanceof Error ? error.name : 'unknown';
      console.error(`Connection refused: could not read the access (${reason}).`);
      return REFUSED;
    }
  };
}

function tokenOf(event: AuthorizerRequest): string | undefined {
  return event.token || headerOf(event, TOKEN_HEADER);
}

/**
 * The client ID the app names, if it is one of this user's. `null` without
 * one, as from an older app: the connection is then allowed as before, but a
 * change of access reaches it only at the next policy refresh.
 */
function clientIdOf(event: AuthorizerRequest, userId: string): string | null {
  const clientId = headerOf(event, CLIENT_ID_HEADER);
  const prefix = `${userId}-`;

  return clientId?.startsWith(prefix) && INSTALLATION_ID.test(clientId.slice(prefix.length))
    ? clientId
    : null;
}

function headerOf(event: AuthorizerRequest, wanted: string): string | undefined {
  const headers = event.protocolData?.http?.headers ?? {};
  const name = Object.keys(headers).find((key) => key.toLowerCase() === wanted);

  return name ? headers[name] : undefined;
}

function clamp(seconds: number): number {
  return Math.min(MAX_CONNECTION_TIME, Math.max(MIN_CONNECTION_TIME, Math.floor(seconds)));
}

// Created on the first call, so importing this module needs no configuration.
let configured: ReturnType<typeof createAuthorizerHandler> | undefined;

function fromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const { AWS_REGION, USER_POOL_ID, APP_CLIENT_ID, TABLE_NAME, USER_INDEX_NAME, IOT_ARN_PREFIX } =
    environment;
  if (
    !AWS_REGION ||
    !USER_POOL_ID ||
    !APP_CLIENT_ID ||
    !TABLE_NAME ||
    !USER_INDEX_NAME ||
    !IOT_ARN_PREFIX
  ) {
    throw new Error('The authorizer is missing its configuration.');
  }

  const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return createAuthorizerHandler(
    new CognitoTokenVerifier({
      region: AWS_REGION,
      userPoolId: USER_POOL_ID,
      appClientId: APP_CLIENT_ID,
    }),
    new DynamoAccessStore(documents, TABLE_NAME, USER_INDEX_NAME),
    new AccessPolicyBuilder(IOT_ARN_PREFIX),
    new DynamoConnectionRegistry(documents, TABLE_NAME),
  );
}

export const handler = (event: AuthorizerRequest): Promise<AuthorizerResponse> => {
  configured ??= fromEnvironment();
  return configured(event);
};
