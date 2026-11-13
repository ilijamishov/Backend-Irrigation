import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

import type {
  AccessStore,
  Claimed,
  ControllerLocation,
  ControllerRecord,
  NewOwner,
  UserController,
} from '../lambda/controllers/access-store';
import { ControllersApi } from '../lambda/controllers/api';
import type { ClaimOutcome } from '../lambda/controllers/claim-service';
import type { AccountDeletion, Release, Transfer } from '../lambda/controllers/ownership-service';
import type {
  InvitationAcceptance,
  InvitationCreation,
  InvitationList,
  InvitationPreview,
  PeopleList,
} from '../lambda/controllers/sharing-service';
import type { ZoneChange, ZoneList, ZoneRemoval } from '../lambda/controllers/zone-service';

const DEVICE_ID = '1C8F57371AA4';
// 32 bytes of 7, in base64url.
const CODE = Buffer.alloc(32, 7).toString('base64url');

const record: ControllerRecord = {
  deviceId: DEVICE_ID,
  name: 'Home Garden',
  ownerId: 'alice',
  lastClaimHash: 'secret-hash',
};

class FakeStore implements AccessStore {
  locations: [string, string, ControllerLocation][] = [];
  located: ControllerRecord | null = record;
  renames: [string, string, string][] = [];
  renamed: ControllerRecord | null = record;
  list: UserController[] = [];
  failure: Error | null = null;

  async find(): Promise<ControllerRecord | null> {
    return null;
  }

  async claim(_owner: NewOwner): Promise<Claimed> {
    return { controller: record, removedUserIds: [] };
  }

  async controllersOf(): Promise<UserController[]> {
    if (this.failure) throw this.failure;
    return this.list;
  }

  async accessOf(): Promise<{ deviceId: string; role: 'owner' | 'manager' }[]> {
    return [];
  }

  async roleOf(): Promise<null> {
    return null;
  }

  async zonesOf(): Promise<never[]> {
    return [];
  }

  async saveZone(): Promise<void> {}

  async deleteZone(): Promise<void> {}

  async setLocation(
    deviceId: string,
    userId: string,
    location: ControllerLocation,
  ): Promise<ControllerRecord | null> {
    this.locations.push([deviceId, userId, location]);
    return this.located && { ...this.located, location };
  }

  async rename(deviceId: string, userId: string, name: string): Promise<ControllerRecord | null> {
    this.renames.push([deviceId, userId, name]);
    return this.renamed;
  }
}

