import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { AuthStack } from '../lib/auth-stack';
import { GithubDeployStack, githubSubject } from '../lib/github-deploy-stack';

const env = { account: '123456789012', region: 'us-east-1' };

describe('AuthStack', () => {
  // Synthesizing bundles the four Lambdas with esbuild, which takes a while.
  jest.setTimeout(120_000);

  let template: Template;

  beforeAll(() => {
    const stack = new AuthStack(new App(), 'Auth', {
      env,
      googleClientIds: ['web-client.apps.googleusercontent.com'],
    });
    template = Template.fromStack(stack);
  });

  it('has a user pool with the four sign-in triggers and no Hosted UI', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: {
        PreSignUp: Match.anyValue(),
        DefineAuthChallenge: Match.anyValue(),
        CreateAuthChallenge: Match.anyValue(),
        VerifyAuthChallengeResponse: Match.anyValue(),
      },
      DeletionProtection: 'ACTIVE',
    });
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
    template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
  });

  it('keeps the users when the stack is deleted', () => {
    template.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('lets the app sign in only with the custom challenge', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      ExplicitAuthFlows: ['ALLOW_CUSTOM_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      PreventUserExistenceErrors: 'LEGACY',
    });
  });

  it('gives the Google client ID to the triggers that check tokens', () => {
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        Environment: {
          Variables: { GOOGLE_CLIENT_IDS: 'web-client.apps.googleusercontent.com' },
        },
        Runtime: 'nodejs24.x',
      },
      2,
    );
  });

  it('needs a Google client ID', () => {
    expect(
      () => new AuthStack(new App(), 'NoGoogle', { env, googleClientIds: [] }),
    ).toThrow(/Google client ID/);
  });
});

describe('GithubDeployStack', () => {
  let template: Template;

  beforeAll(() => {
    const stack = new GithubDeployStack(new App(), 'Deploy', {
      env,
      repository: 'ilijamishov/Backend-Irrigation',
      ownerId: '17722294',
      repositoryId: '1444921207',
      branch: 'main',
    });
    template = Template.fromStack(stack);
  });

  it('trusts only pushes to main of this repository', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:ilijamishov@17722294/Backend-Irrigation@1444921207:ref:refs/heads/main',
              },
            },
          }),
        ],
      },
    });
  });

  it('builds the immutable subject and refuses bad input', () => {
    const base = { ownerId: '1', repositoryId: '2', branch: 'main' };

    expect(githubSubject({ ...base, repository: 'o/r' })).toBe('repo:o@1/r@2:ref:refs/heads/main');
    expect(() => githubSubject({ ...base, repository: 'no-slash' })).toThrow(/owner\/name/);
    expect(() => githubSubject({ ...base, repository: 'o/r', ownerId: 'abc' })).toThrow(/numeric/);
  });

  it('may only hand over to the CDK bootstrap roles', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Resource: Match.arrayWith([
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role-123456789012-us-east-1',
            ]),
          },
        ],
      },
    });
  });
});
