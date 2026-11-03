import type {
  CreateAuthChallengeTriggerEvent,
  DefineAuthChallengeTriggerEvent,
  PreSignUpTriggerEvent,
  VerifyAuthChallengeResponseTriggerEvent,
} from 'aws-lambda';

import { handler as createAuthChallenge } from '../lambda/auth/create-auth-challenge';
import { handler as defineAuthChallenge } from '../lambda/auth/define-auth-challenge';
import { createPreSignUpHandler } from '../lambda/auth/pre-sign-up';
import { googleUsername } from '../lambda/auth/usernames';
import { createVerifyAuthChallengeHandler } from '../lambda/auth/verify-auth-challenge';
import { FakeGoogle, GOOGLE_SUB } from './support/google-tokens';

const USERNAME = googleUsername(GOOGLE_SUB);

function base(userName = USERNAME) {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_test',
    userName,
    callerContext: { awsSdkVersion: 'test', clientId: 'app-client' },
  };
}

let google: FakeGoogle;

beforeAll(async () => {
  google = await FakeGoogle.create();
});

describe('Pre sign-up', () => {
  const event = (
    validationData: Record<string, string> | undefined,
    overrides: { userName?: string; email?: string; triggerSource?: string } = {},
  ) =>
    ({
      ...base(overrides.userName),
      triggerSource: overrides.triggerSource ?? 'PreSignUp_SignUp',
      request: {
        userAttributes: overrides.email ? { email: overrides.email } : {},
        validationData,
      },
      response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
    }) as unknown as PreSignUpTriggerEvent;

  it('confirms a user whose username matches the Google account', async () => {
    const preSignUp = createPreSignUpHandler(google.verifier());

    const result = await preSignUp(
      event({ idToken: await google.idToken() }, { email: 'gardener@example.com' }),
    );

    expect(result.response.autoConfirmUser).toBe(true);
    expect(result.response.autoVerifyEmail).toBe(true);
  });

  it('refuses a sign-up without a Google ID token', async () => {
    const preSignUp = createPreSignUpHandler(google.verifier());

    await expect(preSignUp(event(undefined))).rejects.toThrow();
  });

  it("refuses a username that isn't this Google account's", async () => {
    const preSignUp = createPreSignUpHandler(google.verifier());
    const token = await google.idToken();

    await expect(
      preSignUp(event({ idToken: token }, { userName: googleUsername('someone-else') })),
    ).rejects.toThrow(/username/);
  });

  it("refuses an email that isn't this Google account's", async () => {
    const preSignUp = createPreSignUpHandler(google.verifier());
    const token = await google.idToken();

    await expect(
      preSignUp(event({ idToken: token }, { email: 'attacker@example.com' })),
    ).rejects.toThrow(/email/);
  });

  it('refuses users created by an administrator', async () => {
    const preSignUp = createPreSignUpHandler(google.verifier());
    const token = await google.idToken();

    await expect(
      preSignUp(event({ idToken: token }, { triggerSource: 'PreSignUp_AdminCreateUser' })),
    ).rejects.toThrow();
  });
});

describe('Define auth challenge', () => {
  type Session = DefineAuthChallengeTriggerEvent['request']['session'];

  const define = (session: Session, userNotFound = false) =>
    defineAuthChallenge({
      ...base(),
      triggerSource: 'DefineAuthChallenge_Authentication',
      request: { userAttributes: {}, session, userNotFound },
      response: { challengeName: '', issueTokens: false, failAuthentication: false },
    } as DefineAuthChallengeTriggerEvent);

  const answer = (challengeResult: boolean) => ({
    challengeName: 'CUSTOM_CHALLENGE' as const,
    challengeResult,
    challengeMetadata: 'GOOGLE_ID_TOKEN',
  });

  it('asks for the Google ID token first', async () => {
    const result = await define([]);

    expect(result.response.challengeName).toBe('CUSTOM_CHALLENGE');
    expect(result.response.issueTokens).toBe(false);
    expect(result.response.failAuthentication).toBe(false);
  });

  it('issues tokens after a correct answer', async () => {
    const result = await define([answer(true)]);

    expect(result.response.issueTokens).toBe(true);
  });

  it('fails after a wrong answer, without a second try', async () => {
    const result = await define([answer(false)]);

    expect(result.response.failAuthentication).toBe(true);
    expect(result.response.issueTokens).toBe(false);
  });

  it('fails for a user that does not exist', async () => {
    const result = await define([], true);

    expect(result.response.failAuthentication).toBe(true);
  });

  it('fails for any other sequence', async () => {
    const result = await define([answer(false), answer(true)]);

    expect(result.response.failAuthentication).toBe(true);
    expect(result.response.issueTokens).toBe(false);
  });
});

describe('Create auth challenge', () => {
  it('asks for a Google ID token and keeps no secret', async () => {
    const result = await createAuthChallenge({
      ...base(),
      triggerSource: 'CreateAuthChallenge_Authentication',
      request: { userAttributes: {}, challengeName: 'CUSTOM_CHALLENGE', session: [] },
      response: {
        publicChallengeParameters: {},
        privateChallengeParameters: {},
        challengeMetadata: '',
      },
    } as unknown as CreateAuthChallengeTriggerEvent);

    expect(result.response.publicChallengeParameters).toEqual({ provider: 'google' });
    expect(result.response.privateChallengeParameters).toEqual({});
  });
});

describe('Verify auth challenge', () => {
  const verify = async (challengeAnswer: string, userName = USERNAME) => {
    const handler = createVerifyAuthChallengeHandler(google.verifier());
    const result = await handler({
      ...base(userName),
      triggerSource: 'VerifyAuthChallengeResponse_Authentication',
      request: { userAttributes: {}, privateChallengeParameters: {}, challengeAnswer },
      response: { answerCorrect: false },
    } as unknown as VerifyAuthChallengeResponseTriggerEvent);
    return result.response.answerCorrect;
  };

  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it("accepts a valid token of this user's Google account", async () => {
    expect(await verify(await google.idToken())).toBe(true);
  });

  it("refuses a valid token of another user's Google account", async () => {
    expect(await verify(await google.idToken(), googleUsername('someone-else'))).toBe(false);
  });

  it('refuses an invalid token', async () => {
    expect(await verify(await google.idToken({ audience: 'other-app' }))).toBe(false);
    expect(await verify('garbage')).toBe(false);
  });
});
