#!/usr/bin/env node
import { App } from 'aws-cdk-lib';

import { AuthStack } from '../lib/auth-stack';
import { CONTROLLER_GROUP_NAME, ControllersStack } from '../lib/controllers-stack';
import { FirmwareStack } from '../lib/firmware-stack';
import { GithubDeployStack } from '../lib/github-deploy-stack';

const app = new App();

function context(key: string): string {
  const value: unknown = app.node.tryGetContext(key);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing CDK context "${key}" (see cdk.json).`);
  }
  if (value.includes('REPLACE_WITH')) {
    throw new Error(`Set the CDK context "${key}" in cdk.json first.`);
  }
  return value.trim();
}

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: context('region'),
};

const auth = new AuthStack(app, 'Irrigation-Auth', {
  env,
  description: 'Cognito user pool with native Google sign-in for the irrigation app',
  googleClientIds: context('googleWebClientId').split(',').map((id) => id.trim()),
});

new ControllersStack(app, 'Irrigation-Controllers', {
  env,
  description: 'What every irrigation controller shares in AWS IoT',
  provisioningRoleArn: context('provisioningRoleArn'),
  iotDataEndpoint: context('iotDataEndpoint'),
  userPool: auth.userPool,
  appClient: auth.appClient,
  // Only for the one-time `cdk import`, see the README.
  importPhase: app.node.tryGetContext('controllersImportPhase') === 'true',
});

new GithubDeployStack(app, 'Irrigation-GithubDeploy', {
  env,
  description: 'Lets GitHub Actions deploy this repository from main',
  repository: context('githubRepository'),
  ownerId: context('githubOwnerId'),
  repositoryId: context('githubRepositoryId'),
  branch: 'main',
});

new FirmwareStack(app, 'Irrigation-Firmware', {
  env,
  description: 'Firmware updates for every irrigation controller through AWS IoT Jobs',
  firmwareRepository: {
    repository: context('firmwareRepository'),
    ownerId: context('githubOwnerId'),
    repositoryId: context('firmwareRepositoryId'),
  },
  // By name, not a reference: a cross-stack export would tie the stacks'
  // deploy order. The Controllers stack creates the group.
  controllerGroupName: CONTROLLER_GROUP_NAME,
});
