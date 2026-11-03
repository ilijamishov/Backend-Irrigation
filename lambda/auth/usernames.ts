/**
 * Cognito usernames are derived from the identity provider's stable user ID,
 * so a user keeps the same account when their email changes.
 */
const GOOGLE_PREFIX = 'google_';

export function googleUsername(sub: string): string {
  return `${GOOGLE_PREFIX}${sub}`;
}
