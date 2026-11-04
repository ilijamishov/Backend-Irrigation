import {
  type ControllerRecord,
  type ControllerZone,
  type Role,
  ZoneConflictError,
} from '../lambda/controllers/access-store';
import { defaultZoneName, type ZoneInput, ZoneService } from '../lambda/controllers/zone-service';

const DEVICE_ID = '1C8F57371AA4';

class FakeZoneStore {
  zones: ControllerZone[] = [];
  owner: string | null = 'alice';
  roles = new Map<string, Role>([
    ['alice', 'owner'],
    ['bob', 'manager'],
  ]);
  conflicts = 0;
  versionsSeen: number[] = [];
  zonesVersion: number | undefined = 4;

  async find(): Promise<ControllerRecord | null> {
    if (!this.owner) return null;
    return {
      deviceId: DEVICE_ID,
      name: 'Home',
      ownerId: this.owner,
      lastClaimHash: 'h',
      zonesVersion: this.zonesVersion,
    };
  }

  async roleOf(_deviceId: string, userId: string): Promise<Role | null> {
    return this.roles.get(userId) ?? null;
  }

  async zonesOf(): Promise<ControllerZone[]> {
    return this.zones;
  }

  async saveZone(_d: string, _u: string, zone: ControllerZone, version: number): Promise<void> {
    this.versionsSeen.push(version);
    if (this.conflicts-- > 0) throw new ZoneConflictError();
    this.zones = [...this.zones.filter((z) => z.zoneId !== zone.zoneId), zone];
  }

  async deleteZone(_d: string, _u: string, zoneId: string, version: number): Promise<void> {
    this.versionsSeen.push(version);
    if (this.conflicts-- > 0) throw new ZoneConflictError();
    this.zones = this.zones.filter((z) => z.zoneId !== zoneId);
  }
}

const lawn: ControllerZone = {
  zoneId: 'lawn',
  name: 'Back lawn',
  relay: 5,
  enabled: true,
  createdAt: '2026-11-04T10:00:00.000Z',
};

const input = (changes: Partial<ZoneInput> = {}): ZoneInput => ({
  name: 'Roses',
  description: null,
  relay: 2,
  enabled: true,
  ...changes,
});

function setUp() {
  const store = new FakeZoneStore();
  const service = new ZoneService(store as never, () => Date.UTC(2026, 10, 4), () => 'new-id');
  return { store, service };
}

