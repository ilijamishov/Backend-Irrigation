import { DescribeThingCommand, type IoTClient } from '@aws-sdk/client-iot';

/** Answers whether AWS IoT already knows a controller. */
export interface ThingRegistry {
  exists(deviceId: string): Promise<boolean>;
}

/** Reads the AWS IoT registry. A controller's Thing is named by its device ID. */
export class IotThingRegistry implements ThingRegistry {
  constructor(private readonly client: Pick<IoTClient, 'send'>) {}

  async exists(deviceId: string): Promise<boolean> {
    try {
      await this.client.send(new DescribeThingCommand({ thingName: deviceId }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        return false;
      }
      throw error;
    }
  }
}
