/**
 * One copy of the backend: `prod`, which controllers and store builds of the
 * app use, or `dev`, for development. Each runs in its own region, so each has
 * its own AWS IoT endpoint, Things, user pool and table, and nothing in one can
 * reach the other.
 *
 * Settings are CDK context: `stage` picks one (`-c stage=dev`, `prod` when left
 * out), and `stages` in `cdk.json` describes each.
 */
export class Stage {
  static readonly DEFAULT_NAME = 'prod';

  private constructor(
    readonly name: string,
    /** The region all of the stage's stacks are in. */
    readonly region: string,
    /** The stage's AWS IoT data endpoint, which controllers connect to. */
    readonly iotDataEndpoint: string,
    private readonly stackPrefix: string,
    /**
     * Whether the stage has `GithubDeploy`. GitHub's OIDC provider can exist
     * once per account, and its role serves every stage, so only one has it.
     */
    readonly hasGithubDeployStack: boolean,
    /** The firmware release role's name. IAM names are account-wide. */
    readonly firmwareReleaseRoleName: string,
    /** Which firmware repository tags release to this stage, such as `v*`. */
    readonly firmwareReleaseTag: string,
  ) {}

  /** Reads the stage named by the context `stage` from the context `stages`. */
  static fromContext(context: (key: string) => unknown): Stage {
    const chosen = context('stage') ?? Stage.DEFAULT_NAME;
    if (typeof chosen !== 'string' || chosen.trim().length === 0) {
      throw new Error('The CDK context "stage" must name a stage, such as "prod" or "dev".');
    }
    const name = chosen.trim();

    const stages = context('stages');
    if (!isRecord(stages)) {
      throw new Error('Missing CDK context "stages" (see cdk.json).');
    }
    const settings = stages[name];
    if (!isRecord(settings)) {
      const known = Object.keys(stages).join(', ');
      throw new Error(`Unknown stage "${name}". Known stages: ${known}.`);
    }

    return new Stage(
      name,
      text(settings, name, 'region'),
      text(settings, name, 'iotDataEndpoint'),
      text(settings, name, 'stackPrefix'),
      flag(settings, name, 'githubDeployStack'),
      text(settings, name, 'firmwareReleaseRoleName'),
      text(settings, name, 'firmwareReleaseTag'),
    );
  }

  /** The region of every stage in the context `stages`. */
  static regionsOf(context: (key: string) => unknown): string[] {
    const stages = context('stages');
    if (!isRecord(stages)) {
      throw new Error('Missing CDK context "stages" (see cdk.json).');
    }
    return Object.keys(stages).map((name) => {
      const ofThisStage = (key: string): unknown => (key === 'stage' ? name : context(key));
      return Stage.fromContext(ofThisStage).region;
    });
  }

  /** The tag pattern in GitHub's OIDC subject, such as `refs/tags/v*`. */
  get firmwareReleaseRef(): string {
    return `refs/tags/${this.firmwareReleaseTag}`;
  }

  /** `Auth` becomes `Irrigation-Auth` in prod and `Irrigation-Dev-Auth` in dev. */
  stackName(part: string): string {
    return `${this.stackPrefix}-${part}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(settings: Record<string, unknown>, stage: string, key: string): string {
  const value = settings[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Stage "${stage}" needs "${key}" in cdk.json.`);
  }
  return value.trim();
}

function flag(settings: Record<string, unknown>, stage: string, key: string): boolean {
  const value = settings[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Stage "${stage}" needs "${key}" (true or false) in cdk.json.`);
  }
  return value;
}
