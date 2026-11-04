import {
  GetRetainedMessageCommand,
  type IoTDataPlaneClient,
  PublishCommand,
} from '@aws-sdk/client-iot-data-plane';

/** What a controller reported after provisioning (MQTT contract §2.2). */
export interface ClaimReport {
  /** SHA-256 of the claim code, 64 lower-case hex characters. */
  readonly codeHash: string;
  /** True for a new or factory-reset controller. */
  readonly reset: boolean;
  /** When the broker stored the report, in milliseconds since 1970. */
  readonly storedAt: number;
}

/** Where the backend finds a controller's latest report. */
export interface ClaimReportSource {
  latest(deviceId: string): Promise<ClaimReport | null>;
  clear(deviceId: string): Promise<void>;
}

const CODE_HASH = /^[0-9a-f]{64}$/;

/** The report is a retained message, so nothing is stored for it here. */
export class IotClaimReportSource implements ClaimReportSource {
  constructor(private readonly client: Pick<IoTDataPlaneClient, 'send'>) {}

  async latest(deviceId: string): Promise<ClaimReport | null> {
    try {
      const message = await this.client.send(
        new GetRetainedMessageCommand({ topic: claimTopic(deviceId) }),
      );
      return parseClaimReport(message.payload, message.lastModifiedTime);
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        return null;
      }
      throw error;
    }
  }

  /** An empty retained message removes the retained message. */
  async clear(deviceId: string): Promise<void> {
    await this.client.send(
      new PublishCommand({ topic: claimTopic(deviceId), qos: 1, retain: true }),
    );
  }
}

function claimTopic(deviceId: string): string {
  return `esp32-irrigation/${deviceId}/claim`;
}

/** Only a well-formed report counts; anything else is the same as none. */
export function parseClaimReport(
  payload: Uint8Array | undefined,
  storedAt: number | undefined,
): ClaimReport | null {
  if (!payload || storedAt === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload).toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { code_hash: codeHash, reset } = parsed as { code_hash?: unknown; reset?: unknown };

  if (typeof codeHash !== 'string' || !CODE_HASH.test(codeHash) || typeof reset !== 'boolean') {
    return null;
  }

  return { codeHash, reset, storedAt };
}
