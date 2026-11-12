import { ControllerGroupEnrolment, type ThingDirectory } from '../scripts/controller-group';

class FakeThingDirectory implements ThingDirectory {
  readonly added: [string, string][] = [];

  constructor(private readonly names: string[]) {}

  async *thingNames(): AsyncIterable<string> {
    yield* this.names;
  }

  async addToGroup(thingName: string, groupName: string): Promise<void> {
    this.added.push([thingName, groupName]);
  }
}

describe('ControllerGroupEnrolment', () => {
  it('adds every controller to the group', async () => {
    const directory = new FakeThingDirectory(['1C8F57371AA4', 'A1B2C3D4E5F6']);

    const enrolled = await new ControllerGroupEnrolment(directory, 'group').enrolAll();

    expect(enrolled).toEqual(['1C8F57371AA4', 'A1B2C3D4E5F6']);
    expect(directory.added).toEqual([
      ['1C8F57371AA4', 'group'],
      ['A1B2C3D4E5F6', 'group'],
    ]);
  });

  it('leaves alone Things that aren’t controllers', async () => {
    const directory = new FakeThingDirectory(['my-test-thing', '1c8f57371aa4', '1C8F57371AA4']);

    const enrolled = await new ControllerGroupEnrolment(directory, 'group').enrolAll();

    expect(enrolled).toEqual(['1C8F57371AA4']);
  });

  it('stops at the first failure, so nothing is reported as added that wasn’t', async () => {
    const directory = new FakeThingDirectory(['1C8F57371AA4']);
    directory.addToGroup = async () => {
      throw new Error('ResourceNotFoundException');
    };

    await expect(new ControllerGroupEnrolment(directory, 'group').enrolAll()).rejects.toThrow(
      'ResourceNotFoundException',
    );
  });
});
