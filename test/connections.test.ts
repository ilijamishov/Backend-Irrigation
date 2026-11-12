import { DeleteConnectionCommand } from '@aws-sdk/client-iot-data-plane';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import {
  AccessRevoker,
  DynamoConnectionRegistry,
  IotConnectionCloser,
} from '../lambda/controllers/connections';

const TABLE = 'irrigation-access';
const USER = '0458f4a8-1234-5678-9abc-def012345678';
const NOW = 1_800_000_000;

const named = (name: string) => Object.assign(new Error(name), { name });

function fakeClient(answer: (command: unknown) => unknown = () => ({})) {
  const sent: { input: Record<string, unknown> }[] = [];
  const send = jest.fn(async (command: { input: Record<string, unknown> }) => {
    sent.push(command);
    const result = answer(command);
    if (result instanceof Error) throw result;
    return result;
  });
  return { send: send as never, sent };
}

describe('DynamoConnectionRegistry', () => {
  it('records a client ID until its connection ends, outside any controller', async () => {
    const client = fakeClient();

    await new DynamoConnectionRegistry(client, TABLE).record(USER, `${USER}-abc`, NOW + 3600.5);

    expect(client.sent[0]).toBeInstanceOf(PutCommand);
    expect(client.sent[0].input.Item).toEqual({
      PK: `CONNECTIONS#${USER}`,
      SK: `CLIENT#${USER}-abc`,
      clientId: `${USER}-abc`,
      expiresAtSeconds: NOW + 3601,
    });
  });

  it('lists only the connections that may still be open', async () => {
    const client = fakeClient((command) =>
      command instanceof QueryCommand
        ? {
            Items: [
              { clientId: 'open', expiresAtSeconds: NOW + 10 },
              { clientId: 'ended', expiresAtSeconds: NOW - 10 },
            ],
          }
        : {},
    );

    const clientIds = await new DynamoConnectionRegistry(client, TABLE, () => NOW).clientIdsOf(
      USER,
    );

    expect(clientIds).toEqual(['open']);
  });
});

describe('IotConnectionCloser', () => {
  it('closes the connection of a client ID', async () => {
    const client = fakeClient();

    await new IotConnectionCloser(client).close('abc');

    expect(client.sent[0]).toBeInstanceOf(DeleteConnectionCommand);
    expect(client.sent[0].input).toEqual({ clientId: 'abc' });
  });

  it('does nothing for a client that is not connected', async () => {
    const client = fakeClient(() => named('ResourceNotFoundException'));

    await expect(new IotConnectionCloser(client).close('abc')).resolves.toBeUndefined();
  });

  it('passes on any other failure', async () => {
    const client = fakeClient(() => named('ThrottlingException'));

    await expect(new IotConnectionCloser(client).close('abc')).rejects.toThrow();
  });
});

describe('AccessRevoker', () => {
  afterEach(() => jest.restoreAllMocks());

  it('closes every recorded connection of the user', async () => {
    const closed: string[] = [];
    const revoker = new AccessRevoker(
      { record: async () => undefined, clientIdsOf: async () => ['phone', 'tablet'] },
      { close: async (clientId) => void closed.push(clientId) },
    );

    await revoker.revoke(USER);

    expect(closed).toEqual(['phone', 'tablet']);
  });

  it('never throws, and logs only counts and types', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const revoker = new AccessRevoker(
      { record: async () => undefined, clientIdsOf: async () => ['phone', 'tablet'] },
      {
        close: async (clientId) => {
          if (clientId === 'phone') throw new Error(`private ${clientId}`);
        },
      },
    );

    await expect(revoker.revoke(USER)).resolves.toBeUndefined();
    expect(error.mock.calls.join(' ')).toContain('1 of 2');
    expect(error.mock.calls.join(' ')).not.toContain('private');
  });

  it('never throws when the connections can\'t be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const revoker = new AccessRevoker(
      { record: async () => undefined, clientIdsOf: async () => Promise.reject(named('Boom')) },
      { close: async () => undefined },
    );

    await expect(revoker.revoke(USER)).resolves.toBeUndefined();
  });
});
