import { App } from 'aws-cdk-lib';

import { AuthStack } from './auth-stack';
import { CONTROLLER_GROUP_NAME, ControllersStack } from './controllers-stack';
import { FirmwareStack } from './firmware-stack';
import { GithubDeployStack, GithubRepository } from './github-deploy-stack';
import { Stage } from './stage';

/** What every stage shares. None of it is secret. */
export interface SharedSettings {
  /** Google OAuth clients whose ID tokens sign users in. */
  readonly googleClientIds: string[];
  /** The role AWS IoT provisions controllers with. IAM is global, so stages share it. */
  readonly provisioningRoleArn: string;
  /** This repository, which `GithubDeploy` lets deploy from `main`. */
  readonly backendRepository: GithubRepository;
  /** The firmware repository, whose tags release firmware (each stage has its own pattern). */
  readonly firmwareRepository: GithubRepository;
  readonly backendVersion: string;
  /** Every stage's region, which the GitHub deploy role may deploy to. */
  readonly deployRegions: string[];
  /** Only for the one-time `cdk import` of prod's AWS IoT resources (README). */
  readonly controllersImportPhase: boolean;
}

/** Adds one stage's stacks to the CDK app. */
export class IrrigationStacks {
  static addTo(app: App, stage: Stage, settings: SharedSettings): void {
    if (settings.controllersImportPhase && stage.name !== Stage.DEFAULT_NAME) {
      throw new Error('controllersImportPhase is only for prod, whose AWS IoT resources were made by hand.');
    }

    const env = {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: stage.region,
    };

    const auth = new AuthStack(app, stage.stackName('Auth'), {
      env,
      description: 'Cognito user pool with native Google sign-in for the irrigation app',
      googleClientIds: settings.googleClientIds,
    });

    new ControllersStack(app, stage.stackName('Controllers'), {
      env,
      description: 'What every irrigation controller shares in AWS IoT',
      provisioningRoleArn: settings.provisioningRoleArn,
      iotDataEndpoint: stage.iotDataEndpoint,
      userPool: auth.userPool,
      appClient: auth.appClient,
      importPhase: settings.controllersImportPhase,
      backendVersion: settings.backendVersion,
      minimumAppVersion: stage.minimumAppVersion,
    });

    if (stage.hasGithubDeployStack) {
      new GithubDeployStack(app, stage.stackName('GithubDeploy'), {
        env,
        description: 'Lets GitHub Actions deploy this repository from main',
        ...settings.backendRepository,
        branch: 'main',
        otherRegions: settings.deployRegions,
      });
    }

    new FirmwareStack(app, stage.stackName('Firmware'), {
      env,
      description: 'Firmware updates for every irrigation controller through AWS IoT Jobs',
      firmwareRepository: settings.firmwareRepository,
      // By name, not a reference: a cross-stack export would tie the stacks'
      // deploy order. The Controllers stack creates the group.
      controllerGroupName: CONTROLLER_GROUP_NAME,
      releaseRoleName: stage.firmwareReleaseRoleName,
      releaseTagPattern: stage.firmwareReleaseRef,
    });
  }
}
