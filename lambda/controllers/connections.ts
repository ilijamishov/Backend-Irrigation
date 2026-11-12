import { DeleteConnectionCommand, type IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';
import { type DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/** What the table's time-to-live reads, in seconds since 1970. */
export const EXPIRY_ATTRIBUTE = 'expiresAtSeconds';

const CONNECTIONS_PREFIX = 'CONNECTIONS#';
const CLIENT_PREFIX = 'CLIENT#';

/**
 * The AWS IoT client IDs a user has connected with. AWS IoT can only close a
 * connection by its client ID, and can't list a user's connections.
 */
export interface ConnectionRegistry {
  /** Kept until [until], in seconds since 1970, when the connection ends anyway. */
  record(userId: string, clientId: string, until: number): Promise<void>;
  clientIdsOf(userId: string): Promise<string[]>;
}

/**
 * In the access table, but not under a controller and without a `userId`
 * attribute, so the index of the user's controllers never sees them.
 */
export class DynamoConnectionRegistry implements ConnectionRegistry {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly tableName: string,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  async record(userId: string, clientId: string, until: number): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `${CONNECTIONS_PREFIX}${userId}`,
          SK: `${CLIENT_PREFIX}${clientId}`,
          clientId,
          [EXPIRY_ATTRIBUTE]: Math.ceil(until),
        },
      }),
    );
  }

  async clientIdsOf(userId: string): Promise<string[]> {
    const clientIds: string[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `${CONNECTIONS_PREFIX}${userId}` },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) {
        // DynamoDB removes expired items only within a few days.
        if ((item[EXPIRY_ATTRIBUTE] as number) > this.now()) {
          clientIds.push(item.clientId as string);
        }
      }
      start = page.LastEvaluatedKey;
    } while (start);

    return clientIds;
  }
}

export interface ConnectionCloser {
  /** Does nothing for a client that isn't connected. */
  close(clientId: string): Promise<void>;
}

export class IotConnectionCloser implements ConnectionCloser {
  constructor(private readonly client: Pick<IoTDataPlaneClient, 'send'>) {}

  async close(clientId: string): Promise<void> {
    try {
      await this.client.send(new DeleteConnectionCommand({ clientId }));
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') return;
      throw error;
    }
  }
}

/**
 * Ends a user's open AWS IoT connections after their access changed, so a
 * removed Manager can't keep sending until the next policy refresh
 * (docs/user-roles.md §9.5). The app connects again at once, with a policy
 * that has the new access.
 */
export class AccessRevoker {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly closer: ConnectionCloser,
  ) {}

  /**
   * Never throws: the access has already changed, and the next policy refresh
   * applies it anyway.
   */
  async revoke(userId: string): Promise<void> {
    try {
      const clientIds = await this.registry.clientIdsOf(userId);
      const results = await Promise.allSettled(
        clientIds.map((clientId) => this.closer.close(clientId)),
      );
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length > 0) {
        console.error(`Could not close ${failed.length} of ${clientIds.length} connections.`);
      }
    } catch (error) {
      // Only the type: a message could contain request data.
      const reason = error instanceof Error ? error.name : 'unknown';
      console.error(`Could not read the connections (${reason}).`);
    }
  }
}
