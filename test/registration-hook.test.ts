import { DescribeThingCommand } from '@aws-sdk/client-iot';

import { createRegistrationHookHandler } from '../lambda/controllers/registration-hook';
import { IotThingRegistry, type ThingRegistry } from '../lambda/controllers/thing-registry';

class FakeRegistry implements ThingRegistry {
  readonly asked: string[] = [];

  constructor(private readonly answer: boolean | Error) {}

  async exists(deviceId: string): Promise<boolean> {
    this.asked.push(deviceId);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

const request = (serialNumber: unknown) => ({ parameters: { SerialNumber: serialNumber } });

describe('registration hook', () => {
  beforeEach(() => {
    for (const method of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, method).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('allows a device ID without a Thing', async () => {
    const registry = new FakeRegistry(false);

    const decision = await createRegistrationHookHandler(registry)(request('1C8F57371AA4'));

    expect(decision).toEqual({ allowProvisioning: true });
    expect(registry.asked).toEqual(['1C8F57371AA4']);
  });

  it('refuses a device ID that already has a Thing', async () => {
    const decision = await createRegistrationHookHandler(new FakeRegistry(true))(
      request('1C8F57371AA4'),
    );

    expect(decision).toEqual({ allowProvisioning: false });
  });

  it('refuses when the registry cannot answer', async () => {
    const decision = await createRegistrationHookHandler(new FakeRegistry(new Error('down')))(
      request('1C8F57371AA4'),
    );

    expect(decision).toEqual({ allowProvisioning: false });
  });

  it.each([
    ['missing', undefined],
    ['not text', 42],
    ['empty', ''],
    ['too short', '1C8F57371AA'],
    ['too long', '1C8F57371AA44'],
    ['lower case', '1c8f57371aa4'],
    ['not hexadecimal', '1C8F57371AAG'],
    ['a topic wildcard', '+'],
  ])('refuses a device ID that is %s, without asking the registry', async (_name, serialNumber) => {
    const registry = new FakeRegistry(false);

    const decision = await createRegistrationHookHandler(registry)(request(serialNumber));

    expect(decision).toEqual({ allowProvisioning: false });
    expect(registry.asked).toEqual([]);
  });

  it('refuses a request without parameters', async () => {
    const decision = await createRegistrationHookHandler(new FakeRegistry(false))({});

    expect(decision).toEqual({ allowProvisioning: false });
  });
});

describe('IotThingRegistry', () => {
  const named = (name: string) => Object.assign(new Error(name), { name });

  it('finds an existing Thing by its device ID', async () => {
    const send = jest.fn().mockResolvedValue({ thingName: '1C8F57371AA4' });

    await expect(new IotThingRegistry({ send }).exists('1C8F57371AA4')).resolves.toBe(true);

    const command = send.mock.calls[0][0] as DescribeThingCommand;
    expect(command).toBeInstanceOf(DescribeThingCommand);
    expect(command.input).toEqual({ thingName: '1C8F57371AA4' });
  });

  it('reports a missing Thing', async () => {
    const send = jest.fn().mockRejectedValue(named('ResourceNotFoundException'));

    await expect(new IotThingRegistry({ send }).exists('1C8F57371AA4')).resolves.toBe(false);
  });

  it('passes on any other failure', async () => {
    const send = jest.fn().mockRejectedValue(named('ThrottlingException'));

    await expect(new IotThingRegistry({ send }).exists('1C8F57371AA4')).rejects.toThrow(
      'ThrottlingException',
    );
  });
});
