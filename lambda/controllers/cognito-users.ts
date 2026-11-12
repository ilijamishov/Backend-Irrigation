import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

/** Finds the email a user signed in with, so the Owner can tell Managers apart. */
export interface EmailDirectory {
  /** `null` when the user has none, or it can't be read. */
  emailOf(username: string): Promise<string | null>;
}

/** Deletes a user's sign-in, for account deletion. */
export interface AccountRemover {
  deleteUser(username: string): Promise<void>;
}

/** The users of the app's Cognito user pool. */
export class CognitoUsers implements EmailDirectory, AccountRemover {
  constructor(
    private readonly client: Pick<CognitoIdentityProviderClient, 'send'>,
    private readonly userPoolId: string,
  ) {}

  async emailOf(username: string): Promise<string | null> {
    try {
      const user = await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: username }),
      );
      return user.UserAttributes?.find((attribute) => attribute.Name === 'email')?.Value ?? null;
    } catch (error) {
      // Only the type: a message could contain the user's details.
      const reason = error instanceof Error ? error.name : 'unknown';
      console.error(`Could not read a user's email (${reason}).`);
      return null;
    }
  }

  /** Does nothing for a user that is gone already. */
  async deleteUser(username: string): Promise<void> {
    try {
      await this.client.send(
        new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: username }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'UserNotFoundException') return;
      throw error;
    }
  }
}
