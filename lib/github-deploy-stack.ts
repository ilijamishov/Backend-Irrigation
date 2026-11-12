import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';

/**
 * [repository] is the one allowed to deploy. GitHub's OIDC subject contains
 * the numeric IDs of the owner and the repository
 * (`repo:owner@<ownerId>/name@<repositoryId>:…`), so a repository deleted and
 * recreated under the same name can't deploy. Both are in
 * `https://api.github.com/repos/<owner>/<name>` (`owner.id`, `id`).
 */
export interface GithubDeployStackProps extends StackProps, GithubRepository {
  /** The only branch allowed to deploy. */
  readonly branch: string;
  /** The CDK bootstrap qualifier (the default is `hnb659fds`). */
  readonly bootstrapQualifier?: string;
}

/**
 * Lets GitHub Actions deploy without stored AWS keys: the workflow gets
 * short-lived credentials through OIDC for a role that trusts only pushes to
 * one branch of one repository. The role can do nothing but hand over to the
 * CDK bootstrap roles, which do the actual deploy.
 *
 * Deployed once by hand (it can't deploy itself the first time).
 */
export class GithubDeployStack extends Stack {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GithubDeployStackProps) {
    super(scope, id, props);

    const qualifier = props.bootstrapQualifier ?? 'hnb659fds';
    const subject = githubSubject(props);

    const provider = new iam.OidcProviderNative(this, 'GithubOidc', {
      url: GITHUB_OIDC_URL,
      clientIds: ['sts.amazonaws.com'],
    });

    this.role = new iam.Role(this, 'DeployRole', {
      roleName: 'irrigation-github-deploy',
      description: `GitHub Actions deploys from ${props.repository} (${props.branch})`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subject,
        },
      }),
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-${qualifier}-deploy-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-${qualifier}-file-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-${qualifier}-image-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-${qualifier}-lookup-role-${this.account}-${this.region}`,
        ],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', {
      value: this.role.roleArn,
      description: 'Set as the GitHub repository variable AWS_DEPLOY_ROLE_ARN',
    });
  }
}

/** A GitHub repository, with the numeric IDs its OIDC subject contains. */
export interface GithubRepository {
  /** `owner/name`. */
  readonly repository: string;
  readonly ownerId: string;
  readonly repositoryId: string;
}

/**
 * The OIDC subject of a push to [branch], in GitHub's immutable format:
 * `repo:<owner>@<ownerId>/<name>@<repositoryId>:ref:refs/heads/<branch>`.
 */
export function githubSubject(props: GithubRepository & { branch: string }): string {
  return `${githubRepositorySubject(props)}:ref:refs/heads/${props.branch}`;
}

/**
 * The start of every OIDC subject of [props] in GitHub's immutable format,
 * `repo:<owner>@<ownerId>/<name>@<repositoryId>`; the ref follows it.
 */
export function githubRepositorySubject(props: GithubRepository): string {
  const [owner, name, ...rest] = props.repository.split('/');
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Repository must be "owner/name", got "${props.repository}".`);
  }
  if (!/^\d+$/.test(props.ownerId) || !/^\d+$/.test(props.repositoryId)) {
    throw new Error('GitHub owner and repository IDs must be numeric.');
  }

  return `repo:${owner}@${props.ownerId}/${name}@${props.repositoryId}`;
}

/** The ARN of the account's GitHub OIDC provider, which this stack creates. */
export function githubOidcProviderArn(account: string): string {
  return `arn:aws:iam::${account}:oidc-provider/${new URL(GITHUB_OIDC_URL).host}`;
}
