import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  ClaimConflictError,
  type ControllerRecord,
  DynamoAccessStore,
  type NewOwner,
  ZoneConflictError,
} from '../lambda/controllers/access-store';

const TABLE = 'irrigation-access';
const INDEX = 'byUser';
const DEVICE_ID = '1C8F57371AA4';
const PK = `CONTROLLER#${DEVICE_ID}`;

const named = (name: string) => Object.assign(new Error(name), { name });

/** Answers by command type, and remembers what was sent. */
function fakeClient(answers: Map<unknown, unknown[]> = new Map()) {
  const sent: { input: Record<string, never> }[] = [];
  const send = jest.fn(async (command: { input: Record<string, never> }) => {
    sent.push(command);
    const queue = answers.get(command.constructor) ?? [];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer instanceof Error) throw answer;
    return answer ?? {};
  });
  return { send: send as never, sent };
}

const store = (client: { send: never }) => new DynamoAccessStore(client, TABLE, INDEX);

const newOwner = (previous: ControllerRecord | null = null): NewOwner => ({
  deviceId: DEVICE_ID,
  userId: 'alice',
  name: 'Controller 1AA4',
  codeHash: 'hash-new',
  claimedAt: '2026-11-04T17:00:00.000Z',
  previous,
});

const previous: ControllerRecord = {
  deviceId: DEVICE_ID,
  name: 'Home Garden',
  ownerId: 'bob',
  lastClaimHash: 'hash-old',
};

function transactionOf(sent: { input: Record<string, never> }[]) {
  const command = sent.find((c) => c instanceof TransactWriteCommand);
  return (command?.input as unknown as { TransactItems: Record<string, never>[] }).TransactItems;
}

