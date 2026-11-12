import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

import type { Role } from './access-store';
import { EXPIRY_ATTRIBUTE } from './connections';

/** An invitation to become a Manager. Only the hash of its code is stored. */
export interface Invitation {
  readonly invitationId: string;
  readonly deviceId: string;
  readonly codeHash: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601. It can't be accepted after this. */
  readonly expiresAt: string;
}

/** Someone with a role on a controller. */
export interface Member {
  readonly userId: string;
  readonly role: Role;
  /** Kept for Managers when they accept, so the Owner can tell them apart. */
  readonly email?: string;
}

/** Invitations, and the people on a controller. */
export interface SharingStore {
  membersOf(deviceId: string): Promise<Member[]>;
  /** Expired ones too, until the table removes them. */
  invitationsOf(deviceId: string): Promise<Invitation[]>;
  invitationByCode(codeHash: string): Promise<Invitation | null>;
  /** False unless the user is the Owner. */
  addInvitation(ownerId: string, invitation: Invitation): Promise<boolean>;
  /** False unless the user is the Owner and the invitation is still there. */
  removeInvitation(ownerId: string, invitation: Invitation): Promise<boolean>;
  /**
   * Makes the user a Manager and uses up the invitation, in one step. False if
   * the invitation is gone or the user already has a role on the controller.
   */
  acceptInvitation(invitation: Invitation, manager: Member): Promise<boolean>;
  /** False unless [ownerId] is the Owner and [managerId] a Manager. */
  removeManager(deviceId: string, ownerId: string, managerId: string): Promise<boolean>;
  /** False unless the user is a Manager of the controller. */
  leave(deviceId: string, userId: string): Promise<boolean>;
}

const META = 'META';
const USER_PREFIX = 'USER#';
const INVITE_PREFIX = 'INVITE#';
const LOOKUP_PREFIX = 'INVITATION#';

/**
 * Each invitation is two items: one under its controller, so a factory-reset
 * claim removes it with everything else, and one under the hash of its code, so
 * the invitee can find it without knowing the controller. Accepting checks that
 * both are still there. Neither has a `userId` attribute, so the index of the
 * user's controllers never sees them.
 */
export class DynamoSharingStore implements SharingStore {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly tableName: string,
  ) {}

  async membersOf(deviceId: string): Promise<Member[]> {
    return (await this.queryController(deviceId, USER_PREFIX)).map((item) => ({
      userId: item.userId as string,
      role: item.role as Role,
      ...(item.email ? { email: item.email as string } : {}),
    }));
  }

  async invitationsOf(deviceId: string): Promise<Invitation[]> {
    return (await this.queryController(deviceId, INVITE_PREFIX)).map((item) =>
      invitationOf(deviceId, item),
    );
  }

  async invitationByCode(codeHash: string): Promise<Invitation | null> {
    const { Item: item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: lookupKey(codeHash), SK: META },
        ConsistentRead: true,
      }),
    );
    return item ? invitationOf(item.deviceId as string, item) : null;
  }

  addInvitation(ownerId: string, invitation: Invitation): Promise<boolean> {
    const fields = {
      invitationId: invitation.invitationId,
      codeHash: invitation.codeHash,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      [EXPIRY_ATTRIBUTE]: Math.ceil(Date.parse(invitation.expiresAt) / 1000),
    };

    return this.transact([
      this.ownerCheck(invitation.deviceId, ownerId),
      {
        Put: {
          TableName: this.tableName,
          Item: {
            PK: controllerKey(invitation.deviceId),
            SK: inviteKey(invitation.invitationId),
            ...fields,
          },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            PK: lookupKey(invitation.codeHash),
            SK: META,
            deviceId: invitation.deviceId,
            ...fields,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ]);
  }

  removeInvitation(ownerId: string, invitation: Invitation): Promise<boolean> {
    return this.transact([
      this.ownerCheck(invitation.deviceId, ownerId),
      ...this.invitationDeletes(invitation),
    ]);
  }

  acceptInvitation(invitation: Invitation, manager: Member): Promise<boolean> {
    return this.transact([
      {
        Put: {
          TableName: this.tableName,
          Item: {
            PK: controllerKey(invitation.deviceId),
            SK: userKey(manager.userId),
            userId: manager.userId,
            role: 'manager' satisfies Role,
            ...(manager.email ? { email: manager.email } : {}),
          },
          // The Owner, or a Manager already, keeps the role they have.
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      ...this.invitationDeletes(invitation),
    ]);
  }

  removeManager(deviceId: string, ownerId: string, managerId: string): Promise<boolean> {
    return this.transact([this.ownerCheck(deviceId, ownerId), this.managerDelete(deviceId, managerId)]);
  }

  leave(deviceId: string, userId: string): Promise<boolean> {
    return this.transact([this.managerDelete(deviceId, userId)]);
  }

  /** Both items, each only if it is still there. */
  private invitationDeletes(invitation: Invitation): Record<string, unknown>[] {
    return [
      {
        Delete: {
          TableName: this.tableName,
          Key: { PK: controllerKey(invitation.deviceId), SK: inviteKey(invitation.invitationId) },
          ConditionExpression: 'attribute_exists(PK)',
        },
      },
      {
        Delete: {
          TableName: this.tableName,
          Key: { PK: lookupKey(invitation.codeHash), SK: META },
          ConditionExpression: 'attribute_exists(PK)',
        },
      },
    ];
  }

  private managerDelete(deviceId: string, userId: string): Record<string, unknown> {
    return {
      Delete: {
        TableName: this.tableName,
        Key: { PK: controllerKey(deviceId), SK: userKey(userId) },
        ConditionExpression: '#role = :manager',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':manager': 'manager' satisfies Role },
      },
    };
  }

  private ownerCheck(deviceId: string, ownerId: string): Record<string, unknown> {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { PK: controllerKey(deviceId), SK: META },
        ConditionExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: { ':ownerId': ownerId },
      },
    };
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

  private async queryController(
    deviceId: string,
    prefix: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;

    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': controllerKey(deviceId), ':prefix': prefix },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);

    return items;
  }
}

function invitationOf(deviceId: string, item: Record<string, unknown>): Invitation {
  return {
    invitationId: item.invitationId as string,
    deviceId,
    codeHash: item.codeHash as string,
    createdAt: item.createdAt as string,
    expiresAt: item.expiresAt as string,
  };
}

function controllerKey(deviceId: string): string {
  return `CONTROLLER#${deviceId}`;
}

function userKey(userId: string): string {
  return `${USER_PREFIX}${userId}`;
}

function inviteKey(invitationId: string): string {
  return `${INVITE_PREFIX}${invitationId}`;
}

function lookupKey(codeHash: string): string {
  return `${LOOKUP_PREFIX}${codeHash}`;
}
