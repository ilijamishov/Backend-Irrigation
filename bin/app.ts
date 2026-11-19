#!/usr/bin/env node
import * as path from 'node:path';

import { App } from 'aws-cdk-lib';

import { BackendVersion, ProcessGit } from '../lib/backend-version';
import { IrrigationStacks } from '../lib/irrigation-stacks';
import { Stage } from '../lib/stage';

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

// `-c stage=dev` for the development copy; prod when left out.
const readContext = (key: string): unknown => app.node.tryGetContext(key);
const stage = Stage.fromContext(readContext);

IrrigationStacks.addTo(app, stage, {
  googleClientIds: context('googleWebClientId').split(',').map((id) => id.trim()),
  provisioningRoleArn: context('provisioningRoleArn'),
  backendRepository: {
    repository: context('githubRepository'),
    ownerId: context('githubOwnerId'),
    repositoryId: context('githubRepositoryId'),
  },
  firmwareRepository: {
    repository: context('firmwareRepository'),
    ownerId: context('githubOwnerId'),
    repositoryId: context('firmwareRepositoryId'),
  },
  deployRegions: Stage.regionsOf(readContext),
  backendVersion: new BackendVersion(new ProcessGit(path.join(__dirname, '..'))).describe(),
  // Only for the one-time `cdk import`, see the README.
  controllersImportPhase: app.node.tryGetContext('controllersImportPhase') === 'true',
});