describe('DynamoAccessStore', () => {
  describe('find', () => {
    it('reads the latest state of the controller', async () => {
      const client = fakeClient(
        new Map([[GetCommand, [{ Item: { name: 'Home', ownerId: 'bob', lastClaimHash: 'h' } }]]]),
      );

      await expect(store(client).find(DEVICE_ID)).resolves.toEqual({
        deviceId: DEVICE_ID,
        name: 'Home',
        ownerId: 'bob',
        lastClaimHash: 'h',
      });
      expect(client.sent[0].input).toEqual({
        TableName: TABLE,
        Key: { PK, SK: 'META' },
        ConsistentRead: true,
      });
    });

    it('finds nothing for an unknown controller', async () => {
      await expect(store(fakeClient()).find(DEVICE_ID)).resolves.toBeNull();
    });
  });

  describe('claim of an unowned controller', () => {
    it('writes the controller and its Owner together, only if nobody got there first', async () => {
      const client = fakeClient();

      const claimed = await store(client).claim(newOwner());

      expect(claimed).toEqual({
        controller: {
          deviceId: DEVICE_ID,
          name: 'Controller 1AA4',
          ownerId: 'alice',
          lastClaimHash: 'hash-new',
        },
        removedUserIds: [],
      });

      const [meta, user, ...rest] = transactionOf(client.sent);
      expect(rest).toEqual([]);
      expect(meta).toEqual({
        Put: {
          TableName: TABLE,
          Item: {
            PK,
            SK: 'META',
            ownerId: 'alice',
            name: 'Controller 1AA4',
            lastClaimHash: 'hash-new',
            claimedAt: '2026-11-04T17:00:00.000Z',
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
      expect(user).toEqual({
        Put: {
          TableName: TABLE,
          Item: { PK, SK: 'USER#alice', userId: 'alice', role: 'owner' },
        },
      });
    });

    it('reports losing the race as a conflict', async () => {
      const client = fakeClient(
        new Map([[TransactWriteCommand, [named('TransactionCanceledException')]]]),
      );

      await expect(store(client).claim(newOwner())).rejects.toBeInstanceOf(ClaimConflictError);
    });

    it('passes on other failures', async () => {
      const client = fakeClient(new Map([[TransactWriteCommand, [named('AccessDeniedException')]]]));

      await expect(store(client).claim(newOwner())).rejects.toThrow('AccessDeniedException');
    });
  });

  describe('claim after a factory reset', () => {
    const items = {
      Items: [
        { SK: 'META' },
        { SK: 'USER#bob' },
        { SK: 'USER#carol' },
        { SK: 'ZONE#1' },
      ],
    };

    it('removes everyone and everything else, in the same transaction', async () => {
      const client = fakeClient(new Map([[QueryCommand, [items]]]));

      await store(client).claim(newOwner(previous));

      const deleted = transactionOf(client.sent)
        .filter((item) => 'Delete' in item)
        .map((item) => (item as unknown as { Delete: { Key: { SK: string } } }).Delete.Key.SK);
      expect(deleted).toEqual(['USER#bob', 'USER#carol', 'ZONE#1']);
    });

    it('names everyone whose access it ended, so their connections can close', async () => {
      const client = fakeClient(new Map([[QueryCommand, [items]]]));

      const claimed = await store(client).claim(newOwner(previous));

      expect(claimed.removedUserIds).toEqual(['bob', 'carol']);
    });

    it('only goes ahead if the controller is as it was read', async () => {
      const client = fakeClient(new Map([[QueryCommand, [items]]]));

      await store(client).claim(newOwner(previous));

      const [meta] = transactionOf(client.sent) as unknown as {
        Put: Record<string, unknown>;
      }[];
      expect(meta.Put.ConditionExpression).toBe(
        'ownerId = :previousOwner AND lastClaimHash = :previousHash',
      );
      expect(meta.Put.ExpressionAttributeValues).toEqual({
        ':previousOwner': 'bob',
        ':previousHash': 'hash-old',
      });
    });

    it('does not delete the item it writes when the Owner claims again', async () => {
      const client = fakeClient(
        new Map([[QueryCommand, [{ Items: [{ SK: 'META' }, { SK: 'USER#alice' }, { SK: 'USER#bob' }] }]]]),
      );

      await store(client).claim(newOwner({ ...previous, ownerId: 'alice' }));

      const items = transactionOf(client.sent);
      const deleted = items
        .filter((item) => 'Delete' in item)
        .map((item) => (item as unknown as { Delete: { Key: { SK: string } } }).Delete.Key.SK);
      // DynamoDB refuses a transaction with two operations on one item.
      expect(deleted).toEqual(['USER#bob']);
      // The Owner keeps their access, so their connections stay open.
      const claimed = await store(
        fakeClient(
          new Map([[QueryCommand, [{ Items: [{ SK: 'META' }, { SK: 'USER#alice' }] }]]]),
        ),
      ).claim(newOwner({ ...previous, ownerId: 'alice' }));
      expect(claimed.removedUserIds).toEqual([]);
    });

    it('reads every page of items', async () => {
      const client = fakeClient(
        new Map([
          [
            QueryCommand,
            [
              { Items: [{ SK: 'META' }, { SK: 'USER#bob' }], LastEvaluatedKey: { PK, SK: 'USER#bob' } },
              { Items: [{ SK: 'USER#carol' }] },
            ],
          ],
        ]),
      );

      await store(client).claim(newOwner(previous));

      const deleted = transactionOf(client.sent).filter((item) => 'Delete' in item);
      expect(deleted).toHaveLength(2);
    });
  });

  describe('controllersOf', () => {
    it("lists the user's controllers by name, with their role", async () => {
      const client = fakeClient(
        new Map<unknown, unknown[]>([
          [
            QueryCommand,
            [
              {
                Items: [
                  { PK: 'CONTROLLER#AAAAAAAAAAAA', role: 'owner' },
                  { PK: 'CONTROLLER#BBBBBBBBBBBB', role: 'manager' },
                ],
              },
            ],
          ],
          [
            BatchGetCommand,
            [
              {
                Responses: {
                  [TABLE]: [
                    { PK: 'CONTROLLER#AAAAAAAAAAAA', name: 'Vacation' },
                    { PK: 'CONTROLLER#BBBBBBBBBBBB', name: 'Home' },
                  ],
                },
              },
            ],
          ],
        ]),
      );

      await expect(store(client).controllersOf('alice')).resolves.toEqual([
        { deviceId: 'BBBBBBBBBBBB', name: 'Home', role: 'manager' },
        { deviceId: 'AAAAAAAAAAAA', name: 'Vacation', role: 'owner' },
      ]);
      expect(client.sent[0].input).toMatchObject({
        IndexName: INDEX,
        ExpressionAttributeValues: { ':userId': 'alice' },
      });
    });

    it('has nothing to read for a user without controllers', async () => {
      const client = fakeClient(new Map([[QueryCommand, [{ Items: [] }]]]));

      await expect(store(client).controllersOf('alice')).resolves.toEqual([]);
      expect(client.sent.some((c) => c instanceof BatchGetCommand)).toBe(false);
    });

    it('reads again what DynamoDB left unread', async () => {
      const key = { PK: 'CONTROLLER#BBBBBBBBBBBB', SK: 'META' };
      const client = fakeClient(
        new Map<unknown, unknown[]>([
          [
            QueryCommand,
            [
              {
                Items: [
                  { PK: 'CONTROLLER#AAAAAAAAAAAA', role: 'owner' },
                  { PK: 'CONTROLLER#BBBBBBBBBBBB', role: 'owner' },
                ],
              },
            ],
          ],
          [
            BatchGetCommand,
            [
              {
                Responses: { [TABLE]: [{ PK: 'CONTROLLER#AAAAAAAAAAAA', name: 'A' }] },
                UnprocessedKeys: { [TABLE]: { Keys: [key] } },
              },
              { Responses: { [TABLE]: [{ PK: key.PK, name: 'B' }] } },
            ],
          ],
        ]),
      );

      await expect(store(client).controllersOf('alice')).resolves.toHaveLength(2);
    });
  });

  describe('zones', () => {
    const zone = {
      zoneId: 'lawn',
      name: 'Back lawn',
      relay: 5,
      enabled: true,
      createdAt: '2026-11-04T10:00:00.000Z',
    };

    it('reads the role of a user', async () => {
      const client = fakeClient(new Map([[GetCommand, [{ Item: { role: 'manager' } }]]]));

      await expect(store(client).roleOf(DEVICE_ID, 'bob')).resolves.toBe('manager');
      expect(client.sent[0].input).toMatchObject({ Key: { PK, SK: 'USER#bob' } });
    });

    it('has no role for a user without access', async () => {
      const client = fakeClient(new Map([[GetCommand, [{}]]]));

      await expect(store(client).roleOf(DEVICE_ID, 'mallory')).resolves.toBeNull();
    });

    it('lists only the zones, in the order they were added, over all pages', async () => {
      const older = { ...zone, zoneId: 'older', createdAt: '2026-11-03T10:00:00.000Z' };
      const client = fakeClient(
        new Map([
          [
            QueryCommand,
            [
              { Items: [{ ...zone, PK, SK: 'ZONE#lawn' }], LastEvaluatedKey: { PK } },
              { Items: [{ ...older, PK, SK: 'ZONE#older' }] },
            ],
          ],
        ]),
      );

      await expect(store(client).zonesOf(DEVICE_ID)).resolves.toEqual([older, zone]);
      expect(client.sent[0].input).toMatchObject({
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :zones)',
        ExpressionAttributeValues: { ':pk': PK, ':zones': 'ZONE#' },
      });
    });

    function versionCheckOf(client: { sent: { input: Record<string, never> }[] }) {
      const [{ Update: update }] = transactionOf(client.sent) as unknown as {
        Update: { ConditionExpression: string; ExpressionAttributeValues: object };
      }[];
      return update;
    }

    it('saves a zone only if the user is the Owner and nothing changed', async () => {
      const client = fakeClient();

      await store(client).saveZone(DEVICE_ID, 'alice', zone, 4);

      expect(versionCheckOf(client)).toMatchObject({
        ConditionExpression: 'ownerId = :userId AND zonesVersion = :current',
        ExpressionAttributeValues: { ':next': 5, ':userId': 'alice', ':current': 4 },
      });
      expect(transactionOf(client.sent)[1]).toMatchObject({
        Put: { Item: { PK, SK: 'ZONE#lawn', relay: 5, name: 'Back lawn' } },
      });
    });

    it('expects no version on the first zone', async () => {
      const client = fakeClient();

      await store(client).saveZone(DEVICE_ID, 'alice', zone, 0);

      expect(versionCheckOf(client)).toMatchObject({
        ConditionExpression: 'ownerId = :userId AND attribute_not_exists(zonesVersion)',
        ExpressionAttributeValues: { ':next': 1 },
      });
    });

    it('deletes a zone under the same conditions', async () => {
      const client = fakeClient();

      await store(client).deleteZone(DEVICE_ID, 'alice', 'lawn', 2);

      expect(versionCheckOf(client)).toMatchObject({
        ExpressionAttributeValues: { ':next': 3, ':current': 2 },
      });
      expect(transactionOf(client.sent)[1]).toMatchObject({
        Delete: { Key: { PK, SK: 'ZONE#lawn' } },
      });
    });

    it('reports losing a race as a conflict', async () => {
      const client = fakeClient(
        new Map([[TransactWriteCommand, [named('TransactionCanceledException')]]]),
      );

      await expect(store(client).saveZone(DEVICE_ID, 'alice', zone, 1)).rejects.toBeInstanceOf(
        ZoneConflictError,
      );
    });

    it('passes on other failures', async () => {
      const client = fakeClient(new Map([[TransactWriteCommand, [named('AccessDeniedException')]]]));

      await expect(store(client).saveZone(DEVICE_ID, 'alice', zone, 1)).rejects.toThrow(
        'AccessDeniedException',
      );
    });

    it('do not survive a claim after a factory reset', async () => {
      const client = fakeClient(
        new Map([
          [QueryCommand, [{ Items: [{ SK: 'META' }, { SK: 'USER#bob' }, { SK: 'ZONE#lawn' }] }]],
        ]),
      );

      await store(client).claim(newOwner(previous));

      expect(transactionOf(client.sent)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Delete: expect.objectContaining({ Key: { PK, SK: 'ZONE#lawn' } }) }),
        ]),
      );
    });

    it('reads the version with the controller', async () => {
      const client = fakeClient(
        new Map([[GetCommand, [{ Item: { name: 'Home', ownerId: 'alice', zonesVersion: 3 } }]]]),
      );

      await expect(store(client).find(DEVICE_ID)).resolves.toMatchObject({ zonesVersion: 3 });
    });
  });

  describe('location', () => {
    const location = {
      latitude: 42,
      longitude: 21.43,
      timeZone: 'Europe/Skopje',
      posixTimeZone: 'CET-1CEST,M3.5.0,M10.5.0/3',
    };

    it('is saved only if the user is the Owner', async () => {
      const client = fakeClient(
        new Map([
          [UpdateCommand, [{ Attributes: { name: 'Home', ownerId: 'alice', location } }]],
        ]),
      );

      await expect(store(client).setLocation(DEVICE_ID, 'alice', location)).resolves.toMatchObject(
        { location },
      );
      expect(client.sent[0].input).toMatchObject({
        ConditionExpression: 'ownerId = :userId',
        ExpressionAttributeValues: { ':value': location, ':userId': 'alice' },
      });
    });

    it('answers null for anyone else', async () => {
      const client = fakeClient(
        new Map([[UpdateCommand, [named('ConditionalCheckFailedException')]]]),
      );

      await expect(store(client).setLocation(DEVICE_ID, 'bob', location)).resolves.toBeNull();
    });

    it('is listed for the Owner and never for a Manager', async () => {
      const client = fakeClient(
        new Map<unknown, unknown[]>([
          [
            QueryCommand,
            [
              {
                Items: [
                  { PK: 'CONTROLLER#AAAAAAAAAAAA', role: 'owner' },
                  { PK: 'CONTROLLER#BBBBBBBBBBBB', role: 'manager' },
                  { PK: 'CONTROLLER#CCCCCCCCCCCC', role: 'owner' },
                ],
              },
            ],
          ],
          [
            BatchGetCommand,
            [
              {
                Responses: {
                  [TABLE]: [
                    { PK: 'CONTROLLER#AAAAAAAAAAAA', name: 'A', location },
                    { PK: 'CONTROLLER#BBBBBBBBBBBB', name: 'B', location },
                    { PK: 'CONTROLLER#CCCCCCCCCCCC', name: 'C' },
                  ],
                },
              },
            ],
          ],
        ]),
      );

      await expect(store(client).controllersOf('alice')).resolves.toEqual([
        { deviceId: 'AAAAAAAAAAAA', name: 'A', role: 'owner', location },
        { deviceId: 'BBBBBBBBBBBB', name: 'B', role: 'manager' },
        { deviceId: 'CCCCCCCCCCCC', name: 'C', role: 'owner' },
      ]);
    });

    it('is read back with the controller', async () => {
      const client = fakeClient(
        new Map([[GetCommand, [{ Item: { name: 'Home', ownerId: 'alice', location } }]]]),
      );

      await expect(store(client).find(DEVICE_ID)).resolves.toMatchObject({ location });
    });

    it('does not survive a new claim, which replaces the whole item', async () => {
      const client = fakeClient();

      await store(client).claim(newOwner({ ...previous, location }));

      const [{ Put: put }] = transactionOf(client.sent) as unknown as {
        Put: { Item: Record<string, unknown> };
      }[];
      expect(put.Item).not.toHaveProperty('location');
    });
  });

  describe('rename', () => {
    it('changes the name only if the user is the Owner', async () => {
      const client = fakeClient(
        new Map([
          [UpdateCommand, [{ Attributes: { name: 'Home', ownerId: 'alice', lastClaimHash: 'h' } }]],
        ]),
      );

      await expect(store(client).rename(DEVICE_ID, 'alice', 'Home')).resolves.toMatchObject({
        name: 'Home',
      });
      expect(client.sent[0].input).toMatchObject({
        ConditionExpression: 'ownerId = :userId',
        ExpressionAttributeNames: { '#attribute': 'name' },
        ExpressionAttributeValues: { ':value': 'Home', ':userId': 'alice' },
      });
    });

    it('answers null for anyone else, and for a controller that does not exist', async () => {
      const client = fakeClient(
        new Map([[UpdateCommand, [named('ConditionalCheckFailedException')]]]),
      );

      await expect(store(client).rename(DEVICE_ID, 'bob', 'Mine')).resolves.toBeNull();
    });

    it('passes on other failures', async () => {
      const client = fakeClient(new Map([[UpdateCommand, [named('AccessDeniedException')]]]));

      await expect(store(client).rename(DEVICE_ID, 'alice', 'Home')).rejects.toThrow(
        'AccessDeniedException',
      );
    });
  });
});
