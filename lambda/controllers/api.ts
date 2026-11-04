import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

import { type AccessStore, type ControllerRecord, DynamoAccessStore } from './access-store';
import { IotClaimReportSource } from './claim-report';
import { type ClaimOutcome, ClaimService } from './claim-service';

type Response = APIGatewayProxyStructuredResultV2;

const DEVICE_ID = /^[0-9A-F]{12}$/;
/** 32 bytes in base64url, without padding. */
const CLAIM_CODE = /^[A-Za-z0-9_-]{43}$/;
const MAX_NAME_LENGTH = 40;
/** Control characters and the line and paragraph separators. */
const UNPRINTABLE_NAME = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const STATUS_OF_OUTCOME: Record<ClaimOutcome['result'], number> = {
  claimed: 200,
  already_owner: 200,
  pending: 202,
  already_owned: 409,
  expired: 410,
};

/** The HTTP side of the controllers API. Rules live in the services it calls. */
export class ControllersApi {
  constructor(
    private readonly store: AccessStore,
    private readonly claims: Pick<ClaimService, 'claim'>,
  ) {}

  async handle(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Response> {
    const userId = event.requestContext.authorizer?.jwt?.claims?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      return error(401, 'unauthorized');
    }

    try {
      switch (event.routeKey) {
        case 'GET /controllers':
          return json(200, { controllers: await this.store.controllersOf(userId) });
        case 'POST /controllers/{deviceId}/claim':
          return await this.claim(userId, event);
        case 'PUT /controllers/{deviceId}/name':
          return await this.rename(userId, event);
        default:
          return error(404, 'not_found');
      }
    } catch (failure) {
      // Only the type: a message could contain request data.
      const reason = failure instanceof Error ? failure.name : 'unknown';
      console.error(`${event.routeKey} failed (${reason}).`);
      return error(500, 'internal_error');
    }
  }

  private async claim(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    const code = bodyOf(event)?.code;
    if (!deviceId || typeof code !== 'string' || !CLAIM_CODE.test(code)) {
      return error(400, 'invalid_request');
    }

    const outcome = await this.claims.claim(userId, deviceId, Buffer.from(code, 'base64url'));

    // The device ID and result only: never the code or its hash.
    console.log(`Claim of ${deviceId}: ${outcome.result}.`);

    return json(STATUS_OF_OUTCOME[outcome.result], {
      result: outcome.result,
      ...('controller' in outcome ? { controller: ownedView(outcome.controller) } : {}),
    });
  }

  private async rename(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    const name = validName(bodyOf(event)?.name);
    if (!deviceId || name === null) return error(400, 'invalid_request');

    const controller = await this.store.rename(deviceId, userId, name);

    // The same answer for a missing controller: it shows nothing to a stranger.
    return controller ? json(200, ownedView(controller)) : error(403, 'not_owner');
  }
}

function deviceIdOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | null {
  const deviceId = event.pathParameters?.deviceId;
  return deviceId && DEVICE_ID.test(deviceId) ? deviceId : null;
}

function bodyOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> | null {
  if (!event.body) return null;

  const text = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validName(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const name = value.trim();
  const length = [...name].length;

  return length >= 1 && length <= MAX_NAME_LENGTH && !UNPRINTABLE_NAME.test(name) ? name : null;
}

/** What the Owner sees. The owner ID and the hash stay in the backend. */
function ownedView(controller: ControllerRecord) {
  return { deviceId: controller.deviceId, name: controller.name, role: 'owner' };
}

function json(statusCode: number, body: unknown): Response {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function error(statusCode: number, code: string): Response {
  return json(statusCode, { error: code });
}

// Created on the first call, so importing this module needs no configuration.
let configured: ControllersApi | undefined;

function fromEnvironment(environment: NodeJS.ProcessEnv = process.env): ControllersApi {
  const { TABLE_NAME, USER_INDEX_NAME, IOT_DATA_ENDPOINT } = environment;
  if (!TABLE_NAME || !USER_INDEX_NAME || !IOT_DATA_ENDPOINT) {
    throw new Error('TABLE_NAME, USER_INDEX_NAME and IOT_DATA_ENDPOINT are required.');
  }

  const store = new DynamoAccessStore(
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
    TABLE_NAME,
    USER_INDEX_NAME,
  );
  const reports = new IotClaimReportSource(
    new IoTDataPlaneClient({ endpoint: `https://${IOT_DATA_ENDPOINT}` }),
  );

  return new ControllersApi(store, new ClaimService(store, reports));
}

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Response> => {
  configured ??= fromEnvironment();
  return configured.handle(event);
};
