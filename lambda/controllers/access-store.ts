import {
  BatchGetCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export type Role = 'owner' | 'manager';

/**
 * Where a controller is, for its Owner only: it shows where the Owner lives. The
 * position is rounded before it is stored (see roundedPosition in api.ts).
 */
export interface ControllerLocation {
  readonly latitude: number;
  readonly longitude: number;
  /** The IANA name, for example `Europe/Skopje`. */
  readonly timeZone: string;
  /** What the controller runs on, for example `CET-1CEST,M3.5.0,M10.5.0/3`. */
  readonly posixTimeZone: string;
}

/** Who owns a controller, and the claim code that made them its Owner. */
export interface ControllerRecord {
  readonly deviceId: string;
  readonly name: string;
  readonly ownerId: string;
  readonly lastClaimHash: string;
  /** Unset until the Owner gives it. A new claim starts without one. */
  readonly location?: ControllerLocation;
  /** Changes with every change of its zones. Unset before the first one. */
  readonly zonesVersion?: number;
}

/**
 * A named area of the yard, connected to one relay of the controller. Which
 * relay is the Owner's choice: nothing says they are wired in order, or that
 * all of them are used.
 */
export interface ControllerZone {
  readonly zoneId: string;
  readonly name: string;
  readonly description?: string;
  /** 1-8, the number the MQTT contract calls `zone`. */
  readonly relay: number;
  readonly enabled: boolean;
  readonly createdAt: string;
}


/** A controller as one user sees it. */
export interface UserController {
  readonly deviceId: string;
  readonly name: string;
  readonly role: Role;
  /** Only for the Owner. */
  readonly location?: ControllerLocation;
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

/** The zones changed between reading them and saving this change. */
export class ZoneConflictError extends Error {
  constructor() {
    super('The zones changed during the update.');
    this.name = 'ZoneConflictError';
  }
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
  /** Returns null unless the user is the Owner. */
  setLocation(
    deviceId: string,
    userId: string,
    location: ControllerLocation,
  ): Promise<ControllerRecord | null>;
  /** The user's role on this controller, or null without access. */
  roleOf(deviceId: string, userId: string): Promise<Role | null>;
  /** In the order they were added. */
  zonesOf(deviceId: string): Promise<ControllerZone[]>;
  /**
   * Adds or replaces a zone, if the user is the Owner and the zones are still at
   * [zonesVersion]. Otherwise throws [ZoneConflictError].
   */
  saveZone(
    deviceId: string,
    userId: string,
    zone: ControllerZone,
    zonesVersion: number,
  ): Promise<void>;
  /** As for [saveZone]. */
  deleteZone(
    deviceId: string,
    userId: string,
    zoneId: string,
    zonesVersion: number,
  ): Promise<void>;
}

const META = 'META';
const ZONE_PREFIX = 'ZONE#';

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
    const details = await this.detailsOf(access.map(({ deviceId }) => deviceId));

    return access
      .flatMap(({ deviceId, role }): UserController[] => {
        const found = details.get(deviceId);
        if (!found) return [];

        const location = role === 'owner' ? found.location : undefined;
        return [{ deviceId, role, name: found.name, ...(location ? { location } : {}) }];
      })
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

  rename(deviceId: string, userId: string, name: string): Promise<ControllerRecord | null> {
    return this.setForOwner(deviceId, userId, 'name', name);
  }

  setLocation(
    deviceId: string,
    userId: string,
    location: ControllerLocation,
  ): Promise<ControllerRecord | null> {
    return this.setForOwner(deviceId, userId, 'location', location);
  }

  async roleOf(deviceId: string, userId: string): Promise<Role | null> {
    const { Item: item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: controllerKey(deviceId), SK: userKey(userId) },
        ConsistentRead: true,
      }),
    );
    return item ? (item.role as Role) : null;
  }

  async zonesOf(deviceId: string): Promise<ControllerZone[]> {
    const zones: ControllerZone[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :zones)',
          ExpressionAttributeValues: { ':pk': controllerKey(deviceId), ':zones': ZONE_PREFIX },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) zones.push(zoneOf(item));
      start = page.LastEvaluatedKey;
    } while (start);

    return zones.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.zoneId.localeCompare(b.zoneId),
    );
  }

  saveZone(
    deviceId: string,
    userId: string,
    zone: ControllerZone,
    zonesVersion: number,
  ): Promise<void> {
    return this.writeZone(deviceId, userId, zonesVersion, {
      Put: {
        TableName: this.tableName,
        Item: { PK: controllerKey(deviceId), SK: zoneKey(zone.zoneId), ...zone },
      },
    });
  }

  deleteZone(
    deviceId: string,
    userId: string,
    zoneId: string,
    zonesVersion: number,
  ): Promise<void> {
    return this.writeZone(deviceId, userId, zonesVersion, {
      Delete: {
        TableName: this.tableName,
        Key: { PK: controllerKey(deviceId), SK: zoneKey(zoneId) },
      },
    });
  }

  /**
   * In one transaction with the version on the controller, so two changes can't
   * both pass the check that a relay is free, and a change can't outlive a claim.
   */
  private async writeZone(
    deviceId: string,
    userId: string,
    zonesVersion: number,
    write: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: controllerKey(deviceId), SK: META },
                UpdateExpression: 'SET zonesVersion = :next',
                ConditionExpression:
                  'ownerId = :userId AND ' +
                  (zonesVersion === 0
                    ? 'attribute_not_exists(zonesVersion)'
                    : 'zonesVersion = :current'),
                ExpressionAttributeValues: {
                  ':next': zonesVersion + 1,
                  ':userId': userId,
                  ...(zonesVersion === 0 ? {} : { ':current': zonesVersion }),
                },
              },
            },
            write,
          ],
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        throw new ZoneConflictError();
      }
      throw error;
    }
  }

  private async setForOwner(
    deviceId: string,
    userId: string,
    attribute: string,
    value: unknown,
  ): Promise<ControllerRecord | null> {
    try {
      const { Attributes: item } = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: controllerKey(deviceId), SK: META },
          UpdateExpression: 'SET #attribute = :value',
          ConditionExpression: 'ownerId = :userId',
          ExpressionAttributeNames: { '#attribute': attribute },
          ExpressionAttributeValues: { ':value': value, ':userId': userId },
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

  private async detailsOf(
    deviceIds: string[],
  ): Promise<Map<string, { name: string; location?: ControllerLocation }>> {
    const details = new Map<string, { name: string; location?: ControllerLocation }>();
    let keys = deviceIds.map((deviceId) => ({ PK: controllerKey(deviceId), SK: META }));

    while (keys.length > 0) {
      // DynamoDB takes at most 100 keys per request, and may return some unread.
      const batch = keys.slice(0, 100);
      const { Responses: responses, UnprocessedKeys: unprocessed } = await this.client.send(
        new BatchGetCommand({
          RequestItems: {
            [this.tableName]: {
              Keys: batch,
              ProjectionExpression: 'PK, #name, #location',
              ExpressionAttributeNames: { '#name': 'name', '#location': 'location' },
            },
          },
        }),
      );
      for (const item of responses?.[this.tableName] ?? []) {
        details.set(deviceIdOf(item.PK as string), {
          name: item.name as string,
          location: item.location as ControllerLocation | undefined,
        });
      }
      const unread = (unprocessed?.[this.tableName]?.Keys ?? []) as typeof keys;
      keys = [...unread, ...keys.slice(100)];
    }

    return details;
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
    ...(item.location ? { location: item.location as ControllerLocation } : {}),
    ...(item.zonesVersion === undefined ? {} : { zonesVersion: item.zonesVersion as number }),
  };
}

function zoneOf(item: Record<string, unknown>): ControllerZone {
  return {
    zoneId: item.zoneId as string,
    name: item.name as string,
    ...(item.description ? { description: item.description as string } : {}),
    relay: item.relay as number,
    enabled: item.enabled as boolean,
    createdAt: item.createdAt as string,
  };
}

function zoneKey(zoneId: string): string {
  return `${ZONE_PREFIX}${zoneId}`;
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
