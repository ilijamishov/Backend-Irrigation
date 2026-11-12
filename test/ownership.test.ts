import { AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import type { ControllerRecord, Role } from '../lambda/controllers/access-store';
import { CognitoUsers } from '../lambda/controllers/cognito-users';
import { OwnershipService } from '../lambda/controllers/ownership-service';
import { DynamoOwnershipStore, type OwnershipStore } from '../lambda/controllers/ownership-store';

const TABLE = 'irrigation-access';
const DEVICE_ID = '1C8F57371AA4';
const PK = `CONTROLLER#${DEVICE_ID}`;
const NOW = Date.parse('2026-11-12T10:00:00.000Z');

const named = (name: string) => Object.assign(new Error(name), { name });

function fakeClient(answer: (command: unknown) => unknown = () => ({})) {
  const sent: { input: Record<string, unknown> }[] = [];
  const send = jest.fn(async (command: { input: Record<string, unknown> }) => {
    sent.push(command);
    const result = answer(command);
    if (result instanceof Error) throw result;
    return result;
  });
  return { send: send as never, sent };
}

type TransactItem = Record<string, Record<string, unknown>>;

function transactionOf(sent: { input: Record<string, unknown> }[]): TransactItem[] {
  const command = sent.find((c) => c instanceof TransactWriteCommand);
  return (command?.input as { TransactItems: TransactItem[] }).TransactItems;
}

describe('DynamoOwnershipStore', () => {
  describe('transfer', () => {
    it('makes the Manager the Owner, removes the Owner and the location, at once', async () => {
      const client = fakeClient();

      await expect(
        new DynamoOwnershipStore(client, TABLE).transfer(DEVICE_ID, 'alice', 'bob'),
      ).resolves.toBe(true);

      const [meta, newOwner, oldOwner] = transactionOf(client.sent);
      expect(meta.Update).toMatchObject({
        Key: { PK, SK: 'META' },
        UpdateExpression: 'SET ownerId = :newOwner REMOVE #location',
        ConditionExpression: 'ownerId = :owner',
        ExpressionAttributeValues: { ':newOwner': 'bob', ':owner': 'alice' },
      });
      expect(newOwner.Update).toMatchObject({
        Key: { PK, SK: 'USER#bob' },
        ConditionExpression: '#role = :manager',
        ExpressionAttributeValues: { ':owner': 'owner', ':manager': 'manager' },
      });
      expect(oldOwner.Delete).toMatchObject({
        Key: { PK, SK: 'USER#alice' },
        ConditionExpression: '#role = :owner',
      });
    });

    it('answers false when a condition doesn\'t hold', async () => {
      const client = fakeClient(() => named('TransactionCanceledException'));

      await expect(
        new DynamoOwnershipStore(client, TABLE).transfer(DEVICE_ID, 'alice', 'bob'),
      ).resolves.toBe(false);
    });
  });

  describe('release', () => {
    const items = {
      Items: [
        { SK: 'META' },
        { SK: 'USER#alice' },
        { SK: 'USER#bob' },
        { SK: 'ZONE#1' },
        { SK: 'INVITE#pending', codeHash: 'pending-hash', expiresAtSeconds: NOW / 1000 + 60 },
        { SK: 'INVITE#old', codeHash: 'old-hash', expiresAtSeconds: NOW / 1000 - 60 },
      ],
    };

    it('deletes everything of the controller, only for its Owner, and names who lost access', async () => {
      const client = fakeClient((command) => (command instanceof QueryCommand ? items : {}));

      const removed = await new DynamoOwnershipStore(client, TABLE, () => NOW).release(
        DEVICE_ID,
        'alice',
      );

      expect(removed).toEqual(['alice', 'bob']);
      const deletes = transactionOf(client.sent).map((item) => item.Delete);
      expect(deletes[0]).toMatchObject({
        Key: { PK, SK: 'META' },
        ConditionExpression: 'ownerId = :owner',
        ExpressionAttributeValues: { ':owner': 'alice' },
      });
      expect(deletes.map((d) => (d.Key as { PK: string; SK: string }).SK)).toEqual([
        'META',
        'USER#alice',
        'USER#bob',
        'ZONE#1',
        'INVITE#pending',
        'INVITE#old',
        'META',
      ]);
      // Only the pending invitation's code: an expired code may be another's.
      expect(deletes[6].Key).toEqual({ PK: 'INVITATION#pending-hash', SK: 'META' });
    });

    it('answers null for anyone but the Owner', async () => {
      const client = fakeClient((command) =>
        command instanceof QueryCommand ? items : named('TransactionCanceledException'),
      );

      await expect(
        new DynamoOwnershipStore(client, TABLE, () => NOW).release(DEVICE_ID, 'bob'),
      ).resolves.toBeNull();
    });
  });
});

describe('CognitoUsers', () => {
  it('deletes a user by their username', async () => {
    const client = fakeClient();

    await new CognitoUsers(client, 'pool').deleteUser('google_1');

    expect(client.sent[0]).toBeInstanceOf(AdminDeleteUserCommand);
    expect(client.sent[0].input).toEqual({ UserPoolId: 'pool', Username: 'google_1' });
  });

  it('does nothing for a user that is gone already', async () => {
    const client = fakeClient(() => named('UserNotFoundException'));

    await expect(new CognitoUsers(client, 'pool').deleteUser('google_1')).resolves.toBeUndefined();
  });
});

describe('OwnershipService', () => {
  function setUp(access: { deviceId: string; role: Role }[] = []) {
    const record: ControllerRecord = {
      deviceId: DEVICE_ID,
      name: 'Home',
      ownerId: 'alice',
      lastClaimHash: 'hash',
    };
    const store: OwnershipStore & { transferred: boolean; releasedBy: string[] } = {
      transferred: true,
      releasedBy: [],
      transfer: jest.fn(async function (this: void) {
        return store.transferred;
      }),
      release: jest.fn(async (_deviceId: string, ownerId: string) => {
        store.releasedBy.push(ownerId);
        return ownerId === 'alice' ? ['alice', 'bob'] : null;
      }),
    };
    const left: string[] = [];
    const revoked: string[] = [];
    const deleted: string[] = [];
    const service = new OwnershipService(
      {
        find: async (deviceId) => (deviceId === DEVICE_ID ? record : null),
        accessOf: async () => access,
      },
      store,
      {
        leave: async (deviceId) => {
          left.push(deviceId);
          return true;
        },
      },
      { deleteUser: async (username) => void deleted.push(username) },
      { revoke: async (userId) => void revoked.push(userId) },
    );
    return { service, store, left, revoked, deleted };
  }

  describe('transfer', () => {
    it('hands the controller to a Manager and closes both connections', async () => {
      const { service, revoked } = setUp();

      await expect(service.transfer('alice', DEVICE_ID, 'bob')).resolves.toEqual({ result: 'ok' });
      expect(revoked.sort()).toEqual(['alice', 'bob']);
    });

    it('is only for the Owner', async () => {
      const { service, store } = setUp();

      await expect(service.transfer('bob', DEVICE_ID, 'carol')).resolves.toEqual({
        result: 'not_owner',
      });
      expect(store.transfer).not.toHaveBeenCalled();
    });

    it('goes only to a Manager', async () => {
      const { service, store, revoked } = setUp();
      store.transferred = false;

      await expect(service.transfer('alice', DEVICE_ID, 'stranger')).resolves.toEqual({
        result: 'not_a_manager',
      });
      expect(revoked).toEqual([]);
    });

    it('can\'t go to the Owner themselves', async () => {
      const { service } = setUp();

      await expect(service.transfer('alice', DEVICE_ID, 'alice')).resolves.toEqual({
        result: 'not_a_manager',
      });
    });
  });

  describe('release', () => {
    it('closes the connections of everyone who lost access', async () => {
      const { service, revoked } = setUp();

      await expect(service.release('alice', DEVICE_ID)).resolves.toEqual({ result: 'ok' });
      expect(revoked.sort()).toEqual(['alice', 'bob']);
    });

    it('is only for the Owner', async () => {
      const { service, revoked } = setUp();

      await expect(service.release('bob', DEVICE_ID)).resolves.toEqual({ result: 'not_owner' });
      expect(revoked).toEqual([]);
    });
  });

  describe('deleting an account', () => {
    it('is refused while the user owns a controller, and names them', async () => {
      const { service, deleted } = setUp([
        { deviceId: DEVICE_ID, role: 'owner' },
        { deviceId: 'AAAAAAAAAAAA', role: 'manager' },
      ]);

      await expect(service.deleteAccount('alice', 'google_1')).resolves.toEqual({
        result: 'owns_controllers',
        deviceIds: [DEVICE_ID],
      });
      expect(deleted).toEqual([]);
    });

    it('leaves every controller, closes the connections, then deletes the sign-in', async () => {
      const { service, left, revoked, deleted } = setUp([
        { deviceId: DEVICE_ID, role: 'manager' },
        { deviceId: 'AAAAAAAAAAAA', role: 'manager' },
      ]);

      await expect(service.deleteAccount('bob', 'google_2')).resolves.toEqual({ result: 'ok' });
      expect(left).toEqual([DEVICE_ID, 'AAAAAAAAAAAA']);
      expect(revoked).toEqual(['bob']);
      expect(deleted).toEqual(['google_2']);
    });
  });
});
