import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { IrrigationStacks, SharedSettings } from '../lib/irrigation-stacks';
import { Stage } from '../lib/stage';

const cdkJson = require('../cdk.json') as { context: Record<string, unknown> };

const settings: SharedSettings = {
  googleClientIds: ['web-client.apps.googleusercontent.com'],
  provisioningRoleArn: 'arn:aws:iam::123456789012:role/service-role/Provisioning',
  backendRepository: { repository: 'owner/backend', ownerId: '1', repositoryId: '2' },
  firmwareRepository: { repository: 'owner/firmware', ownerId: '1', repositoryId: '3' },
  backendVersion: 'test',
  deployRegions: ['us-east-1', 'us-east-2'],
  controllersImportPhase: false,
};

/** The stacks of [stageName] as `cdk.json` describes it, without bundling the Lambdas. */
function stacksOf(stageName?: string, overrides: Partial<SharedSettings> = {}): Stack[] {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const context: Record<string, unknown> = { ...cdkJson.context, stage: stageName };
  IrrigationStacks.addTo(app, Stage.fromContext((key) => context[key]), {
    ...settings,
    ...overrides,
  });
  return app.node.children.filter((child): child is Stack => child instanceof Stack);
}

function templateOf(stacks: Stack[], name: string): Template {
  const stack = stacks.find((candidate) => candidate.stackName === name);
  if (!stack) throw new Error(`No stack ${name}`);
  return Template.fromStack(stack);
}

/** The release role's trust: only [tagPattern] of the firmware repository. */
function releaseRole(roleName: string, tagPattern: string): Record<string, unknown> {
  return {
    RoleName: roleName,
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: [
        Match.objectLike({
          Condition: Match.objectLike({
            StringLike: {
              'token.actions.githubusercontent.com:sub': `repo:owner@1/firmware@3:ref:${tagPattern}`,
            },
          }),
        }),
      ],
    }),
  };
}

describe('IrrigationStacks', () => {
  it("keeps prod's four stacks and their names in us-east-1", () => {
    const stacks = stacksOf();

    expect(stacks.map((stack) => stack.stackName)).toEqual([
      'Irrigation-Auth',
      'Irrigation-Controllers',
      'Irrigation-GithubDeploy',
      'Irrigation-Firmware',
    ]);
    expect(stacks.every((stack) => stack.region === 'us-east-1')).toBe(true);
  });

  it('gives dev its own stacks in us-east-2, without GithubDeploy', () => {
    const stacks = stacksOf('dev');

    // The OIDC provider can exist once per account; prod's deploy role serves both.
    expect(stacks.map((stack) => stack.stackName)).toEqual([
      'Irrigation-Dev-Auth',
      'Irrigation-Dev-Controllers',
      'Irrigation-Dev-Firmware',
    ]);
    expect(stacks.every((stack) => stack.region === 'us-east-2')).toBe(true);
  });

  it("keeps prod's firmware release role and version tags", () => {
    templateOf(stacksOf(), 'Irrigation-Firmware').hasResourceProperties(
      'AWS::IAM::Role',
      releaseRole('irrigation-firmware-release', 'refs/tags/v*'),
    );
  });

  it('gives dev a release role of its own, for dev-v tags only', () => {
    templateOf(stacksOf('dev'), 'Irrigation-Dev-Firmware').hasResourceProperties(
      'AWS::IAM::Role',
      releaseRole('irrigation-dev-firmware-release', 'refs/tags/dev-v*'),
    );
  });

  it("lets prod's deploy role use the bootstrap roles of both regions", () => {
    const policies = JSON.stringify(
      templateOf(stacksOf(), 'Irrigation-GithubDeploy').findResources('AWS::IAM::Policy'),
    );

    for (const region of ['us-east-1', 'us-east-2']) {
      for (const kind of ['deploy', 'file-publishing', 'image-publishing', 'lookup']) {
        // Within one ARN's Fn::Join: the account is a reference, then the region.
        expect(policies).toMatch(new RegExp(`cdk-hnb659fds-${kind}-role-[^\\]]*-${region}`));
      }
    }
    expect(policies.match(/cdk-hnb659fds-[a-z-]+-role-/g)).toHaveLength(8);
  });

  it('allows the import phase only for prod', () => {
    expect(() => stacksOf('dev', { controllersImportPhase: true })).toThrow('only for prod');
    expect(() => stacksOf(undefined, { controllersImportPhase: true })).not.toThrow();
  });

  it('describes a different region and endpoint for each stage in cdk.json', () => {
    const stages = cdkJson.context.stages as Record<string, { region: string; iotDataEndpoint: string }>;

    expect(stages.prod.region).not.toBe(stages.dev.region);
    expect(stages.prod.iotDataEndpoint).toContain(`.iot.${stages.prod.region}.`);
    expect(stages.dev.iotDataEndpoint).toContain(`.iot.${stages.dev.region}.`);
  });
});
