import {
  type DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

import type { Role } from './access-store';
import { EXPIRY_ATTRIBUTE } from './connections';

/** Changing who owns a controller (the app repo's docs/user-roles.md §5). */
export interface OwnershipStore {
  /**
   * Makes the Manager [newOwnerId] the Owner, removes [ownerId], and deletes
   * the location, all at once. False unless [ownerId] is the Owner and
   * [newOwnerId] a Manager.
   */
  transfer(deviceId: string, ownerId: string, newOwnerId: string): Promise<boolean>;

  /**
   * Deletes everything stored for the controller, so it is unowned. Returns
   * the users who lost access, or null unless [ownerId] is the Owner.
   */
  release(deviceId: string, ownerId: string): Promise<string[] | null>;
}

const META = 'META';
const USER_PREFIX = 'USER#';
const INVITE_PREFIX = 'INVITE#';
const LOOKUP_PREFIX = 'INVITATION#';

export class DynamoOwnershipStore implements OwnershipStore {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly tableName: string,
    private readonly now: () => number = Date.now,
  ) {}

  transfer(deviceId: string, ownerId: string, newOwnerId: string): Promise<boolean> {
    const pk = controllerKey(deviceId);

    return this.transact([
      {
        Update: {
          TableName: this.tableName,
          Key: { PK: pk, SK: META },
          // The location shows where the Owner lives: it doesn't pass on.
          UpdateExpression: 'SET ownerId = :newOwner REMOVE #location',
          ConditionExpression: 'ownerId = :owner',
          ExpressionAttributeNames: { '#location': 'location' },
          ExpressionAttributeValues: { ':newOwner': newOwnerId, ':owner': ownerId },
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: { PK: pk, SK: `${USER_PREFIX}${newOwnerId}` },
          // The email is for telling Managers apart; the Owner is "You".
          UpdateExpression: 'SET #role = :owner REMOVE email',
          ConditionExpression: '#role = :manager',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: {
            ':owner': 'owner' satisfies Role,
            ':manager': 'manager' satisfies Role,
          },
        },
      },
      {
        Delete: {
          TableName: this.tableName,
          Key: { PK: pk, SK: `${USER_PREFIX}${ownerId}` },
          ConditionExpression: '#role = :owner',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':owner': 'owner' satisfies Role },
        },
      },
    ]);
  }

  async release(deviceId: string, ownerId: string): Promise<string[] | null> {
    const pk = controllerKey(deviceId);
    const items = await this.itemsOf(deviceId);
    const others = items.filter((item) => item.SK !== META);

    const released = await this.transact([
      {
        Delete: {
          TableName: this.tableName,
          Key: { PK: pk, SK: META },
          ConditionExpression: 'ownerId = :owner',
          ExpressionAttributeValues: { ':owner': ownerId },
        },
      },
      ...others.map((item) => ({
        Delete: { TableName: this.tableName, Key: { PK: pk, SK: item.SK } },
      })),
      // Pending invitations, so their codes stop working at once. Not expired
      // ones: their code may already belong to another invitation.
      ...others
        .filter(
          (item) =>
            item.SK.startsWith(INVITE_PREFIX) &&
            item.codeHash &&
            (item.expiresAtSeconds ?? 0) > this.now() / 1000,
        )
        .map((item) => ({
          Delete: {
            TableName: this.tableName,
            Key: { PK: `${LOOKUP_PREFIX}${item.codeHash}`, SK: META },
          },
        })),
    ]);
    if (!released) return null;

    return others
      .filter((item) => item.SK.startsWith(USER_PREFIX))
      .map((item) => item.SK.slice(USER_PREFIX.length));
  }

  /** False when a condition doesn't hold. */
  private async transact(items: Record<string, unknown>[]): Promise<boolean> {
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items as never }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') return false;
      throw error;
    }
  }

  private async itemsOf(deviceId: string): Promise<StoredItem[]> {
    const items: StoredItem[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': controllerKey(deviceId) },
          ProjectionExpression: 'SK, codeHash, #expiry',
          ExpressionAttributeNames: { '#expiry': EXPIRY_ATTRIBUTE },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) {
        items.push({
          SK: item.SK as string,
          codeHash: item.codeHash as string | undefined,
          expiresAtSeconds: item[EXPIRY_ATTRIBUTE] as number | undefined,
        });
      }
      start = page.LastEvaluatedKey;
    } while (start);

    return items;
  }
}

interface StoredItem {
  readonly SK: string;
  readonly codeHash?: string;
  readonly expiresAtSeconds?: number;
}

function controllerKey(deviceId: string): string {
  return `CONTROLLER#${deviceId}`;
}
