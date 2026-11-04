import { GetRetainedMessageCommand, PublishCommand } from '@aws-sdk/client-iot-data-plane';

import { IotClaimReportSource, parseClaimReport } from '../lambda/controllers/claim-report';

const HASH = 'a'.repeat(64);
const bytes = (value: unknown) =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const named = (name: string) => Object.assign(new Error(name), { name });

describe('parseClaimReport', () => {
  it('reads the payload of the MQTT contract', () => {
    expect(parseClaimReport(bytes({ code_hash: HASH, reset: true }), 123)).toEqual({
      codeHash: HASH,
      reset: true,
      storedAt: 123,
    });
  });

  it('ignores unknown fields, as the contract asks', () => {
    expect(parseClaimReport(bytes({ code_hash: HASH, reset: false, more: 1 }), 123)).toEqual({
      codeHash: HASH,
      reset: false,
      storedAt: 123,
    });
  });

  it.each([
    ['no payload', undefined],
    ['an empty payload', bytes('')],
    ['not JSON', bytes('{')],
    ['not an object', bytes('5')],
    ['null', bytes('null')],
    ['no hash', bytes({ reset: true })],
    ['a short hash', bytes({ code_hash: 'a'.repeat(63), reset: true })],
    ['an upper-case hash', bytes({ code_hash: 'A'.repeat(64), reset: true })],
    ['a hash that is not text', bytes({ code_hash: 5, reset: true })],
    ['no reset flag', bytes({ code_hash: HASH })],
    ['a reset flag that is not true or false', bytes({ code_hash: HASH, reset: 'true' })],
  ])('treats %s as no report', (_name, payload) => {
    expect(parseClaimReport(payload, 123)).toBeNull();
  });

  it('needs to know when the report was stored', () => {
    expect(parseClaimReport(bytes({ code_hash: HASH, reset: true }), undefined)).toBeNull();
  });
});

describe('IotClaimReportSource', () => {
  it("reads the controller's retained claim message", async () => {
    const send = jest.fn().mockResolvedValue({
      payload: bytes({ code_hash: HASH, reset: true }),
      lastModifiedTime: 123,
    });

    await expect(new IotClaimReportSource({ send }).latest('1C8F57371AA4')).resolves.toEqual({
      codeHash: HASH,
      reset: true,
      storedAt: 123,
    });

    const command = send.mock.calls[0][0] as GetRetainedMessageCommand;
    expect(command).toBeInstanceOf(GetRetainedMessageCommand);
    expect(command.input.topic).toBe('esp32-irrigation/1C8F57371AA4/claim');
  });

  it('finds nothing when no report is retained', async () => {
    const send = jest.fn().mockRejectedValue(named('ResourceNotFoundException'));

    await expect(new IotClaimReportSource({ send }).latest('1C8F57371AA4')).resolves.toBeNull();
  });

  it('passes on other failures', async () => {
    const send = jest.fn().mockRejectedValue(named('ThrottlingException'));

    await expect(new IotClaimReportSource({ send }).latest('1C8F57371AA4')).rejects.toThrow(
      'ThrottlingException',
    );
  });

  it('clears the report with an empty retained message', async () => {
    const send = jest.fn().mockResolvedValue({});

    await new IotClaimReportSource({ send }).clear('1C8F57371AA4');

    const command = send.mock.calls[0][0] as PublishCommand;
    expect(command).toBeInstanceOf(PublishCommand);
    expect(command.input).toEqual({
      topic: 'esp32-irrigation/1C8F57371AA4/claim',
      qos: 1,
      retain: true,
    });
  });
});
