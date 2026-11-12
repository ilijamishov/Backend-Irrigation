import { AddThingToThingGroupCommand, type IoTClient, paginateListThings } from '@aws-sdk/client-iot';

/** 12 upper-case hex characters, from the MQTT contract. */
const DEVICE_ID = /^[0-9A-F]{12}$/;

/** The Things of the account, and their groups. */
export interface ThingDirectory {
  thingNames(): AsyncIterable<string>;
  /** Adding a Thing that is already in the group changes nothing. */
  addToGroup(thingName: string, groupName: string): Promise<void>;
}

/**
 * Puts every controller that registered before the group existed into it.
 * New controllers join it as they register, so this is needed once; running
 * it again changes nothing.
 */
export class ControllerGroupEnrolment {
  constructor(
    private readonly directory: ThingDirectory,
    private readonly groupName: string,
  ) {}

  /** The controllers now in the group. Other Things are left alone. */
  async enrolAll(): Promise<string[]> {
    const enrolled: string[] = [];
    for await (const thingName of this.directory.thingNames()) {
      if (!DEVICE_ID.test(thingName)) continue;
      await this.directory.addToGroup(thingName, this.groupName);
      enrolled.push(thingName);
    }
    return enrolled;
  }
}

export class IotThingDirectory implements ThingDirectory {
  constructor(private readonly client: IoTClient) {}

  async *thingNames(): AsyncIterable<string> {
    for await (const page of paginateListThings({ client: this.client }, {})) {
      for (const thing of page.things ?? []) {
        if (thing.thingName) yield thing.thingName;
      }
    }
  }

  async addToGroup(thingName: string, groupName: string): Promise<void> {
    await this.client.send(new AddThingToThingGroupCommand({ thingName, thingGroupName: groupName }));
  }
}
