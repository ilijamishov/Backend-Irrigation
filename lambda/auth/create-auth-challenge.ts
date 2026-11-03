import type { CreateAuthChallengeTriggerEvent } from 'aws-lambda';

/** Tells the app to answer with a Google ID token. Nothing secret is kept. */
export async function handler(
  event: CreateAuthChallengeTriggerEvent,
): Promise<CreateAuthChallengeTriggerEvent> {
  event.response.publicChallengeParameters = { provider: 'google' };
  event.response.privateChallengeParameters = {};
  event.response.challengeMetadata = 'GOOGLE_ID_TOKEN';
  return event;
}
