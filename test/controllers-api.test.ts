import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

import type {
  AccessStore,
  ControllerLocation,
  ControllerRecord,
  NewOwner,
  UserController,
} from '../lambda/controllers/access-store';
import { ControllersApi } from '../lambda/controllers/api';
import type { ClaimOutcome } from '../lambda/controllers/claim-service';

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

  async claim(_owner: NewOwner): Promise<ControllerRecord> {
    return record;
  }

  async controllersOf(): Promise<UserController[]> {
    if (this.failure) throw this.failure;
    return this.list;
  }

  async accessOf(): Promise<{ deviceId: string; role: 'owner' | 'manager' }[]> {
    return [];
  }

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
    body?: string;
    isBase64Encoded?: boolean;
  } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const sub = 'sub' in overrides ? overrides.sub : 'alice';
  return {
    routeKey,
    pathParameters: { deviceId: overrides.deviceId ?? DEVICE_ID },
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false,
    requestContext: { authorizer: { jwt: { claims: { sub }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const CLAIM = 'POST /controllers/{deviceId}/claim';
const NAME = 'PUT /controllers/{deviceId}/name';
const LOCATION = 'PUT /controllers/{deviceId}/location';

function setUp(outcome: ClaimOutcome = { result: 'pending' }) {
  const store = new FakeStore();
  const claim = jest.fn(async () => outcome);
  const timeZoneAt = jest.fn(async (_latitude: number, _longitude: number) => ({
    name: 'Europe/Skopje',
    posix: 'CET-1CEST,M3.5.0,M10.5.0/3',
  }));
  return {
    store,
    claim,
    timeZoneAt,
    api: new ControllersApi(store, { claim }, { at: timeZoneAt }),
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
});
