import { createHash } from 'node:crypto';

import {
  type AccessStore,
  ClaimConflictError,
  type ControllerRecord,
  type NewOwner,
  type UserController,
} from '../lambda/controllers/access-store';
import type { ClaimReport, ClaimReportSource } from '../lambda/controllers/claim-report';
import {
  CLAIM_REPORT_LIFETIME_MS,
  ClaimService,
  defaultControllerName,
} from '../lambda/controllers/claim-service';

const DEVICE_ID = '1C8F57371AA4';
const NOW = 1_800_000_000_000;
const CODE = new Uint8Array(32).fill(7);
const HASH = createHash('sha256').update(CODE).digest('hex');
const OTHER_HASH = 'f'.repeat(64);

class FakeStore implements AccessStore {
  claims: NewOwner[] = [];
  conflicts = 0;

  constructor(public current: ControllerRecord | null = null) {}

  async find(): Promise<ControllerRecord | null> {
    return this.current;
  }

  async claim(owner: NewOwner): Promise<ControllerRecord> {
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      throw new ClaimConflictError();
    }
    this.claims.push(owner);
    this.current = {
      deviceId: owner.deviceId,
      name: owner.name,
      ownerId: owner.userId,
      lastClaimHash: owner.codeHash,
    };
    return this.current;
  }

  async controllersOf(): Promise<UserController[]> {
    return [];
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

  async setLocation(): Promise<ControllerRecord | null> {
    return null;
  }

  async rename(): Promise<ControllerRecord | null> {
    return null;
  }
}

class FakeReports implements ClaimReportSource {
  cleared = 0;
  clearFails = false;

  constructor(public report: ClaimReport | null = null) {}

  async latest(): Promise<ClaimReport | null> {
    return this.report;
  }

  async clear(): Promise<void> {
    if (this.clearFails) throw new Error('down');
    this.cleared += 1;
    this.report = null;
  }
}

const report = (overrides: Partial<ClaimReport> = {}): ClaimReport => ({
  codeHash: HASH,
  reset: true,
  storedAt: NOW - 1000,
  ...overrides,
});

const owned = (ownerId: string, lastClaimHash = OTHER_HASH): ControllerRecord => ({
  deviceId: DEVICE_ID,
  name: 'Home Garden',
  ownerId,
  lastClaimHash,
});

function setUp(current: ControllerRecord | null, latest: ClaimReport | null) {
  const store = new FakeStore(current);
  const reports = new FakeReports(latest);
  return { store, reports, service: new ClaimService(store, reports, () => NOW) };
}