describe('ZoneService', () => {
  describe('list', () => {
    it('shows the zones to the Owner and to a Manager', async () => {
      const { store, service } = setUp();
      store.zones = [lawn];

      await expect(service.list('alice', DEVICE_ID)).resolves.toEqual({
        result: 'ok',
        zones: [lawn],
      });
      await expect(service.list('bob', DEVICE_ID)).resolves.toEqual({
        result: 'ok',
        zones: [lawn],
      });
    });

    it('shows nothing to anyone else', async () => {
      const { store, service } = setUp();
      store.zones = [lawn];

      await expect(service.list('mallory', DEVICE_ID)).resolves.toEqual({ result: 'no_access' });
    });
  });

  describe('add', () => {
    it('adds a zone on any free relay, in any order', async () => {
      const { store, service } = setUp();
      store.zones = [lawn];

      await expect(
        service.add('alice', DEVICE_ID, input({ relay: 8, description: 'By the fence' })),
      ).resolves.toEqual({
        result: 'ok',
        zone: {
          zoneId: 'new-id',
          name: 'Roses',
          description: 'By the fence',
          relay: 8,
          enabled: true,
          createdAt: '2026-11-04T00:00:00.000Z',
        },
      });
      expect(store.zones).toHaveLength(2);
    });

    it('gives the default name when there is none', async () => {
      const { service } = setUp();

      await expect(service.add('alice', DEVICE_ID, input({ name: null }))).resolves.toMatchObject({
        zone: { name: 'Zone 1' },
      });
    });

    it('leaves out an empty description', async () => {
      const { service } = setUp();

      const change = await service.add('alice', DEVICE_ID, input({ description: null }));

      expect(change).not.toHaveProperty('zone.description');
    });

    it('refuses a relay another zone uses', async () => {
      const { store, service } = setUp();
      store.zones = [lawn];

      await expect(service.add('alice', DEVICE_ID, input({ relay: 5 }))).resolves.toEqual({
        result: 'relay_in_use',
      });
      expect(store.zones).toEqual([lawn]);
    });

    it('also refuses the relay of a disabled zone', async () => {
      const { store, service } = setUp();
      store.zones = [{ ...lawn, enabled: false }];

      await expect(service.add('alice', DEVICE_ID, input({ relay: 5 }))).resolves.toEqual({
        result: 'relay_in_use',
      });
    });

    it.each([
      ['a Manager', 'bob'],
      ['a stranger', 'mallory'],
    ])('refuses %s', async (_who, userId) => {
      const { store, service } = setUp();

      await expect(service.add(userId, DEVICE_ID, input())).resolves.toEqual({
        result: 'not_owner',
      });
      expect(store.zones).toEqual([]);
    });

    it('gives the same answer for a controller that does not exist', async () => {
      const { store, service } = setUp();
      store.owner = null;

      await expect(service.add('alice', DEVICE_ID, input())).resolves.toEqual({
        result: 'not_owner',
      });
    });

    it('writes against the version it read', async () => {
      const { store, service } = setUp();

      await service.add('alice', DEVICE_ID, input());

      expect(store.versionsSeen).toEqual([4]);
    });

    it('starts from version 0 on a controller without zones yet', async () => {
      const { store, service } = setUp();
      store.zonesVersion = undefined;

      await service.add('alice', DEVICE_ID, input());

      expect(store.versionsSeen).toEqual([0]);
    });

    it('decides again after losing a race', async () => {
      const { store, service } = setUp();
      store.conflicts = 1;

      await expect(service.add('alice', DEVICE_ID, input())).resolves.toMatchObject({
        result: 'ok',
      });
      expect(store.versionsSeen).toHaveLength(2);
    });

    it('gives up if the races continue', async () => {
      const { store, service } = setUp();
      store.conflicts = 10;

      await expect(service.add('alice', DEVICE_ID, input())).rejects.toBeInstanceOf(
        ZoneConflictError,
      );
    });
  });

  describe('update', () => {
    it('changes everything but the ID and creation time', async () => {
      const { store, service } = setUp();
      store.zones = [lawn];

      await expect(
        service.update(
          'alice',
          DEVICE_ID,
          'lawn',
          input({ name: 'Front lawn', description: 'South', relay: 3, enabled: false }),
        ),
      ).resolves.toEqual({
        result: 'ok',
        zone: {
          zoneId: 'lawn',
          name: 'Front lawn',
          description: 'South',
          relay: 3,
          enabled: false,
          createdAt: lawn.createdAt,
        },
      });
    });

    it('keeps its own relay without calling it in use', async () => {
      const { store, service } = setUp();
      store.zones = [lawn];

      await expect(
        service.update('alice', DEVICE_ID, 'lawn', input({ relay: 5 })),
      ).resolves.toMatchObject({ result: 'ok' });
    });

    it('removes a description that is no longer given', async () => {
      const { store, service } = setUp();
      store.zones = [{ ...lawn, description: 'Old' }];

      const change = await service.update('alice', DEVICE_ID, 'lawn', input({ relay: 5 }));

      expect(change).not.toHaveProperty('zone.description');
    });

    it('refuses a relay another zone uses', async () => {
      const { store, service } = setUp();
      store.zones = [lawn, { ...lawn, zoneId: 'roses', relay: 2 }];

      await expect(
        service.update('alice', DEVICE_ID, 'lawn', input({ relay: 2 })),
      ).resolves.toEqual({ result: 'relay_in_use' });
    });

    it('says when the zone does not exist', async () => {
      const { service } = setUp();

      await expect(service.update('alice', DEVICE_ID, 'gone', input())).resolves.toEqual({
        result: 'zone_not_found',
      });
    });

    it('refuses a Manager', async () => {
      const { store, service } = setUp();
      store.zones = [lawn];

      await expect(service.update('bob', DEVICE_ID, 'lawn', input())).resolves.toEqual({
        result: 'not_owner',
      });
    });
  });

  describe('remove', () => {
    it('removes the zone', async () => {
      const { store, service } = setUp();
      store.zones = [lawn];

      await expect(service.remove('alice', DEVICE_ID, 'lawn')).resolves.toEqual({ result: 'ok' });
      expect(store.zones).toEqual([]);
    });

    it('says when the zone does not exist', async () => {
      const { service } = setUp();

      await expect(service.remove('alice', DEVICE_ID, 'gone')).resolves.toEqual({
        result: 'zone_not_found',
      });
    });

    it('refuses a Manager', async () => {
      const { store, service } = setUp();
      store.zones = [lawn];

      await expect(service.remove('bob', DEVICE_ID, 'lawn')).resolves.toEqual({
        result: 'not_owner',
      });
      expect(store.zones).toEqual([lawn]);
    });
  });

  describe('defaultZoneName', () => {
    it('counts from 1', () => {
      expect(defaultZoneName([])).toBe('Zone 1');
    });

    it('takes the lowest number still free', () => {
      const named = (name: string) => ({ ...lawn, name });

      expect(defaultZoneName([named('Zone 1'), named('Zone 3'), named('Roses')])).toBe('Zone 2');
    });
  });
});