function event(
  routeKey: string,
  overrides: {
    sub?: unknown;
    deviceId?: string;
    zoneId?: string;
    invitationId?: string;
    userId?: string;
    username?: unknown;
    body?: string;
    isBase64Encoded?: boolean;
  } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const sub = 'sub' in overrides ? overrides.sub : 'alice';
  return {
    routeKey,
    pathParameters: {
      deviceId: overrides.deviceId ?? DEVICE_ID,
      ...(overrides.zoneId ? { zoneId: overrides.zoneId } : {}),
      ...(overrides.invitationId ? { invitationId: overrides.invitationId } : {}),
      ...(overrides.userId ? { userId: overrides.userId } : {}),
    },
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false,
    requestContext: {
      authorizer: {
        jwt: {
          claims: { sub, username: 'username' in overrides ? overrides.username : 'google_1' },
          scopes: [],
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const CLAIM = 'POST /controllers/{deviceId}/claim';
const NAME = 'PUT /controllers/{deviceId}/name';
const LOCATION = 'PUT /controllers/{deviceId}/location';
const ZONES = 'GET /controllers/{deviceId}/zones';
const ADD_ZONE = 'POST /controllers/{deviceId}/zones';
const UPDATE_ZONE = 'PUT /controllers/{deviceId}/zones/{zoneId}';
const REMOVE_ZONE = 'DELETE /controllers/{deviceId}/zones/{zoneId}';
const ZONE_ID = '3f2b1c9e-0a4d-4e6f-8b7a-1c2d3e4f5a6b';
const INVITATION_ID = '00000000-0000-4000-8000-000000000001';
const MANAGER_ID = '0458f4a8-1234-5678-9abc-def012345678';
const INVITATIONS = 'POST /controllers/{deviceId}/invitations';
const LIST_INVITATIONS = 'GET /controllers/{deviceId}/invitations';
const CANCEL_INVITATION = 'DELETE /controllers/{deviceId}/invitations/{invitationId}';
const PREVIEW = 'POST /invitations/preview';
const ACCEPT = 'POST /invitations/accept';
const PEOPLE = 'GET /controllers/{deviceId}/people';
const REMOVE_PERSON = 'DELETE /controllers/{deviceId}/people/{userId}';
const LEAVE = 'DELETE /controllers/{deviceId}/access';
const zone = {
  zoneId: ZONE_ID,
  name: 'Back lawn',
  description: 'By the fence',
  relay: 5,
  enabled: true,
  createdAt: '2026-11-04T10:00:00.000Z',
};
const zoneAnswer = {
  zoneId: ZONE_ID,
  name: 'Back lawn',
  description: 'By the fence',
  relay: 5,
  enabled: true,
};

function setUp(outcome: ClaimOutcome = { result: 'pending' }) {
  const store = new FakeStore();
  const claim = jest.fn(async () => outcome);
  const timeZoneAt = jest.fn(async (_latitude: number, _longitude: number) => ({
    name: 'Europe/Skopje',
    posix: 'CET-1CEST,M3.5.0,M10.5.0/3',
  }));
  const zones = {
    list: jest.fn(async (): Promise<ZoneList> => ({ result: 'ok', zones: [zone] })),
    add: jest.fn(async (): Promise<ZoneChange> => ({ result: 'ok', zone })),
    update: jest.fn(async (): Promise<ZoneChange> => ({ result: 'ok', zone })),
    remove: jest.fn(async (): Promise<ZoneRemoval> => ({ result: 'ok' })),
  };
  const invitation = {
    invitationId: INVITATION_ID,
    deviceId: DEVICE_ID,
    codeHash: 'secret-hash',
    createdAt: '2026-11-12T10:00:00.000Z',
    expiresAt: '2026-11-15T10:00:00.000Z',
  };
  const sharing = {
    createInvitation: jest.fn(
      async (): Promise<InvitationCreation> => ({ result: 'ok', invitation, code: '482913' }),
    ),
    listInvitations: jest.fn(
      async (): Promise<InvitationList> => ({ result: 'ok', invitations: [invitation] }),
    ),
    cancelInvitation: jest.fn(
      async (): Promise<{ result: 'ok' | 'not_owner' | 'invitation_not_found' }> => ({
        result: 'ok',
      }),
    ),
    previewInvitation: jest.fn(
      async (): Promise<InvitationPreview> => ({
        result: 'ok',
        name: 'Home Garden',
        expiresAt: invitation.expiresAt,
      }),
    ),
    acceptInvitation: jest.fn(
      async (): Promise<InvitationAcceptance> => ({
        result: 'ok',
        controller: { deviceId: DEVICE_ID, name: 'Home Garden', role: 'manager' },
      }),
    ),
    listPeople: jest.fn(
      async (): Promise<PeopleList> => ({
        result: 'ok',
        people: [
          { userId: MANAGER_ID, role: 'manager', email: 'bob@example.com' },
          { userId: 'alice', role: 'owner' },
        ],
      }),
    ),
    removeManager: jest.fn(
      async (): Promise<{ result: 'ok' | 'not_owner' | 'not_a_manager' }> => ({ result: 'ok' }),
    ),
    leave: jest.fn(
      async (): Promise<{ result: 'ok' | 'owner_cannot_leave' | 'no_access' }> => ({
        result: 'ok',
      }),
    ),
  };
  const ownership = {
    transfer: jest.fn(async (): Promise<Transfer> => ({ result: 'ok' })),
    release: jest.fn(async (): Promise<Release> => ({ result: 'ok' })),
    deleteAccount: jest.fn(async (): Promise<AccountDeletion> => ({ result: 'ok' })),
  };
  return {
    store,
    claim,
    timeZoneAt,
    zones,
    sharing,
    ownership,
    api: new ControllersApi(
      store,
      { claim },
      { at: timeZoneAt },
      zones,
      sharing,
      ownership,
      '7bf65f8',
    ),
  };
}

const parsed = (response: { body?: string }) => JSON.parse(response.body ?? 'null');

describe('ControllersApi', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, method).mockImplementation((message: string) => {
        logged.push(message);
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('who is calling', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not text', 5],
    ])('answers 401 when the user ID is %s', async (_name, sub) => {
      const { api, store } = setUp();

      const response = await api.handle(event('GET /controllers', { sub }));

      expect(response.statusCode).toBe(401);
      expect(store.renames).toEqual([]);
    });

    it('takes the user only from the checked token', async () => {
      const { api, claim } = setUp();

      await api.handle(event(CLAIM, { sub: 'alice', body: JSON.stringify({ code: CODE, userId: 'bob' }) }));

      expect(claim).toHaveBeenCalledWith('alice', DEVICE_ID, Buffer.alloc(32, 7));
    });
  });

  describe('GET /version', () => {
    it('answers with the version of the deployed backend', async () => {
      const { api } = setUp();

      const response = await api.handle(event('GET /version'));

      expect(response.statusCode).toBe(200);
      expect(parsed(response)).toEqual({ version: '7bf65f8' });
    });

    it('needs a signed-in user like every other call', async () => {
      const { api } = setUp();

      const response = await api.handle(event('GET /version', { sub: undefined }));

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /controllers', () => {
    it("lists the user's controllers", async () => {
      const { api, store } = setUp();
      store.list = [{ deviceId: DEVICE_ID, name: 'Home', role: 'manager' }];

      const response = await api.handle(event('GET /controllers'));

      expect(response.statusCode).toBe(200);
      expect(parsed(response)).toEqual({ controllers: store.list });
    });
  });

  describe('POST claim', () => {
    it.each<[ClaimOutcome, number]>([
      [{ result: 'pending' }, 202],
      [{ result: 'expired' }, 410],
      [{ result: 'already_owned' }, 409],
      [{ result: 'claimed', controller: record }, 200],
      [{ result: 'already_owner', controller: record }, 200],
    ])('answers %j with %i', async (outcome, status) => {
      const { api } = setUp(outcome);

      const response = await api.handle(event(CLAIM, { body: JSON.stringify({ code: CODE }) }));

      expect(response.statusCode).toBe(status);
      expect(parsed(response).result).toBe(outcome.result);
    });

    it('gives the controller to its Owner, without the hash or owner ID', async () => {
      const { api } = setUp({ result: 'claimed', controller: record });

      const response = await api.handle(event(CLAIM, { body: JSON.stringify({ code: CODE }) }));

      expect(parsed(response)).toEqual({
        result: 'claimed',
        controller: { deviceId: DEVICE_ID, name: 'Home Garden', role: 'owner' },
      });
    });

    it('never logs the code or its hash', async () => {
      const { api } = setUp({ result: 'claimed', controller: record });

      await api.handle(event(CLAIM, { body: JSON.stringify({ code: CODE }) }));

      expect(logged.join(' ')).toContain(DEVICE_ID);
      expect(logged.join(' ')).not.toContain(CODE);
      expect(logged.join(' ')).not.toContain('secret-hash');
    });

    it('reads a base64-encoded body', async () => {
      const { api, claim } = setUp();

      await api.handle(
        event(CLAIM, {
          body: Buffer.from(JSON.stringify({ code: CODE })).toString('base64'),
          isBase64Encoded: true,
        }),
      );

      expect(claim).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['no body', undefined],
      ['a body that is not JSON', '{'],
      ['a list', '[]'],
      ['no code', '{}'],
      ['a code that is not text', '{"code":5}'],
      ['a short code', JSON.stringify({ code: CODE.slice(1) })],
      ['a long code', JSON.stringify({ code: `${CODE}A` })],
      ['a code with other characters', JSON.stringify({ code: `+${CODE.slice(1)}` })],
    ])('answers 400 for %s', async (_name, body) => {
      const { api, claim } = setUp();

      const response = await api.handle(event(CLAIM, { body }));

      expect(response.statusCode).toBe(400);
      expect(claim).not.toHaveBeenCalled();
    });

    it.each(['1c8f57371aa4', '1C8F57371AA', '1C8F57371AA44', '+', '1C8F57371AAG'])(
      'answers 400 for the device ID %s',
      async (deviceId) => {
        const { api, claim } = setUp();

        const response = await api.handle(
          event(CLAIM, { deviceId, body: JSON.stringify({ code: CODE }) }),
        );

        expect(response.statusCode).toBe(400);
        expect(claim).not.toHaveBeenCalled();
      },
    );
  });

  describe('PUT name', () => {
    it('renames for the Owner, trimming the name', async () => {
      const { api, store } = setUp();

      const response = await api.handle(event(NAME, { body: JSON.stringify({ name: '  Home  ' }) }));

      expect(response.statusCode).toBe(200);
      expect(store.renames).toEqual([[DEVICE_ID, 'alice', 'Home']]);
      expect(parsed(response)).toEqual({ deviceId: DEVICE_ID, name: 'Home Garden', role: 'owner' });
    });

    it('answers 403 for anyone who is not the Owner', async () => {
      const { api, store } = setUp();
      store.renamed = null;

      const response = await api.handle(event(NAME, { body: JSON.stringify({ name: 'Mine' }) }));

      expect(response.statusCode).toBe(403);
      expect(parsed(response)).toEqual({ error: 'not_owner' });
    });

    it('accepts 40 characters, counting an emoji as one', async () => {
      const { api, store } = setUp();

      await api.handle(event(NAME, { body: JSON.stringify({ name: '🌱'.repeat(40) }) }));

      expect(store.renames).toHaveLength(1);
    });

    it.each([
      ['no name', {}],
      ['a name that is not text', { name: 5 }],
      ['an empty name', { name: '' }],
      ['only spaces', { name: '   ' }],
      ['41 characters', { name: 'x'.repeat(41) }],
      ['a line break', { name: 'Home\nGarden' }],
      ['a control character', { name: 'Home\u0007' }],
      ['a line separator', { name: 'Home Garden' }],
    ])('answers 400 for %s', async (_name, body) => {
      const { api, store } = setUp();

      const response = await api.handle(event(NAME, { body: JSON.stringify(body) }));

      expect(response.statusCode).toBe(400);
      expect(store.renames).toEqual([]);
    });
  });

  describe('PUT location', () => {
    const position = JSON.stringify({ latitude: 41.99646, longitude: 21.43141 });

    it('saves the rounded position and the time zone, and answers with them', async () => {
      const { api, store } = setUp();

      const response = await api.handle(event(LOCATION, { body: position }));

      const location = {
        latitude: 42,
        longitude: 21.43,
        timeZone: 'Europe/Skopje',
        posixTimeZone: 'CET-1CEST,M3.5.0,M10.5.0/3',
      };
      expect(store.locations).toEqual([[DEVICE_ID, 'alice', location]]);
      expect(response.statusCode).toBe(200);
      expect(parsed(response)).toEqual({
        deviceId: DEVICE_ID,
        name: 'Home Garden',
        role: 'owner',
        location,
      });
    });

    it('finds the time zone from the exact position, not the rounded one', async () => {
      const { api, timeZoneAt } = setUp();

      await api.handle(event(LOCATION, { body: position }));

      expect(timeZoneAt).toHaveBeenCalledWith(41.99646, 21.43141);
    });

    it('answers 403 for anyone who is not the Owner', async () => {
      const { api, store } = setUp();
      store.located = null;

      const response = await api.handle(event(LOCATION, { body: position }));

      expect(response.statusCode).toBe(403);
      expect(parsed(response)).toEqual({ error: 'not_owner' });
    });

    it.each([
      ['no body', undefined],
      ['no longitude', '{"latitude":42}'],
      ['text', '{"latitude":"42","longitude":21}'],
      ['a latitude past the pole', '{"latitude":90.01,"longitude":21}'],
      ['a longitude past the date line', '{"latitude":42,"longitude":-180.01}'],
    ])('refuses %s', async (_name, body) => {
      const { api, store, timeZoneAt } = setUp();

      const response = await api.handle(event(LOCATION, { body }));

      expect(response.statusCode).toBe(400);
      expect(store.locations).toEqual([]);
      expect(timeZoneAt).not.toHaveBeenCalled();
    });

    it('accepts the ends of both ranges', async () => {
      const { api } = setUp();

      const response = await api.handle(
        event(LOCATION, { body: '{"latitude":-90,"longitude":180}' }),
      );

      expect(response.statusCode).toBe(200);
    });

    it('never logs the position, also when it fails', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation();
      const warn = jest.spyOn(console, 'warn').mockImplementation();
      const failed = jest.spyOn(console, 'error').mockImplementation();
      const { api, timeZoneAt } = setUp();

      await api.handle(event(LOCATION, { body: position }));
      timeZoneAt.mockRejectedValueOnce(new Error('at 41.99646, 21.43141'));
      await api.handle(event(LOCATION, { body: position }));

      const logged = JSON.stringify([log.mock.calls, warn.mock.calls, failed.mock.calls]);
      expect(logged).not.toContain('41.9');
      expect(logged).not.toContain('21.4');
      jest.restoreAllMocks();
    });
  });

  describe('zones', () => {
    const body = (fields: Record<string, unknown>) => ({ body: JSON.stringify(fields) });

    it('lists them, without their creation time', async () => {
      const { api, zones } = setUp();

      const response = await api.handle(event(ZONES));

      expect(zones.list).toHaveBeenCalledWith('alice', DEVICE_ID);
      expect(response.statusCode).toBe(200);
      expect(parsed(response)).toEqual({ zones: [zoneAnswer] });
    });

    it('lists nothing for a user without access', async () => {
      const { api, zones } = setUp();
      zones.list.mockResolvedValueOnce({ result: 'no_access' });

      const response = await api.handle(event(ZONES));

      expect(response.statusCode).toBe(403);
      expect(parsed(response)).toEqual({ error: 'no_access' });
    });

    it('adds a zone with all its fields, trimmed', async () => {
      const { api, zones } = setUp();

      const response = await api.handle(
        event(
          ADD_ZONE,
          body({ name: ' Roses ', description: ' South ', relay: 8, enabled: false }),
        ),
      );

      expect(zones.add).toHaveBeenCalledWith('alice', DEVICE_ID, {
        name: 'Roses',
        description: 'South',
        relay: 8,
        enabled: false,
      });
      expect(response.statusCode).toBe(201);
      expect(parsed(response)).toEqual(zoneAnswer);
    });

    it('adds an enabled zone without a name or description', async () => {
      const { api, zones } = setUp();

      await api.handle(event(ADD_ZONE, body({ relay: 1 })));

      expect(zones.add).toHaveBeenCalledWith('alice', DEVICE_ID, {
        name: null,
        description: null,
        relay: 1,
        enabled: true,
      });
    });

    it.each([
      ['no body', undefined],
      ['no relay', '{"name":"A"}'],
      ['relay 0', '{"relay":0}'],
      ['relay 9', '{"relay":9}'],
      ['a fractional relay', '{"relay":1.5}'],
      ['a relay as text', '{"relay":"1"}'],
      ['an empty name', '{"relay":1,"name":"  "}'],
      ['a name of 41 characters', `{"relay":1,"name":"${'a'.repeat(41)}"}`],
      ['a description that is no text', '{"relay":1,"description":5}'],
      ['a description of 201 characters', `{"relay":1,"description":"${'a'.repeat(201)}"}`],
      ['a line break in the description', '{"relay":1,"description":"a\\nb"}'],
      ['enabled as text', '{"relay":1,"enabled":"yes"}'],
    ])('refuses to add %s', async (_name, requestBody) => {
      const { api, zones } = setUp();

      const response = await api.handle(event(ADD_ZONE, { body: requestBody }));

      expect(response.statusCode).toBe(400);
      expect(zones.add).not.toHaveBeenCalled();
    });

    it.each([
      ['relay_in_use', 409],
      ['not_owner', 403],
    ] as const)('answers %s when adding', async (result, status) => {
      const { api, zones } = setUp();
      zones.add.mockResolvedValueOnce({ result });

      const response = await api.handle(event(ADD_ZONE, body({ relay: 1 })));

      expect(response.statusCode).toBe(status);
      expect(parsed(response)).toEqual({ error: result });
    });

    it('updates a zone, an empty description removing the old one', async () => {
      const { api, zones } = setUp();

      const response = await api.handle(
        event(UPDATE_ZONE, {
          zoneId: ZONE_ID,
          ...body({ name: 'Roses', description: ' ', relay: 3, enabled: false }),
        }),
      );

      expect(zones.update).toHaveBeenCalledWith('alice', DEVICE_ID, ZONE_ID, {
        name: 'Roses',
        description: null,
        relay: 3,
        enabled: false,
      });
      expect(response.statusCode).toBe(200);
    });

    it.each([
      ['no name', { relay: 1, enabled: true }],
      ['no enabled', { relay: 1, name: 'A', enabled: undefined }],
    ])('refuses an update with %s', async (_name, fields) => {
      const { api, zones } = setUp();

      const response = await api.handle(event(UPDATE_ZONE, { zoneId: ZONE_ID, ...body(fields) }));

      expect(response.statusCode).toBe(400);
      expect(zones.update).not.toHaveBeenCalled();
    });

    it('refuses a malformed zone ID', async () => {
      const { api, zones } = setUp();

      const update = await api.handle(
        event(UPDATE_ZONE, {
          zoneId: 'nope',
          ...body({ name: 'A', relay: 1, enabled: true }),
        }),
      );
      const removal = await api.handle(event(REMOVE_ZONE, { zoneId: 'nope' }));

      expect(update.statusCode).toBe(400);
      expect(removal.statusCode).toBe(400);
      expect(zones.update).not.toHaveBeenCalled();
      expect(zones.remove).not.toHaveBeenCalled();
    });

    it('answers 404 for a zone that is gone', async () => {
      const { api, zones } = setUp();
      zones.update.mockResolvedValueOnce({ result: 'zone_not_found' });

      const response = await api.handle(
        event(UPDATE_ZONE, {
          zoneId: ZONE_ID,
          ...body({ name: 'A', relay: 1, enabled: true }),
        }),
      );

      expect(response.statusCode).toBe(404);
    });

    it('removes a zone', async () => {
      const { api, zones } = setUp();

      const response = await api.handle(event(REMOVE_ZONE, { zoneId: ZONE_ID }));

      expect(zones.remove).toHaveBeenCalledWith('alice', DEVICE_ID, ZONE_ID);
      expect(response.statusCode).toBe(200);
    });

    it('answers 403 when removing without being the Owner', async () => {
      const { api, zones } = setUp();
      zones.remove.mockResolvedValueOnce({ result: 'not_owner' });

      const response = await api.handle(event(REMOVE_ZONE, { zoneId: ZONE_ID }));

      expect(response.statusCode).toBe(403);
    });
  });

  describe('failures', () => {
    it('answers 500 and logs only the type of the failure', async () => {
      const { api, store } = setUp();
      store.failure = Object.assign(new Error('private detail'), { name: 'SomeError' });

      const response = await api.handle(event('GET /controllers'));

      expect(response.statusCode).toBe(500);
      expect(parsed(response)).toEqual({ error: 'internal_error' });
      expect(logged.join(' ')).toContain('SomeError');
      expect(logged.join(' ')).not.toContain('private detail');
    });

    it('answers 404 for an unknown route', async () => {
      const { api } = setUp();

      const response = await api.handle(event('DELETE /controllers'));

      expect(response.statusCode).toBe(404);
    });
  });

  describe('sharing', () => {
    it('creates an invitation, with its code but never its hash', async () => {
      const { api, sharing } = setUp();

      const response = await api.handle(event(INVITATIONS));

      expect(response.statusCode).toBe(201);
      expect(parsed(response)).toEqual({
        invitationId: INVITATION_ID,
        createdAt: '2026-11-12T10:00:00.000Z',
        expiresAt: '2026-11-15T10:00:00.000Z',
        code: '482913',
      });
      expect(response.body).not.toContain('secret-hash');
      expect(sharing.createInvitation).toHaveBeenCalledWith('alice', DEVICE_ID);
      expect(logged.join(' ')).not.toContain('482913');
    });

    it.each<[InvitationCreation['result'], number]>([
      ['not_owner', 403],
      ['limit_reached', 409],
    ])('answers %s with %i', async (result, status) => {
      const { api, sharing } = setUp();
      sharing.createInvitation.mockResolvedValue({ result } as InvitationCreation);

      const response = await api.handle(event(INVITATIONS));

      expect(response.statusCode).toBe(status);
      expect(parsed(response)).toEqual({ error: result });
    });

    it('lists the pending invitations without their hashes', async () => {
      const { api } = setUp();

      const response = await api.handle(event(LIST_INVITATIONS));

      expect(response.statusCode).toBe(200);
      expect(parsed(response).invitations).toEqual([
        {
          invitationId: INVITATION_ID,
          createdAt: '2026-11-12T10:00:00.000Z',
          expiresAt: '2026-11-15T10:00:00.000Z',
        },
      ]);
    });

    it('cancels an invitation by its ID', async () => {
      const { api, sharing } = setUp();

      const response = await api.handle(
        event(CANCEL_INVITATION, { invitationId: INVITATION_ID }),
      );

      expect(response.statusCode).toBe(200);
      expect(sharing.cancelInvitation).toHaveBeenCalledWith('alice', DEVICE_ID, INVITATION_ID);
    });

    it('refuses an invitation ID that is none', async () => {
      const { api, sharing } = setUp();

      const response = await api.handle(event(CANCEL_INVITATION, { invitationId: 'nope' }));

      expect(response.statusCode).toBe(400);
      expect(sharing.cancelInvitation).not.toHaveBeenCalled();
    });

    it('shows the controller an invitation is for', async () => {
      const { api, sharing } = setUp();

      const response = await api.handle(
        event(PREVIEW, { body: JSON.stringify({ code: '482 913' }) }),
      );

      expect(response.statusCode).toBe(200);
      expect(parsed(response)).toEqual({
        name: 'Home Garden',
        expiresAt: '2026-11-15T10:00:00.000Z',
      });
      expect(sharing.previewInvitation).toHaveBeenCalledWith('482 913');
    });

    it.each([
      ['no code', {}],
      ['a code too short', { code: '48291' }],
      ['a code that is not text', { code: 482913 }],
    ])('refuses %s', async (_name, body) => {
      const { api, sharing } = setUp();

      const response = await api.handle(event(ACCEPT, { body: JSON.stringify(body) }));

      expect(response.statusCode).toBe(400);
      expect(sharing.acceptInvitation).not.toHaveBeenCalled();
    });

    it('joins with the user from the token, and logs only the controller', async () => {
      const { api, sharing } = setUp();

      const response = await api.handle(
        event(ACCEPT, { body: JSON.stringify({ code: '482913', userId: 'bob' }) }),
      );

      expect(response.statusCode).toBe(200);
      expect(parsed(response)).toEqual({
        controller: { deviceId: DEVICE_ID, name: 'Home Garden', role: 'manager' },
      });
      expect(sharing.acceptInvitation).toHaveBeenCalledWith('alice', 'google_1', '482913');
      expect(logged.join(' ')).toContain(DEVICE_ID);
      expect(logged.join(' ')).not.toContain('482913');
    });

    it('needs the username, for the email the Owner sees', async () => {
      const { api } = setUp();

      const response = await api.handle(
        event(ACCEPT, { username: undefined, body: JSON.stringify({ code: '482913' }) }),
      );

      expect(response.statusCode).toBe(400);
    });

    it.each<[InvitationAcceptance['result'], number]>([
      ['invitation_not_found', 404],
      ['invitation_expired', 410],
      ['already_has_access', 409],
    ])('answers %s with %i', async (result, status) => {
      const { api, sharing } = setUp();
      sharing.acceptInvitation.mockResolvedValue({ result } as InvitationAcceptance);

      const response = await api.handle(
        event(ACCEPT, { body: JSON.stringify({ code: '482913' }) }),
      );

      expect(response.statusCode).toBe(status);
      expect(parsed(response)).toEqual({ error: result });
    });

    it('lists the people of a controller', async () => {
      const { api } = setUp();

      const response = await api.handle(event(PEOPLE));

      expect(response.statusCode).toBe(200);
      expect(parsed(response).people).toEqual([
        { userId: MANAGER_ID, role: 'manager', email: 'bob@example.com' },
        { userId: 'alice', role: 'owner' },
      ]);
    });

    it('removes a Manager', async () => {
      const { api, sharing } = setUp();

      const response = await api.handle(event(REMOVE_PERSON, { userId: MANAGER_ID }));

      expect(response.statusCode).toBe(200);
      expect(sharing.removeManager).toHaveBeenCalledWith('alice', DEVICE_ID, MANAGER_ID);
    });

    it('says when the person is no Manager', async () => {
      const { api, sharing } = setUp();
      sharing.removeManager.mockResolvedValue({ result: 'not_a_manager' });

      const response = await api.handle(event(REMOVE_PERSON, { userId: MANAGER_ID }));

      expect(response.statusCode).toBe(404);
    });

    it('lets a Manager leave', async () => {
      const { api, sharing } = setUp();

      const response = await api.handle(event(LEAVE));

      expect(response.statusCode).toBe(200);
      expect(sharing.leave).toHaveBeenCalledWith('alice', DEVICE_ID);
    });

    it('transfers a controller to a Manager named in the body', async () => {
      const { api, ownership } = setUp();

      const response = await api.handle(
        event('POST /controllers/{deviceId}/transfer', {
          body: JSON.stringify({ userId: MANAGER_ID }),
        }),
      );

      expect(response.statusCode).toBe(200);
      expect(ownership.transfer).toHaveBeenCalledWith('alice', DEVICE_ID, MANAGER_ID);
    });

    it('refuses a transfer to someone who is no user ID', async () => {
      const { api, ownership } = setUp();

      const response = await api.handle(
        event('POST /controllers/{deviceId}/transfer', { body: JSON.stringify({ userId: 'x' }) }),
      );

      expect(response.statusCode).toBe(400);
      expect(ownership.transfer).not.toHaveBeenCalled();
    });

    it('says when the new Owner is no Manager', async () => {
      const { api, ownership } = setUp();
      ownership.transfer.mockResolvedValue({ result: 'not_a_manager' });

      const response = await api.handle(
        event('POST /controllers/{deviceId}/transfer', {
          body: JSON.stringify({ userId: MANAGER_ID }),
        }),
      );

      expect(response.statusCode).toBe(404);
    });

    it('releases a controller', async () => {
      const { api, ownership } = setUp();

      const response = await api.handle(event('DELETE /controllers/{deviceId}'));

      expect(response.statusCode).toBe(200);
      expect(ownership.release).toHaveBeenCalledWith('alice', DEVICE_ID);
    });

    it('releases nothing for anyone but the Owner', async () => {
      const { api, ownership } = setUp();
      ownership.release.mockResolvedValue({ result: 'not_owner' });

      const response = await api.handle(event('DELETE /controllers/{deviceId}'));

      expect(response.statusCode).toBe(403);
    });

    it('deletes the account of the user in the token', async () => {
      const { api, ownership } = setUp();

      const response = await api.handle(event('DELETE /account'));

      expect(response.statusCode).toBe(200);
      expect(ownership.deleteAccount).toHaveBeenCalledWith('alice', 'google_1');
    });

    it('names the controllers the user still owns', async () => {
      const { api, ownership } = setUp();
      ownership.deleteAccount.mockResolvedValue({
        result: 'owns_controllers',
        deviceIds: [DEVICE_ID],
      });

      const response = await api.handle(event('DELETE /account'));

      expect(response.statusCode).toBe(409);
      expect(parsed(response)).toEqual({ error: 'owns_controllers', deviceIds: [DEVICE_ID] });
    });

    it('tells the Owner they can\'t leave', async () => {
      const { api, sharing } = setUp();
      sharing.leave.mockResolvedValue({ result: 'owner_cannot_leave' });

      const response = await api.handle(event(LEAVE));

      expect(response.statusCode).toBe(409);
      expect(parsed(response)).toEqual({ error: 'owner_cannot_leave' });
    });
  });
});
