import {
  BatchGetCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export type Role = 'owner' | 'manager';

/** Who owns a controller, and the claim code that made them its Owner. */
export interface ControllerRecord {
  readonly deviceId: string;
  readonly name: string;
  readonly ownerId: string;
  readonly lastClaimHash: string;
}

/** A controller as one user sees it. */
export interface UserController {
  readonly deviceId: string;
  readonly name: string;
  readonly role: Role;
}

export interface NewOwner {
  readonly deviceId: string;
  readonly userId: string;
  readonly name: string;
  readonly codeHash: string;
  readonly claimedAt: string;
  /** What the claim replaces. Everyone's access to it ends. */
  readonly previous: ControllerRecord | null;
}

/** Someone else changed the controller between reading it and claiming it. */
export class ClaimConflictError extends Error {
  constructor() {
    super('The controller changed during the claim.');
    this.name = 'ClaimConflictError';
  }
}

/** Who may reach which controller. */
export interface AccessStore {
  find(deviceId: string): Promise<ControllerRecord | null>;
  /** Makes the user the sole Owner, or throws [ClaimConflictError]. */
  claim(owner: NewOwner): Promise<ControllerRecord>;
  controllersOf(userId: string): Promise<UserController[]>;
  /** Only which controllers and roles, without reading their names. */
  accessOf(userId: string): Promise<{ deviceId: string; role: Role }[]>;
  /** Returns null unless the user is the Owner. */
  rename(deviceId: string, userId: string, name: string): Promise<ControllerRecord | null>;
}

const META = 'META';

/** One item per controller, and one per user with access to it. */
export class DynamoAccessStore implements AccessStore {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly tableName: string,
    private readonly userIndexName: string,
  ) {}

  async find(deviceId: string): Promise<ControllerRecord | null> {
    const { Item: item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: controllerKey(deviceId), SK: META },
        ConsistentRead: true,
      }),
    );
    return item ? recordOf(deviceId, item) : null;
  }

  async claim(owner: NewOwner): Promise<ControllerRecord> {
    const userItem = userKey(owner.userId);
    const others = owner.previous
      ? (await this.itemsOf(owner.deviceId)).filter((sk) => sk !== META && sk !== userItem)
      : [];

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: controllerKey(owner.deviceId),
                  SK: META,
                  ownerId: owner.userId,
                  name: owner.name,
                  lastClaimHash: owner.codeHash,
                  claimedAt: owner.claimedAt,
                },
                // Exactly one claim wins, so a controller never has two Owners.
                ...unchangedSince(owner.previous),
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: controllerKey(owner.deviceId),
                  SK: userItem,
                  userId: owner.userId,
                  role: 'owner' satisfies Role,
                },
              },
            },
            ...others.map((sk) => ({
              Delete: {
                TableName: this.tableName,
                Key: { PK: controllerKey(owner.deviceId), SK: sk },
              },
            })),
          ],
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        throw new ClaimConflictError();
      }
      throw error;
    }

    return {
      deviceId: owner.deviceId,
      name: owner.name,
      ownerId: owner.userId,
      lastClaimHash: owner.codeHash,
    };
  }

  async controllersOf(userId: string): Promise<UserController[]> {
    const access = await this.accessOf(userId);
    const names = await this.namesOf(access.map(({ deviceId }) => deviceId));

    return access
      .filter(({ deviceId }) => names.has(deviceId))
      .map(({ deviceId, role }) => ({ deviceId, role, name: names.get(deviceId) as string }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async accessOf(userId: string): Promise<{ deviceId: string; role: Role }[]> {
    const access: { deviceId: string; role: Role }[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: this.userIndexName,
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': userId },
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) {
        access.push({ deviceId: deviceIdOf(item.PK as string), role: item.role as Role });
      }
      start = page.LastEvaluatedKey;
    } while (start);

    return access;
  }

  async rename(deviceId: string, userId: string, name: string): Promise<ControllerRecord | null> {
    try {
      const { Attributes: item } = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: controllerKey(deviceId), SK: META },
          UpdateExpression: 'SET #name = :name',
          ConditionExpression: 'ownerId = :userId',
          ExpressionAttributeNames: { '#name': 'name' },
          ExpressionAttributeValues: { ':name': name, ':userId': userId },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return item ? recordOf(deviceId, item) : null;
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        return null;
      }
      throw error;
    }
  }

  private async itemsOf(deviceId: string): Promise<string[]> {
    const keys: string[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': controllerKey(deviceId) },
          ProjectionExpression: 'SK',
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) keys.push(item.SK as string);
      start = page.LastEvaluatedKey;
    } while (start);

    return keys;
  }

  private async namesOf(deviceIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    let keys = deviceIds.map((deviceId) => ({ PK: controllerKey(deviceId), SK: META }));

    while (keys.length > 0) {
      // DynamoDB takes at most 100 keys per request, and may return some unread.
      const batch = keys.slice(0, 100);
      const { Responses: responses, UnprocessedKeys: unprocessed } = await this.client.send(
        new BatchGetCommand({
          RequestItems: {
            [this.tableName]: {
              Keys: batch,
              ProjectionExpression: 'PK, #name',
              ExpressionAttributeNames: { '#name': 'name' },
            },
          },
        }),
      );
      for (const item of responses?.[this.tableName] ?? []) {
        names.set(deviceIdOf(item.PK as string), item.name as string);
      }
      const unread = (unprocessed?.[this.tableName]?.Keys ?? []) as typeof keys;
      keys = [...unread, ...keys.slice(100)];
    }

    return names;
  }
}

function unchangedSince(previous: ControllerRecord | null) {
  if (!previous) return { ConditionExpression: 'attribute_not_exists(PK)' };

  return {
    ConditionExpression: 'ownerId = :previousOwner AND lastClaimHash = :previousHash',
    ExpressionAttributeValues: {
      ':previousOwner': previous.ownerId,
      ':previousHash': previous.lastClaimHash,
    },
  };
}

function recordOf(deviceId: string, item: Record<string, unknown>): ControllerRecord {
  return {
    deviceId,
    name: item.name as string,
    ownerId: item.ownerId as string,
    lastClaimHash: item.lastClaimHash as string,
  };
}

function controllerKey(deviceId: string): string {
  return `CONTROLLER#${deviceId}`;
}

function userKey(userId: string): string {
  return `USER#${userId}`;
}

function deviceIdOf(controllerKeyValue: string): string {
  return controllerKeyValue.slice('CONTROLLER#'.length);
}
