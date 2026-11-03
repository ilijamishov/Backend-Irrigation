import type { DefineAuthChallengeTriggerEvent } from 'aws-lambda';

/**
 * Sign-in is one custom challenge: the Google ID token. Tokens are issued only
 * after it was answered correctly; any other sequence fails.
 */
export async function handler(
  event: DefineAuthChallengeTriggerEvent,
): Promise<DefineAuthChallengeTriggerEvent> {
  const session = event.request.session;
  const last = session[session.length - 1];

  event.response.issueTokens = false;
  event.response.failAuthentication = false;

  if (event.request.userNotFound) {
    event.response.failAuthentication = true;
  } else if (session.length === 0) {
    event.response.challengeName = 'CUSTOM_CHALLENGE';
  } else if (
    session.length === 1 &&
    last.challengeName === 'CUSTOM_CHALLENGE' &&
    last.challengeResult
  ) {
    event.response.issueTokens = true;
  } else {
    event.response.failAuthentication = true;
  }

  return event;
}
