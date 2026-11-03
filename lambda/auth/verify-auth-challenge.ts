import type { VerifyAuthChallengeResponseTriggerEvent } from 'aws-lambda';

import {
  type GoogleTokenVerifier,
  InvalidGoogleTokenError,
  verifierFromEnvironment,
} from './google-id-token';
import { googleUsername } from './usernames';

/**
 * The answer is correct when it is a valid Google ID token for the Google
 * account this user signed up with.
 */
export function createVerifyAuthChallengeHandler(verifier: GoogleTokenVerifier) {
  return async (
    event: VerifyAuthChallengeResponseTriggerEvent,
  ): Promise<VerifyAuthChallengeResponseTriggerEvent> => {
    let answerCorrect = false;

    try {
      const identity = await verifier.verify(event.request.challengeAnswer ?? '');
      answerCorrect = event.userName === googleUsername(identity.sub);
    } catch (error) {
      if (!(error instanceof InvalidGoogleTokenError)) throw error;
      console.warn(error.message);
    }

    event.response.answerCorrect = answerCorrect;
    return event;
  };
}

// Created on the first call, so importing this module needs no configuration.
let configured: ReturnType<typeof createVerifyAuthChallengeHandler> | undefined;

export const handler: ReturnType<typeof createVerifyAuthChallengeHandler> = (event) => {
  configured ??= createVerifyAuthChallengeHandler(verifierFromEnvironment());
  return configured(event);
};
