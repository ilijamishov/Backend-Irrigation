import * as path from 'node:path';

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export interface AuthStackProps extends StackProps {
  /**
   * Google OAuth client IDs a Google ID token may be issued for: the web
   * client ID the app passes to Google Sign-In as `serverClientId`.
   */
  readonly googleClientIds: readonly string[];
}

/**
 * The Cognito user pool the app signs in to. There is no Hosted UI: the app
 * gets a Google ID token from the phone's own account picker and answers a
 * custom challenge with it. The Lambda triggers check the token with Google.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly appClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    if (props.googleClientIds.length === 0) {
      throw new Error('AuthStack needs at least one Google client ID.');
    }

    const environment = { GOOGLE_CLIENT_IDS: props.googleClientIds.join(',') };
    const trigger = (name: string, needsGoogle: boolean) =>
      new NodejsFunction(this, name, {
        entry: path.join(__dirname, '..', 'lambda', 'auth', `${kebab(name)}.ts`),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(10),
        environment: needsGoogle ? environment : undefined,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: { minify: true, sourceMap: true, format: OutputFormat.ESM, target: 'node24' },
      });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'irrigation-users',
      // Sign-up is open to the app, but the pre sign-up trigger refuses any
      // request without a valid Google ID token for that username.
      selfSignUpEnabled: true,
      signInAliases: { username: true },
      signInCaseSensitive: true,
      standardAttributes: { email: { required: false, mutable: true } },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OFF,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lambdaTriggers: {
        preSignUp: trigger('PreSignUp', true),
        defineAuthChallenge: trigger('DefineAuthChallenge', false),
        createAuthChallenge: trigger('CreateAuthChallenge', false),
        verifyAuthChallengeResponse: trigger('VerifyAuthChallenge', true),
      },
    });

    this.appClient = this.userPool.addClient('AppClient', {
      userPoolClientName: 'mobile-app',
      generateSecret: false,
      authFlows: { custom: true },
      // A missing user must be reported, so the app knows to sign up first.
      preventUserExistenceErrors: false,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'AppClientId', { value: this.appClient.userPoolClientId });
    new CfnOutput(this, 'Region', { value: this.region });
  }
}

function kebab(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}
