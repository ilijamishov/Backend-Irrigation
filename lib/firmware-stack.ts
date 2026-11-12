import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

import {
  type GithubRepository,
  githubOidcProviderArn,
  githubRepositorySubject,
} from './github-deploy-stack';

/** Where firmware images are kept in the bucket. */
export const FIRMWARE_PREFIX = 'firmware/';
/** Every firmware job starts with this, so the release role can't touch others. */
export const FIRMWARE_JOB_PREFIX = 'firmware-';
/** Only tags like `v1.2.0` release firmware. */
export const RELEASE_TAG_PATTERN = 'refs/tags/v*';

export interface FirmwareStackProps extends StackProps {
  /** The firmware repository; only its version tags may release. */
  readonly firmwareRepository: GithubRepository;
  /** The thing group every controller is in (the Controllers stack's). */
  readonly controllerGroupName: string;
}

/**
 * Firmware updates through AWS IoT Jobs. A version tag in the firmware
 * repository uploads the image here and creates a job for every controller;
 * AWS IoT gives each controller a short-lived link to download it. Nothing here
 * lets a controller reach S3 itself.
 *
 * The role for GitHub Actions uses the OIDC provider of `Irrigation-GithubDeploy`.
 */
export class FirmwareStack extends Stack {
  constructor(scope: Construct, id: string, props: FirmwareStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'FirmwareBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // A replaced image stays recoverable for a while.
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90) }],
      // Controllers in the middle of an update still download from it.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const downloadRole = this.addDownloadRole(bucket);
    const releaseRole = this.addReleaseRole(props, bucket, downloadRole);

    new CfnOutput(this, 'FirmwareBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'JobsDownloadRoleArn', { value: downloadRole.roleArn });
    new CfnOutput(this, 'ReleaseRoleArn', {
      value: releaseRole.roleArn,
      description: 'Set as the firmware repository variable AWS_RELEASE_ROLE_ARN',
    });
  }

  /** What AWS IoT Jobs signs each controller's download link with. */
  private addDownloadRole(bucket: s3.IBucket): iam.Role {
    const role = new iam.Role(this, 'JobsDownloadRole', {
      description: 'AWS IoT Jobs signs firmware download links for controllers with this',
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects(`${FIRMWARE_PREFIX}*`)],
      }),
    );

    return role;
  }

  /**
   * GitHub Actions releases a version tag of the firmware repository: it
   * uploads the image and replaces the job for the controller group.
   */
  private addReleaseRole(
    props: FirmwareStackProps,
    bucket: s3.IBucket,
    downloadRole: iam.IRole,
  ): iam.Role {
    const repository = props.firmwareRepository;
    const role = new iam.Role(this, 'ReleaseRole', {
      roleName: 'irrigation-firmware-release',
      description: `GitHub Actions releases firmware from ${repository.repository} (version tags)`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubOidcProviderArn(this.account), {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `${githubRepositorySubject(repository)}:ref:${RELEASE_TAG_PATTERN}`,
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects(`${FIRMWARE_PREFIX}*`)],
      }),
    );

    const firmwareJobs = this.iotArn(`job/${FIRMWARE_JOB_PREFIX}*`);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iot:CreateJob'],
        resources: [firmwareJobs, this.iotArn(`thinggroup/${props.controllerGroupName}`)],
      }),
    );
    // A new release replaces the job of the one before.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iot:DescribeJob', 'iot:CancelJob'],
        resources: [firmwareJobs],
      }),
    );
    // ListJobs can't be limited to some jobs.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['iot:ListJobs'], resources: ['*'] }));
    // Creating a job hands AWS IoT the role that signs the download links.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [downloadRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'iot.amazonaws.com' } },
      }),
    );

    return role;
  }

  private iotArn(resource: string): string {
    return `arn:aws:iot:${this.region}:${this.account}:${resource}`;
  }
}