describe('ClaimService', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  describe('not decided yet', () => {
    it('answers pending when the controller has not reported', async () => {
      const { service, store } = setUp(null, null);

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toEqual({ result: 'pending' });
      expect(store.claims).toHaveLength(0);
    });

    it('answers pending for an older report, which is not a refusal', async () => {
      const { service, store } = setUp(null, report({ codeHash: OTHER_HASH }));

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toEqual({ result: 'pending' });
      expect(store.claims).toHaveLength(0);
    });

    it('tells a caller with a wrong code nothing about an owned controller', async () => {
      const { service } = setUp(owned('bob'), report({ codeHash: OTHER_HASH }));

      await expect(service.claim('mallory', DEVICE_ID, CODE)).resolves.toEqual({
        result: 'pending',
      });
    });
  });

  describe('an unowned controller', () => {
    it('makes the caller the Owner, with a default name', async () => {
      const { service, store } = setUp(null, report());

      const outcome = await service.claim('alice', DEVICE_ID, CODE);

      expect(outcome).toEqual({
        result: 'claimed',
        controller: {
          deviceId: DEVICE_ID,
          name: 'Controller 1AA4',
          ownerId: 'alice',
          lastClaimHash: HASH,
        },
      });
      expect(store.claims).toEqual([
        {
          deviceId: DEVICE_ID,
          userId: 'alice',
          name: 'Controller 1AA4',
          codeHash: HASH,
          claimedAt: new Date(NOW).toISOString(),
          previous: null,
        },
      ]);
    });

    it('can be claimed after a Wi-Fi change too, when the first claim never happened', async () => {
      const { service, store } = setUp(null, report({ reset: false }));

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toMatchObject({
        result: 'claimed',
      });
      expect(store.current?.ownerId).toBe('alice');
    });

    it('clears the report after a claim', async () => {
      const { service, reports } = setUp(null, report());

      await service.claim('alice', DEVICE_ID, CODE);

      expect(reports.cleared).toBe(1);
    });

    it('still succeeds when clearing the report fails', async () => {
      const { service, reports } = setUp(null, report());
      reports.clearFails = true;

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toMatchObject({
        result: 'claimed',
      });
    });
  });

  describe('a retry', () => {
    it('gets the same answer after the claim cleared the report', async () => {
      const { service, reports } = setUp(null, report());
      const first = await service.claim('alice', DEVICE_ID, CODE);
      expect(reports.report).toBeNull();

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toEqual(first);
    });

    it('changes nothing when the report could not be cleared', async () => {
      const { service, store, reports } = setUp(null, report());
      reports.clearFails = true;
      await service.claim('alice', DEVICE_ID, CODE);

      await service.claim('alice', DEVICE_ID, CODE);

      expect(store.claims).toHaveLength(1);
    });

    it('does not let another user reuse a used code', async () => {
      const { service, store, reports } = setUp(null, report());
      reports.clearFails = true;
      await service.claim('alice', DEVICE_ID, CODE);

      await expect(service.claim('bob', DEVICE_ID, CODE)).resolves.toEqual({
        result: 'already_owned',
      });
      expect(store.current?.ownerId).toBe('alice');
    });

    it('cannot use a reset report twice to remove people again', async () => {
      const { service, store, reports } = setUp(owned('bob'), report({ reset: true }));
      reports.clearFails = true;
      await service.claim('alice', DEVICE_ID, CODE);

      await service.claim('alice', DEVICE_ID, CODE);

      expect(store.claims).toHaveLength(1);
    });
  });

  describe('an old report', () => {
    it('is accepted right up to the limit', async () => {
      const { service } = setUp(null, report({ storedAt: NOW - CLAIM_REPORT_LIFETIME_MS }));

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toMatchObject({
        result: 'claimed',
      });
    });

    it('is refused after 7 days', async () => {
      const { service, store } = setUp(null, report({ storedAt: NOW - CLAIM_REPORT_LIFETIME_MS - 1 }));

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toEqual({ result: 'expired' });
      expect(store.claims).toHaveLength(0);
    });
  });

  describe('an owned controller after a factory reset', () => {
    it('gets the caller as its new Owner, replacing the previous one', async () => {
      const previous = owned('bob');
      const { service, store } = setUp(previous, report({ reset: true }));

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toMatchObject({
        result: 'claimed',
      });
      expect(store.claims[0].previous).toEqual(previous);
      expect(store.current?.ownerId).toBe('alice');
    });

    it('is a clean start for its own Owner too', async () => {
      const previous = owned('alice');
      const { service, store } = setUp(previous, report({ reset: true }));

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toMatchObject({
        result: 'claimed',
        controller: { name: defaultControllerName(DEVICE_ID) },
      });
      expect(store.claims[0].previous).toEqual(previous);
    });
  });

  describe('an owned controller after a Wi-Fi change', () => {
    it('stays with its Owner, who gets told so', async () => {
      const { service, store, reports } = setUp(owned('alice'), report({ reset: false }));

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toEqual({
        result: 'already_owner',
        controller: owned('alice'),
      });
      expect(store.claims).toHaveLength(0);
      expect(reports.cleared).toBe(0);
    });

    it('stays with its Owner when someone else changes the Wi-Fi', async () => {
      const { service, store } = setUp(owned('bob'), report({ reset: false }));

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toEqual({
        result: 'already_owned',
      });
      expect(store.claims).toHaveLength(0);
      expect(store.current?.ownerId).toBe('bob');
    });
  });

  describe('two users at once', () => {
    it('decides again after losing the race', async () => {
      const { service, store } = setUp(null, report());
      store.conflicts = 1;

      await expect(service.claim('alice', DEVICE_ID, CODE)).resolves.toMatchObject({
        result: 'claimed',
      });
    });

    it('gives up after repeated conflicts', async () => {
      const { service, store } = setUp(null, report());
      store.conflicts = 5;

      await expect(service.claim('alice', DEVICE_ID, CODE)).rejects.toBeInstanceOf(
        ClaimConflictError,
      );
    });

    it('passes on other failures at once', async () => {
      const { service, store } = setUp(null, report());
      const claim = jest.spyOn(store, 'claim').mockRejectedValue(new Error('down'));

      await expect(service.claim('alice', DEVICE_ID, CODE)).rejects.toThrow('down');
      expect(claim).toHaveBeenCalledTimes(1);
    });
  });
});
