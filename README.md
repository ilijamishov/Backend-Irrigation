# Backend Irrigation

The AWS backend of the irrigation system, as [AWS CDK](https://docs.aws.amazon.com/cdk/) stacks in TypeScript. The app is [Mobile-Irrigation](https://github.com/ilijamishov/Mobile-Irrigation); the controller firmware is [ESP32-Irrigation](https://github.com/ilijamishov/ESP32-Irrigation).

Region: `us-east-1`, the same as the controllers' AWS IoT endpoint.

## Stacks

| Stack | What it is | Deployed by |
|---|---|---|
| `Irrigation-Auth` | Cognito user pool the app signs in to, with native Google sign-in | GitHub Actions, on every push to `main` |
| `Irrigation-Controllers` | What every controller shares in AWS IoT (its policies, the Fleet Provisioning template and the registration hook), who may reach which controller, and the API for it | You, from your computer |
| `Irrigation-GithubDeploy` | Lets GitHub Actions deploy without stored AWS keys (OIDC) | You, once, from your computer |

### Irrigation-Auth: native Google sign-in

There is no Cognito Hosted UI, so no browser opens. The app gets a Google ID token from the phone's own account picker (Android Credential Manager) and uses Cognito's **custom authentication**:

1. The app calls `SignIn` with the username `google_<Google user ID>` and the custom auth flow. On the first sign-in the user doesn't exist yet: the app calls `SignUp` with the Google ID token as validation data, and the **pre sign-up** trigger checks the token and confirms the user.
2. **Define auth challenge** asks for one custom challenge; **create auth challenge** says it's a Google ID token.
3. The app answers with the Google ID token. **Verify auth challenge** checks it and that it belongs to this user's Google account. Only one attempt is allowed.
4. Cognito issues the user pool tokens. Sign-out is local; refresh tokens last 30 days.

The Google ID token is checked against Google's public keys: issuer `accounts.google.com`, audience = the web client ID in `cdk.json`, not expired, **issued at most 5 minutes ago**, and a verified email. The 5-minute limit stands in for a nonce, which `google_sign_in` can't bind to each sign-in. Tokens are never logged.

The user pool keeps its users if the stack is deleted (`RETAIN`, deletion protection on).

Outputs: `UserPoolId`, `AppClientId`, `Region`. The app needs them in its `config/development.json`.

### Irrigation-Controllers: AWS IoT for every controller

Nothing here is per controller. A new controller registers through the template, gets its own certificate and Thing, and reaches only its own topics.

- **`ESP32IrrigationDevicePolicy`:** a controller connects as itself and reaches only its own topics, following the [MQTT contract](https://github.com/ilijamishov/ESP32-Irrigation/blob/main/docs/mqtt-contract.md).
- **`ESP32IrrigationClaimProvisioningPolicy`:** the certificate in every firmware image may only register, connecting as `prov-<deviceId>`.
- **`ESP32IrrigationFleetProvisioning`:** creates the certificate and the Thing, named by the device ID.
- **Registration hook:** a Lambda that runs before each registration. It refuses anything that isn't a device ID, and any device ID that already has a Thing. Otherwise someone who extracted the claim certificate from a firmware image could get a valid certificate for an existing controller. Any failure also refuses.

The design is in the app repo's [docs/claiming.md](https://github.com/ilijamishov/Mobile-Irrigation/blob/main/docs/claiming.md).

**A fully erased controller can't register again** until its old Thing is gone, because its certificate was erased too. Find the certificate, detach it from the Thing and the device policy, deactivate and delete it, then delete the Thing. The same applies if a controller never received AWS's answer to its registration. A factory reset keeps the certificate, so it doesn't need this.

**The API** lets the app claim a controller, list a user's controllers and name them. It needs a Cognito access token from the app client, and the user is always taken from that token.

| Call | Purpose |
|---|---|
| `GET /controllers` | The user's controllers, with name and role |
| `POST /controllers/{deviceId}/claim` | Claims a controller with its one-time code |
| `PUT /controllers/{deviceId}/name` | Names a controller, for its Owner only |

The rules and answers are in [docs/claiming.md](https://github.com/ilijamishov/Mobile-Irrigation/blob/main/docs/claiming.md) §4 and §5. Access is stored in the DynamoDB table `irrigation-access`, which has deletion protection and point-in-time recovery, and is kept if the stack is deleted. The claim handler reads each controller's report as a retained AWS IoT message and stores no codes.

Outputs: `ApiUrl`, which the app needs, and `ControllersApiName`.

### Irrigation-GithubDeploy: deploys from GitHub

An IAM OIDC provider for GitHub and the role `irrigation-github-deploy`. The role trusts **only** pushes to `main` of `ilijamishov/Backend-Irrigation`, and may do nothing but hand over to the CDK bootstrap roles. No AWS keys are stored in GitHub.

GitHub's OIDC subject for this repository uses the **immutable format** with numeric IDs, `repo:ilijamishov@17722294/Backend-Irrigation@1444921207:ref:refs/heads/main` (repositories created since mid-2026 get it by default). The role trusts only that subject, so a repository deleted and recreated under the same name can't deploy. The IDs are in `cdk.json`; both come from `https://api.github.com/repos/ilijamishov/Backend-Irrigation` (`owner.id` and `id`). A failed sign-in shows the subject GitHub actually sent in CloudTrail (`AssumeRoleWithWebIdentity`, `userIdentity.principalId`).

## Configuration

`cdk.json` holds the settings. None of them are secrets:

| Key | Value |
|---|---|
| `region` | `us-east-1` |
| `githubRepository` | `ilijamishov/Backend-Irrigation` |
| `githubOwnerId`, `githubRepositoryId` | GitHub's numeric IDs of the owner and the repository, for the OIDC subject |
| `provisioningRoleArn` | The existing role that lets AWS IoT register controllers |
| `iotDataEndpoint` | This account's AWS IoT data endpoint (`aws iot describe-endpoint --endpoint-type iot:Data-ATS`) |
| `googleWebClientId` | The **web** OAuth client ID from Google Cloud (`….apps.googleusercontent.com`). Synthesis fails while it's the placeholder. Several IDs can be given, separated by commas. |

## Development

```sh
npm ci
npm run build    # type-check
npm test         # unit tests of the Lambdas and the stacks
npx cdk synth    # build the CloudFormation templates into cdk.out/
```

The Lambdas are in `lambda/`, bundled by esbuild (`NodejsFunction`) for Node.js 24 on ARM.

## First-time setup

Done once, from your computer:

1. **Install the AWS CLI** and sign in with an account that may create IAM roles, for example with `aws configure sso` or `aws configure`. Check with `aws sts get-caller-identity`.
2. **Set the Google web client ID** in `cdk.json`.
3. **Bootstrap CDK** in the account and region:
   ```sh
   npx cdk bootstrap aws://<account-id>/us-east-1
   ```
4. **Deploy the GitHub deploy stack:**
   ```sh
   npx cdk deploy Irrigation-GithubDeploy
   ```
   Note the output `DeployRoleArn`.
5. **In GitHub**, open the repository's Settings → Secrets and variables → Actions → **Variables**, and add `AWS_DEPLOY_ROLE_ARN` with that ARN.
6. **Push to `main`.** GitHub Actions tests and deploys `Irrigation-Auth`. Its outputs are in the workflow log and in the CloudFormation console.

If the account already has a GitHub OIDC provider, step 4 fails with "already exists". Then the stack has to import the existing provider instead.

### Adopting the AWS IoT resources

The policies and the template were created by hand and controllers depend on them, so `Irrigation-Controllers` imports them instead of creating new ones. Done once, in PowerShell:

```powershell
npx.cmd cdk import Irrigation-Controllers -c controllersImportPhase=true --resource-mapping controllers-import.json --profile irrigation
npx.cmd cdk deploy Irrigation-Controllers --profile irrigation
```

The first command adopts the resources without changing them. `controllersImportPhase` makes the stack describe them exactly as they were, because CloudFormation compares a deploy with its last template and not with AWS: importing the final version would mean the second command never applies the differences. The second command adds the hook and restricts the claim policy.

Controllers keep their certificates: a policy is updated in place, and it is kept if the stack is ever deleted.

This was done on 2026-11-04. Later changes to the stack only need the second command. It also deploys `Irrigation-Auth` when needed, because the API uses its user pool.

## Deployment

`.github/workflows/ci.yml`:

- **Every push and pull request:** install, type-check, test, synthesize.
- **Push to `main`, after the tests pass:** deploy `Irrigation-Auth` (`npm run deploy:ci`). One deploy runs at a time.

`Irrigation-GithubDeploy` is never deployed by the workflow; change it by hand (step 4). `Irrigation-Controllers` isn't deployed by the workflow yet either: a deploy before the import above would fail, because the resources already exist.
