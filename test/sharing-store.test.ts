import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { DynamoSharingStore, type Invitation } from '../lambda/controllers/sharing-store';

const TABLE = 'irrigation-access';
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

function transactionOf(sent: { input: Record<string, never> }[]) {
  const command = sent.find((c) => c instanceof TransactWriteCommand);
  return (command?.input as unknown as { TransactItems: Record<string, never>[] }).TransactItems;
}

const invitation: Invitation = {
  invitationId: '00000000-0000-4000-8000-000000000001',
  deviceId: DEVICE_ID,
  codeHash: 'hash-of-code',
  createdAt: '2026-11-12T10:00:00.000Z',
  expiresAt: '2026-11-15T10:00:00.000Z',
};

const NOW = Date.parse('2026-11-12T10:30:00.000Z');
const store = (client: { send: never }) => new DynamoSharingStore(client, TABLE, () => NOW);

describe('DynamoSharingStore', () => {
  it('reads the people of a controller, with a Manager\'s email', async () => {
    const client = fakeClient(
      new Map([
        [
          QueryCommand,
          [
            {
              Items: [
                { userId: 'o', role: 'owner' },
                { userId: 'm', role: 'manager', email: 'm@example.com' },
              ],
            },
          ],
        ],
      ]),
    );

    await expect(store(client).membersOf(DEVICE_ID)).resolves.toEqual([
      { userId: 'o', role: 'owner' },
      { userId: 'm', role: 'manager', email: 'm@example.com' },
    ]);
    expect(client.sent[0].input).toMatchObject({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'USER#' },
    });
  });

  it('finds an invitation by the hash of its code', async () => {
    const client = fakeClient(
      new Map([[GetCommand, [{ Item: { ...invitation, PK: 'x', SK: 'META' } }]]]),
    );

    await expect(store(client).invitationByCode('hash-of-code')).resolves.toEqual(invitation);
    expect(client.sent[0].input).toMatchObject({
      Key: { PK: 'INVITATION#hash-of-code', SK: 'META' },
      ConsistentRead: true,
    });
  });

  describe('adding an invitation', () => {
    it('checks the Owner and writes both items, which expire with it', async () => {
      const client = fakeClient();

      await expect(store(client).addInvitation('owner', invitation)).resolves.toBe(true);

      const [check, underController, lookup] = transactionOf(client.sent) as Record<
        string,
        Record<string, unknown>
      >[];
      expect(check.ConditionCheck).toMatchObject({
        Key: { PK, SK: 'META' },
        ConditionExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: { ':ownerId': 'owner' },
      });
      expect(underController.Put).toMatchObject({
        Item: {
          PK,
          SK: `INVITE#${invitation.invitationId}`,
          expiresAtSeconds: Date.parse(invitation.expiresAt) / 1000,
        },
      });
      expect(lookup.Put).toMatchObject({
        Item: { PK: 'INVITATION#hash-of-code', SK: 'META', deviceId: DEVICE_ID },
        // A code of an expired invitation is free again.
        ConditionExpression: 'attribute_not_exists(PK) OR #expiry < :now',
        ExpressionAttributeNames: { '#expiry': 'expiresAtSeconds' },
        ExpressionAttributeValues: { ':now': NOW / 1000 },
      });
    });

    it('stores no user ID, so the index of a user\'s controllers never sees it', async () => {
      const client = fakeClient();

      await store(client).addInvitation('owner', invitation);

      expect(JSON.stringify(transactionOf(client.sent))).not.toContain('userId');
    });

    it('answers false when the user isn\'t the Owner', async () => {
      const client = fakeClient(
        new Map([[TransactWriteCommand, [named('TransactionCanceledException')]]]),
      );

      await expect(store(client).addInvitation('someone', invitation)).resolves.toBe(false);
    });
  });

  describe('accepting an invitation', () => {
    it('adds the Manager and removes both items, each only if still there', async () => {
      const client = fakeClient();

      await expect(
        store(client).acceptInvitation(invitation, {
          userId: 'm',
          role: 'manager',
          email: 'm@example.com',
        }),
      ).resolves.toBe(true);

      const [check, put, ...deletes] = transactionOf(client.sent) as Record<
        string,
        Record<string, unknown>
      >[];
      // Not onto a controller released meanwhile.
      expect(check.ConditionCheck).toMatchObject({
        Key: { PK, SK: 'META' },
        ConditionExpression: 'attribute_exists(PK)',
      });
      expect(put.Put).toMatchObject({
        Item: { PK, SK: 'USER#m', userId: 'm', role: 'manager', email: 'm@example.com' },
        ConditionExpression: 'attribute_not_exists(PK)',
      });
      expect(deletes.map((item) => item.Delete)).toEqual([
        expect.objectContaining({
          Key: { PK, SK: `INVITE#${invitation.invitationId}` },
          ConditionExpression: 'attribute_exists(PK)',
        }),
        expect.objectContaining({
          Key: { PK: 'INVITATION#hash-of-code', SK: 'META' },
          ConditionExpression: 'attribute_exists(PK)',
        }),
      ]);
    });

    it('answers false when the invitation went, or the user has a role already', async () => {
      const client = fakeClient(
        new Map([[TransactWriteCommand, [named('TransactionCanceledException')]]]),
      );

      await expect(
        store(client).acceptInvitation(invitation, { userId: 'm', role: 'manager' }),
      ).resolves.toBe(false);
    });

    it('passes on any other failure', async () => {
      const client = fakeClient(new Map([[TransactWriteCommand, [named('InternalServerError')]]]));

      await expect(
        store(client).acceptInvitation(invitation, { userId: 'm', role: 'manager' }),
      ).rejects.toThrow('InternalServerError');
    });
  });

  it('removes only a Manager, and only for the Owner', async () => {
    const client = fakeClient();

    await store(client).removeManager(DEVICE_ID, 'owner', 'm');

    const [check, remove] = transactionOf(client.sent) as Record<string, Record<string, unknown>>[];
    expect(check.ConditionCheck).toMatchObject({ ExpressionAttributeValues: { ':ownerId': 'owner' } });
    expect(remove.Delete).toMatchObject({
      Key: { PK, SK: 'USER#m' },
      ConditionExpression: '#role = :manager',
    });
  });

  it('lets only a Manager leave', async () => {
    const client = fakeClient(
      new Map([[TransactWriteCommand, [named('TransactionCanceledException')]]]),
    );

    await expect(store(client).leave(DEVICE_ID, 'owner')).resolves.toBe(false);
    const [remove] = transactionOf(client.sent) as Record<string, Record<string, unknown>>[];
    expect(remove.Delete).toMatchObject({ ConditionExpression: '#role = :manager' });
  });
});
