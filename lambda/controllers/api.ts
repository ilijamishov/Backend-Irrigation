import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

import {
  type AccessStore,
  type ControllerRecord,
  type ControllerZone,
  DynamoAccessStore,
} from './access-store';
import { IotClaimReportSource } from './claim-report';
import { type ClaimOutcome, ClaimService } from './claim-service';
import { AccessRevoker, DynamoConnectionRegistry, IotConnectionCloser } from './connections';
import { CognitoUsers } from './cognito-users';
import { OwnershipService } from './ownership-service';
import { DynamoOwnershipStore } from './ownership-store';
import { isInvitationCode, SharingService } from './sharing-service';
import { DynamoSharingStore, type Invitation, type Member } from './sharing-store';
import { MapTimeZoneLookup, type TimeZoneLookup } from './time-zones';
import { type ZoneChange, type ZoneInput, ZoneService } from './zone-service';

type Response = APIGatewayProxyStructuredResultV2;

const DEVICE_ID = /^[0-9A-F]{12}$/;
/** 32 bytes in base64url, without padding. */
const CLAIM_CODE = /^[A-Za-z0-9_-]{43}$/;
const ZONE_ID = /^[0-9a-f-]{36}$/;
/** Invitation IDs and Cognito `sub`s are both UUIDs. */
const UUID = /^[0-9a-f-]{36}$/;
const MAX_NAME_LENGTH = 40;
const MAX_DESCRIPTION_LENGTH = 200;
const FIRST_RELAY = 1;
const LAST_RELAY = 8;
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
    private readonly timeZones: TimeZoneLookup,
    private readonly zones: Pick<ZoneService, 'list' | 'add' | 'update' | 'remove'>,
    private readonly sharing: Pick<
      SharingService,
      | 'createInvitation'
      | 'listInvitations'
      | 'cancelInvitation'
      | 'previewInvitation'
      | 'acceptInvitation'
      | 'listPeople'
      | 'removeManager'
      | 'leave'
    >,
    private readonly ownership: Pick<OwnershipService, 'transfer' | 'release' | 'deleteAccount'>,
    /** The deployed backend's version: the git commit it was built from. */
    private readonly backendVersion: string,
  ) {}

  async handle(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Response> {
    const userId = event.requestContext.authorizer?.jwt?.claims?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      return error(401, 'unauthorized');
    }

    try {
      switch (event.routeKey) {
        case 'GET /version':
          return json(200, { version: this.backendVersion });
        case 'GET /controllers':
          return json(200, { controllers: await this.store.controllersOf(userId) });
        case 'POST /controllers/{deviceId}/claim':
          return await this.claim(userId, event);
        case 'PUT /controllers/{deviceId}/name':
          return await this.rename(userId, event);
        case 'PUT /controllers/{deviceId}/location':
          return await this.setLocation(userId, event);
        case 'GET /controllers/{deviceId}/zones':
          return await this.listZones(userId, event);
        case 'POST /controllers/{deviceId}/zones':
          return await this.addZone(userId, event);
        case 'PUT /controllers/{deviceId}/zones/{zoneId}':
          return await this.updateZone(userId, event);
        case 'DELETE /controllers/{deviceId}/zones/{zoneId}':
          return await this.removeZone(userId, event);
        case 'POST /controllers/{deviceId}/invitations':
          return await this.createInvitation(userId, event);
        case 'GET /controllers/{deviceId}/invitations':
          return await this.listInvitations(userId, event);
        case 'DELETE /controllers/{deviceId}/invitations/{invitationId}':
          return await this.cancelInvitation(userId, event);
        case 'POST /invitations/preview':
          return await this.previewInvitation(event);
        case 'POST /invitations/accept':
          return await this.acceptInvitation(userId, event);
        case 'GET /controllers/{deviceId}/people':
          return await this.listPeople(userId, event);
        case 'DELETE /controllers/{deviceId}/people/{userId}':
          return await this.removeManager(userId, event);
        case 'DELETE /controllers/{deviceId}/access':
          return await this.leave(userId, event);
        case 'POST /controllers/{deviceId}/transfer':
          return await this.transfer(userId, event);
        case 'DELETE /controllers/{deviceId}':
          return await this.release(userId, event);
        case 'DELETE /account':
          return await this.deleteAccount(userId, event);
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

  private async listZones(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    if (!deviceId) return error(400, 'invalid_request');

    const list = await this.zones.list(userId, deviceId);

    return list.result === 'ok'
      ? json(200, { zones: list.zones.map(zoneView) })
      : error(403, 'no_access');
  }

  private async addZone(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    const input = zoneInput(bodyOf(event), { nameRequired: false });
    if (!deviceId || !input) return error(400, 'invalid_request');

    return zoneAnswer(await this.zones.add(userId, deviceId, input), 201);
  }

  private async updateZone(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    const zoneId = zoneIdOf(event);
    const input = zoneInput(bodyOf(event), { nameRequired: true });
    if (!deviceId || !zoneId || !input) return error(400, 'invalid_request');

    return zoneAnswer(await this.zones.update(userId, deviceId, zoneId, input), 200);
  }

  private async removeZone(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    const zoneId = zoneIdOf(event);
    if (!deviceId || !zoneId) return error(400, 'invalid_request');

    const { result } = await this.zones.remove(userId, deviceId, zoneId);

    return result === 'ok' ? json(200, {}) : refusal(result);
  }

  /** The code is in the answer only: it is never stored or logged. */
  private async createInvitation(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    if (!deviceId) return error(400, 'invalid_request');

    const created = await this.sharing.createInvitation(userId, deviceId);
    if (created.result !== 'ok') return sharingRefusal(created.result);

    return json(201, { ...invitationView(created.invitation), code: created.code });
  }

  private async listInvitations(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    if (!deviceId) return error(400, 'invalid_request');

    const list = await this.sharing.listInvitations(userId, deviceId);
    return list.result === 'ok'
      ? json(200, { invitations: list.invitations.map(invitationView) })
      : sharingRefusal(list.result);
  }

  private async cancelInvitation(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    const invitationId = uuidOf(event, 'invitationId');
    if (!deviceId || !invitationId) return error(400, 'invalid_request');

    const { result } = await this.sharing.cancelInvitation(userId, deviceId, invitationId);
    return result === 'ok' ? json(200, {}) : sharingRefusal(result);
  }

  private async previewInvitation(
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const code = codeOf(event);
    if (!code) return error(400, 'invalid_request');

    const preview = await this.sharing.previewInvitation(code);
    return preview.result === 'ok'
      ? json(200, { name: preview.name, expiresAt: preview.expiresAt })
      : sharingRefusal(preview.result);
  }

  private async acceptInvitation(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const code = codeOf(event);
    const username = event.requestContext.authorizer?.jwt?.claims?.username;
    if (!code || typeof username !== 'string') return error(400, 'invalid_request');

    const accepted = await this.sharing.acceptInvitation(userId, username, code);
    if (accepted.result !== 'ok') return sharingRefusal(accepted.result);

    // The device ID only: never the code.
    console.log(`Invitation to ${accepted.controller.deviceId} accepted.`);
    return json(200, { controller: accepted.controller });
  }

  private async listPeople(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    if (!deviceId) return error(400, 'invalid_request');

    const list = await this.sharing.listPeople(userId, deviceId);
    return list.result === 'ok'
      ? json(200, { people: list.people.map(memberView) })
      : sharingRefusal(list.result);
  }

  private async removeManager(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    const managerId = uuidOf(event, 'userId');
    if (!deviceId || !managerId) return error(400, 'invalid_request');

    const { result } = await this.sharing.removeManager(userId, deviceId, managerId);
    return result === 'ok' ? json(200, {}) : sharingRefusal(result);
  }

  private async leave(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    if (!deviceId) return error(400, 'invalid_request');

    const { result } = await this.sharing.leave(userId, deviceId);
    return result === 'ok' ? json(200, {}) : sharingRefusal(result);
  }

  private async transfer(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    const newOwnerId = bodyOf(event)?.userId;
    if (!deviceId || typeof newOwnerId !== 'string' || !UUID.test(newOwnerId)) {
      return error(400, 'invalid_request');
    }

    const { result } = await this.ownership.transfer(userId, deviceId, newOwnerId);
    if (result !== 'ok') return sharingRefusal(result);

    console.log(`Controller ${deviceId} transferred.`);
    return json(200, {});
  }

  private async release(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    if (!deviceId) return error(400, 'invalid_request');

    const { result } = await this.ownership.release(userId, deviceId);
    if (result !== 'ok') return sharingRefusal(result);

    console.log(`Controller ${deviceId} released.`);
    return json(200, {});
  }

  private async deleteAccount(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const username = event.requestContext.authorizer?.jwt?.claims?.username;
    if (typeof username !== 'string') return error(400, 'invalid_request');

    const deletion = await this.ownership.deleteAccount(userId, username);
    if (deletion.result === 'owns_controllers') {
      return json(409, { error: 'owns_controllers', deviceIds: deletion.deviceIds });
    }

    console.log('An account was deleted.');
    return json(200, {});
  }

  /** Never logs the position: it shows where the Owner lives. */
  private async setLocation(
    userId: string,
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<Response> {
    const deviceId = deviceIdOf(event);
    const body = bodyOf(event);
    const latitude = numberWithin(body?.latitude, 90);
    const longitude = numberWithin(body?.longitude, 180);
    if (!deviceId || latitude === null || longitude === null) {
      return error(400, 'invalid_request');
    }

    // From the exact position, because a border can be closer than the rounding.
    const timeZone = await this.timeZones.at(latitude, longitude);

    const controller = await this.store.setLocation(deviceId, userId, {
      latitude: roundedPosition(latitude),
      longitude: roundedPosition(longitude),
      timeZone: timeZone.name,
      posixTimeZone: timeZone.posix,
    });

    // The same answer for a missing controller: it shows nothing to a stranger.
    return controller ? json(200, ownedView(controller)) : error(403, 'not_owner');
  }
}

function deviceIdOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | null {
  const deviceId = event.pathParameters?.deviceId;
  return deviceId && DEVICE_ID.test(deviceId) ? deviceId : null;
}

function zoneIdOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | null {
  const zoneId = event.pathParameters?.zoneId;
  return zoneId && ZONE_ID.test(zoneId) ? zoneId : null;
}

function uuidOf(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  name: 'invitationId' | 'userId',
): string | null {
  const value = event.pathParameters?.[name];
  return value && UUID.test(value) ? value : null;
}

/** In the body, so it never appears in a URL or an access log. */
function codeOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | null {
  const code = bodyOf(event)?.code;
  return typeof code === 'string' && isInvitationCode(code) ? code : null;
}

type SharingRefusal =
  | 'not_owner'
  | 'limit_reached'
  | 'invitation_not_found'
  | 'invitation_expired'
  | 'already_has_access'
  | 'not_a_manager'
  | 'owner_cannot_leave'
  | 'no_access';

function sharingRefusal(reason: SharingRefusal): Response {
  // The same not_owner for a missing controller: it shows nothing to a stranger.
  const status: Record<SharingRefusal, number> = {
    not_owner: 403,
    no_access: 403,
    limit_reached: 409,
    already_has_access: 409,
    owner_cannot_leave: 409,
    invitation_not_found: 404,
    not_a_manager: 404,
    invitation_expired: 410,
  };
  return error(status[reason], reason);
}

/** Without the code's hash, which stays in the backend. */
function invitationView(invitation: Invitation) {
  return {
    invitationId: invitation.invitationId,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
  };
}

function memberView(member: Member) {
  return {
    userId: member.userId,
    role: member.role,
    ...(member.email ? { email: member.email } : {}),
  };
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

/**
 * The whole zone: a field left out isn't kept, so a description can be removed.
 * Returns null for anything invalid.
 */
function zoneInput(
  body: Record<string, unknown> | null,
  { nameRequired }: { nameRequired: boolean },
): ZoneInput | null {
  if (!body) return null;

  const { relay } = body;
  // Only a new zone may leave this out, and it starts enabled.
  const enabled = body.enabled === undefined && !nameRequired ? true : body.enabled;
  if (typeof relay !== 'number' || !Number.isInteger(relay)) return null;
  if (relay < FIRST_RELAY || relay > LAST_RELAY || typeof enabled !== 'boolean') return null;

  const name = body.name === undefined ? null : validName(body.name);
  if (name === null && (nameRequired || body.name !== undefined)) return null;

  const description = validDescription(body.description);
  if (description === undefined) return null;

  return { name, description, relay, enabled };
}

/** Null for none, undefined for an invalid one. */
function validDescription(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;

  const description = value.trim();
  if ([...description].length > MAX_DESCRIPTION_LENGTH || UNPRINTABLE_NAME.test(description)) {
    return undefined;
  }

  return description.length > 0 ? description : null;
}

function zoneAnswer(change: ZoneChange, successStatus: number): Response {
  return change.result === 'ok' ? json(successStatus, zoneView(change.zone)) : refusal(change.result);
}

function refusal(reason: 'not_owner' | 'zone_not_found' | 'relay_in_use'): Response {
  // The same not_owner for a missing controller: it shows nothing to a stranger.
  const status = { not_owner: 403, zone_not_found: 404, relay_in_use: 409 }[reason];
  return error(status, reason);
}

function zoneView(zone: ControllerZone) {
  return {
    zoneId: zone.zoneId,
    name: zone.name,
    ...(zone.description ? { description: zone.description } : {}),
    relay: zone.relay,
    enabled: zone.enabled,
  };
}

function numberWithin(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Math.abs(value) <= limit ? value : null;
}

/** To about 1 km: enough for a forecast, and it doesn't point at a house. */
function roundedPosition(value: number): number {
  return Math.round(value * 100) / 100;
}

/** What the Owner sees. The owner ID and the hash stay in the backend. */
function ownedView(controller: ControllerRecord) {
  return {
    deviceId: controller.deviceId,
    name: controller.name,
    role: 'owner',
    ...(controller.location ? { location: controller.location } : {}),
  };
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
  const { TABLE_NAME, USER_INDEX_NAME, IOT_DATA_ENDPOINT, USER_POOL_ID } = environment;
  if (!TABLE_NAME || !USER_INDEX_NAME || !IOT_DATA_ENDPOINT || !USER_POOL_ID) {
    throw new Error(
      'TABLE_NAME, USER_INDEX_NAME, IOT_DATA_ENDPOINT and USER_POOL_ID are required.',
    );
  }

  const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const store = new DynamoAccessStore(documents, TABLE_NAME, USER_INDEX_NAME);
  const iotData = new IoTDataPlaneClient({ endpoint: `https://${IOT_DATA_ENDPOINT}` });
  const reports = new IotClaimReportSource(iotData);
  const revoker = new AccessRevoker(
    new DynamoConnectionRegistry(documents, TABLE_NAME),
    new IotConnectionCloser(iotData),
  );
  const sharingStore = new DynamoSharingStore(documents, TABLE_NAME);
  const users = new CognitoUsers(new CognitoIdentityProviderClient({}), USER_POOL_ID);
  const sharing = new SharingService(store, sharingStore, users, revoker);
  const ownership = new OwnershipService(
    store,
    new DynamoOwnershipStore(documents, TABLE_NAME),
    sharingStore,
    users,
    revoker,
  );

  return new ControllersApi(
    store,
    new ClaimService(store, reports, revoker),
    new MapTimeZoneLookup(),
    new ZoneService(store),
    sharing,
    ownership,
    process.env.BACKEND_VERSION || 'unknown',
  );
}

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Response> => {
  configured ??= fromEnvironment();
  return configured.handle(event);
};
