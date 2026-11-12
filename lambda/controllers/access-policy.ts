import type { Role } from './access-store';

/** One controller the user may reach. */
export interface ControllerAccess {
  readonly deviceId: string;
  readonly role: Role;
}

/** The AWS IoT limits on what an authorizer may return. */
export const MAX_POLICY_DOCUMENTS = 10;
export const MAX_POLICY_DOCUMENT_LENGTH = 2048;

interface Statement {
  readonly Effect: 'Allow';
  readonly Action: string | string[];
  readonly Resource: string | string[];
}

export interface PolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: Statement[];
}

/**
 * What a user may do in AWS IoT, from their roles. Each controller's topics
 * are listed, so anything else is refused:
 * - both roles receive everything of the controller, and may send `command`
 *   and `schedule`;
 * - only the Owner may send `config`, the controller configuration;
 * - nobody may retain a message, because a retained request would run again
 *   every time the controller reconnects (MQTT contract §2).
 */
export class AccessPolicyBuilder {
  /** @param arnPrefix `arn:aws:iot:<region>:<account>:` */
  constructor(private readonly arnPrefix: string) {}

  /**
   * Fills the documents one controller at a time, because each is limited in
   * size. A controller that doesn't fit is left out rather than the whole
   * answer failing: the limit is far above what one user has.
   */
  build(
    userId: string,
    controllers: readonly ControllerAccess[],
    clientId: string | null = null,
  ): PolicyDocument[] {
    const documents: PolicyDocument[] = [
      this.document([
        {
          Effect: 'Allow',
          Action: 'iot:Connect',
          // The app adds an ID per installation, so phones don't push each
          // other off. AWS IoT allows one connection per client ID. When the
          // app names its client ID, only that one may connect, because it is
          // the one the backend can close.
          Resource: `${this.arnPrefix}client/${clientId ?? `${userId}-*`}`,
        },
      ]),
    ];

    for (const controller of controllers) {
      const statements = this.statementsFor(controller);
      const current = documents[documents.length - 1];
      const merged = this.document([...current.Statement, ...statements]);

      if (JSON.stringify(merged).length <= MAX_POLICY_DOCUMENT_LENGTH) {
        documents[documents.length - 1] = merged;
      } else if (documents.length < MAX_POLICY_DOCUMENTS) {
        documents.push(this.document(statements));
      } else {
        console.warn(`Policy limit reached: ${controller.deviceId} left out.`);
      }
    }

    return documents;
  }

  private statementsFor({ deviceId, role }: ControllerAccess): Statement[] {
    const topics = `esp32-irrigation/${deviceId}`;
    const sendable = role === 'owner' ? ['command', 'schedule', 'config'] : ['command', 'schedule'];

    return [
      {
        Effect: 'Allow',
        Action: 'iot:Subscribe',
        Resource: `${this.arnPrefix}topicfilter/${topics}/*`,
      },
      {
        Effect: 'Allow',
        Action: 'iot:Receive',
        Resource: `${this.arnPrefix}topic/${topics}/*`,
      },
      {
        Effect: 'Allow',
        Action: 'iot:Publish',
        Resource: sendable.map((name) => `${this.arnPrefix}topic/${topics}/${name}`),
      },
    ];
  }

  private document(statements: Statement[]): PolicyDocument {
    return { Version: '2012-10-17', Statement: statements };
  }
}
