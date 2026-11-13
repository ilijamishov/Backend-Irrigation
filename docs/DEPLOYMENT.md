# Deploying the backend

How to get a change to this repo live in AWS. Why each stack exists is in the [README](../README.md).

There is one environment: one AWS account, in `us-east-1`. Development and real use share it, so a deploy affects every controller and user straight away.

## What deploys how

| Stack | What it holds | How it deploys |
|---|---|---|
| `Irrigation-Auth` | Sign-in (Cognito) | Automatically, by GitHub Actions, on every push to `main` that passes the tests |
| `Irrigation-Controllers` | The API, the AWS IoT policies and template, the app authorizer, the table `irrigation-access` | **By hand**, from your computer |
| `Irrigation-GithubDeploy` | What lets GitHub Actions deploy | By hand, and rarely |
| `Irrigation-Firmware` | The firmware bucket, and the roles that release firmware and sign its download links | By hand, and rarely |

**Pushing to `main` doesn't deploy `Irrigation-Controllers`.** A change to the API or to AWS IoT isn't live until you run the deploy below.

## Before you start

- Node.js 24, as CI uses
- The AWS CLI, with the SSO profile `irrigation`
- This repo with its dependencies installed: `npm ci`

Sign in, which lasts a few hours:

```powershell
aws sso login --profile irrigation
```

## Deploy a change

The commands use PowerShell, where `npx` must be written `npx.cmd`.

1. **Check it:**
   ```powershell
   npm run build
   npm test
   ```
2. **See what would change:**
   ```powershell
   npx.cmd cdk diff Irrigation-Controllers --profile irrigation
   ```
   Read it before going on. Be careful with anything marked for replacement or removal, and with changes to `DevicePolicy`, `ClaimPolicy` or `FleetProvisioningTemplate`, because controllers in use depend on them.
3. **Deploy:**
   ```powershell
   npx.cmd cdk deploy Irrigation-Controllers --profile irrigation
   ```
   It asks for confirmation if permissions change. It also deploys `Irrigation-Auth` when needed, because the API uses its user pool.
4. **Check it worked:** open the app, and confirm your controller loads and whatever you changed works. Errors are in the CloudWatch log groups of the stack's Lambdas, whose names start with `Irrigation-Controllers-`.
5. **Push to `main`,** if you haven't yet, so the repo matches what is live. Then check the workflow in GitHub Actions passes.

## Values the app needs

The app reads these outputs at build time ([its deployment guide](https://github.com/ilijamishov/Mobile-Irrigation/blob/main/docs/DEPLOYMENT.md)). They only change if a stack is recreated, and they are shown after each deploy and in the CloudFormation console.

| Stack output | App setting |
|---|---|
| `Irrigation-Auth`: `UserPoolId` | `COGNITO_USER_POOL_ID` |
| `Irrigation-Auth`: `AppClientId` | `COGNITO_CLIENT_ID` |
| `Irrigation-Controllers`: `ApiUrl` | `API_URL` |
| `Irrigation-Controllers`: `IotAuthorizerName` | `MQTT_AUTHORIZER` |

The firmware repository needs one, as a GitHub Actions variable:

| Stack output | Firmware repository variable |
|---|---|
| `Irrigation-Firmware`: `ReleaseRoleArn` | `AWS_RELEASE_ROLE_ARN` |

Other settings are in `cdk.json`. The time zone table only needs regenerating when a country changes its rules (see the README).

## Order, when other projects are involved

- **A new API route or field:** deploy the backend first, then release the app.
- **A change to a topic in the MQTT contract:** add it to the device policy and deploy **before** flashing firmware that uses it. AWS IoT closes the controller's connection on a topic the policy doesn't allow. The same goes for the AWS IoT Jobs topics that firmware updates use.

## Firmware updates, first time

Done once, before the first firmware that updates itself is flashed:

1. **Make sure there is no group `irrigation-controllers` yet** (`aws iot list-thing-groups --profile irrigation`). The stack creates it, and fails if it already exists. One may be left over from a failed deploy, because the group is kept on a rollback; delete it if it has no controllers in it (`aws iot delete-thing-group --thing-group-name irrigation-controllers --profile irrigation`).
2. **Check the firmware repository's ID** in `cdk.json` (`firmwareRepositoryId`, set to `1410996714`). It only changes if the repository is recreated. The repository is private, so read it while signed in to GitHub: the page source of the repository has it in `octolytics-dimension-repository_id`.
3. **Deploy `Irrigation-Controllers`** as in [Deploy a change](#deploy-a-change). The diff shows the template, the new group `irrigation-controllers`, the new policy `ESP32IrrigationJobsPolicy` and its attachment to the group. The device policy doesn't change, so controllers stay connected.
4. **Add the controllers registered so far to the group.** New ones join it as they register.
   ```powershell
   $env:AWS_PROFILE = 'irrigation'
   npx.cmd ts-node scripts/add-controllers-to-group.ts
   ```
   It prints the controllers in the group. Running it again changes nothing.
5. **Deploy `Irrigation-Firmware`:**
   ```powershell
   npx.cmd cdk deploy Irrigation-Firmware --profile irrigation
   ```
   It asks for confirmation, because it creates IAM roles. It needs `Irrigation-GithubDeploy`, whose GitHub OIDC provider its release role uses.
6. **In the firmware repository on GitHub,** open Settings → Secrets and variables → Actions → **Variables**, and add `AWS_RELEASE_ROLE_ARN` with the output `ReleaseRoleArn`.

## Undoing a deploy

Revert the commit, then deploy again as above. There is no separate rollback step.

- **The table and users stay.** The table, the user pool and the AWS IoT resources are kept even if a stack is deleted, so a code rollback doesn't lose them.
- **Data written by the newer version stays too,** so check that the older code can read it.
- **AWS IoT keeps at most 5 versions of a policy.** If a policy deploy fails because of that, delete an old unused version.
- **A policy may have at most 2,048 characters**, not counting whitespace. The device policy is close to it, so a deploy that adds to it fails and rolls back; a test checks the size of every policy.

## Setting up from nothing

The [README](../README.md#first-time-setup) has the first-time steps: bootstrapping CDK, the GitHub deploy stack, and the variable `AWS_DEPLOY_ROLE_ARN`.

`Irrigation-Controllers` was set up by importing AWS IoT resources that already existed, which is also described there. **Creating everything in a new account has never been tried.** It needs at least the provisioning role and the AWS IoT endpoint in `cdk.json`, and the steps may need adjusting.

## Before a public release

- Consider a separate environment, because today a mistake reaches every user at once.
- Consider having the workflow deploy `Irrigation-Controllers` as well.
