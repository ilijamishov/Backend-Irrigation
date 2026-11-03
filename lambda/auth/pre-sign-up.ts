import type { PreSignUpTriggerEvent } from 'aws-lambda';

import { type GoogleTokenVerifier, verifierFromEnvironment } from './google-id-token';
import { googleUsername } from './usernames';

/**
 * Lets a user sign up only with a valid Google ID token (in the sign-up's
 * validation data) whose user ID matches the username. Confirms the user,
 * so no email code is sent.
 */
export function createPreSignUpHandler(verifier: GoogleTokenVerifier) {
  return async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
    if (event.triggerSource !== 'PreSignUp_SignUp') {
      throw new Error('Only sign-up with a Google ID token is allowed.');
    }

    const idToken = event.request.validationData?.idToken ?? '';
    const identity = await verifier.verify(idToken);

    if (event.userName !== googleUsername(identity.sub)) {
      throw new Error('The username does not belong to this Google account.');
    }

    const email = event.request.userAttributes.email;
    if (email !== undefined && email !== identity.email) {
      throw new Error('The email does not belong to this Google account.');
    }

    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = email !== undefined;
    return event;
  };
}

// Created on the first call, so importing this module needs no configuration.
let configured: ReturnType<typeof createPreSignUpHandler> | undefined;

export const handler: ReturnType<typeof createPreSignUpHandler> = (event) => {
  configured ??= createPreSignUpHandler(verifierFromEnvironment());
  return configured(event);
};
