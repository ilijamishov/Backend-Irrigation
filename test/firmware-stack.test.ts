import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import {
  FIRMWARE_JOB_PREFIX,
  FIRMWARE_PREFIX,
  FirmwareStack,
  RELEASE_TAG_PATTERN,
} from '../lib/firmware-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const iot = 'arn:aws:iot:us-east-1:123456789012';

type Statement = {
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, string>>;
};

describe('FirmwareStack', () => {
  let template: Template;

  beforeAll(() => {
    template = Template.fromStack(
      new FirmwareStack(new App(), 'Firmware', {
        env,
        firmwareRepository: {
          repository: 'ilijamishov/ESP32-Irrigation',
          ownerId: '17722294',
          repositoryId: '555',
        },
        controllerGroupName: 'irrigation-controllers',
      }),
    );
  });

  function roleNamed(prefix: string) {
    const [role] = Object.entries(template.findResources('AWS::IAM::Role')).filter(([id]) =>
      id.startsWith(prefix),
    );
    return role[1].Properties;
  }

  function statementsOf(rolePrefix: string): Statement[] {
    const [, policy] = Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) =>
      id.startsWith(rolePrefix),
    )!;
    return policy.Properties.PolicyDocument.Statement;
  }

  describe('the bucket', () => {
    it('is private, encrypted, HTTPS only and versioned', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: Match.objectLike({}),
        VersioningConfiguration: { Status: 'Enabled' },
      });
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    });

    it('is kept if the stack is deleted', () => {
      template.hasResource('AWS::S3::Bucket', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });
  });

  describe('the download role', () => {
    it('can be used only by AWS IoT of this account', () => {
      expect(roleNamed('JobsDownloadRole').AssumeRolePolicyDocument.Statement).toEqual([
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRole',
          Principal: { Service: 'iot.amazonaws.com' },
          Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
        },
      ]);
    });

    it('may only read firmware images', () => {
      const statements = statementsOf('JobsDownloadRole');

      expect(statements).toHaveLength(1);
      expect(statements[0].Action).toBe('s3:GetObject');
      expect(JSON.stringify(statements[0].Resource)).toContain(`/${FIRMWARE_PREFIX}*`);
    });
  });

  describe('the release role', () => {
    it('trusts only version tags of the firmware repository', () => {
      const [statement] = roleNamed('ReleaseRole').AssumeRolePolicyDocument.Statement;

      expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
      expect(statement.Principal.Federated).toBe(
        'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
      );
      expect(statement.Condition).toEqual({
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:ilijamishov@17722294/ESP32-Irrigation@555:ref:${RELEASE_TAG_PATTERN}`,
        },
      });
      expect(RELEASE_TAG_PATTERN).toBe('refs/tags/v*');
    });

    it('may upload firmware images and nothing else to S3', () => {
      const s3 = statementsOf('ReleaseRole').filter((s) => JSON.stringify(s.Action).includes('s3:'));

      expect(s3).toHaveLength(1);
      expect(s3[0].Action).toBe('s3:PutObject');
      expect(JSON.stringify(s3[0].Resource)).toContain(`/${FIRMWARE_PREFIX}*`);
    });

    it('may create firmware jobs only for the controller group', () => {
      const create = statementsOf('ReleaseRole').find((s) => s.Action === 'iot:CreateJob');

      expect(create?.Resource).toEqual([
        `${iot}:job/${FIRMWARE_JOB_PREFIX}*`,
        `${iot}:thinggroup/irrigation-controllers`,
      ]);
    });

    it('may replace only firmware jobs', () => {
      const replace = statementsOf('ReleaseRole').find((s) =>
        JSON.stringify(s.Action).includes('iot:CancelJob'),
      );

      expect(replace?.Resource).toBe(`${iot}:job/${FIRMWARE_JOB_PREFIX}*`);
    });

    it('may pass only the download role, and only to AWS IoT', () => {
      const pass = statementsOf('ReleaseRole').filter((s) =>
        JSON.stringify(s.Action).includes('iam:'),
      );

      expect(pass).toHaveLength(1);
      expect(pass[0].Action).toBe('iam:PassRole');
      expect(JSON.stringify(pass[0].Resource)).toContain('JobsDownloadRole');
      expect(pass[0].Condition).toEqual({
        StringEquals: { 'iam:PassedToService': 'iot.amazonaws.com' },
      });
    });

    it('has nothing beyond S3 uploads, firmware jobs and passing the download role', () => {
      const actions = statementsOf('ReleaseRole').flatMap((s) => s.Action);

      expect(actions.sort()).toEqual(
        [
          's3:PutObject',
          'iot:CreateJob',
          'iot:DescribeJob',
          'iot:CancelJob',
          'iot:ListJobs',
          'iam:PassRole',
        ].sort(),
      );
    });
  });
});
