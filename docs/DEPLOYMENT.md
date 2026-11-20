# Deploying the backend

How to get a change to this repo live in AWS. Why each stack exists is in the [README](../README.md).

There are two stages in one AWS account (README, "Stages"): **prod** in `us-east-1`, which controllers in use and store builds of the app rely on, and **dev** in `us-east-2`, for development. A deploy to prod affects every controller and user straight away, so try a change in dev first. Every command below is for prod; add `-c stage=dev` and use the `Irrigation-Dev-` stack names for dev.

## What deploys how

| Stack | What it holds | How it deploys |
|---|---|---|
| Stage | Stacks | How they deploy |
|---|---|---|
| dev | `Irrigation-Dev-Auth`, `Irrigation-Dev-Controllers`, `Irrigation-Dev-Firmware` | **Automatically**, by GitHub Actions, on every push to `main` that passes the tests |
| prod | `Irrigation-Auth`, `Irrigation-Controllers` | **By hand**, from your computer, once the change works in dev |
| prod | `Irrigation-GithubDeploy`, `Irrigation-Firmware` | By hand, and rarely |

**A push to `main` deploys dev only.** Nothing reaches prod until you run the deploy below. `Irrigation-GithubDeploy` holds the role the workflow deploys dev with.

## Deploy to dev

A push to `main` does it. To deploy dev from your computer instead, for example before pushing:

```powershell
npx.cmd cdk diff --all -c stage=dev --profile irrigation
npx.cmd cdk deploy --all -c stage=dev --profile irrigation
```

Then check the change with a development build of the app and a dev controller.

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
   It asks for confirmation if permissions change. It also deploys `Irrigation-Auth` when needed, because the API uses its user pool. A change to sign-in only: `npx.cmd cdk deploy Irrigation-Auth --profile irrigation`.
4. **Check it worked:** open the app, and confirm your controller loads and whatever you changed works. Errors are in the CloudWatch log groups of the stack's Lambdas, whose names start with `Irrigation-Controllers-`.
5. **Push to `main`,** if you haven't yet, so the repo matches what is live. Then check the workflow in GitHub Actions passes.

## Values the app needs

The app reads these outputs at build time, from prod's stacks for `config/production.json` and from dev's (`Irrigation-Dev-…`) for `config/development.json` ([its deployment guide](https://github.com/ilijamishov/Mobile-Irrigation/blob/main/docs/DEPLOYMENT.md)). They only change if a stack is recreated, and they are shown after each deploy and in the CloudFormation console.

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

## Raising the minimum app version

Raise `minimumAppVersion` of a stage in `cdk.json` when a backend or firmware change would break older apps, in the same change. Those apps then show "Update the app" instead of failing. The rules for when it's needed, and the table of versions that work together, are in the app repo's [docs/compatibility.md](https://github.com/ilijamishov/Mobile-Irrigation/blob/main/docs/compatibility.md).

- **Only once the new app is out:** in the stores for prod, installed on the test phones for dev. Otherwise nobody has an app that works.
- **Dev** follows with the push to `main`; **prod** changes when `Irrigation-Controllers` is deployed by hand.
- **Lowering it** again is a deploy too, and lets the older apps back in.

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
- **No condition on `iot:ConnectAttributes` in the device policy.** AWS IoT re-checks an open connection now and then, and such a condition made those checks fail: from 2026-11-02 to 2026-11-13 every controller was disconnected (`AUTH_ERROR`) every few minutes. A test keeps it out.
- **A policy may have at most 2,048 characters**, not counting whitespace. The device policy is close to it, so a deploy that adds to it fails and rolls back; a test checks the size of every policy.

## Setting up from nothing

The [README](../README.md#first-time-setup) has the first-time steps: bootstrapping CDK, the GitHub deploy stack, and the variable `AWS_DEPLOY_ROLE_ARN`.

`Irrigation-Controllers` was set up by importing AWS IoT resources that already existed, which is also described there. **Creating everything in a new account has never been tried.** It needs at least the provisioning role and the AWS IoT endpoint in `cdk.json`, and the steps may need adjusting.

## Setting up dev (once)

Dev is created from nothing, unlike prod, whose AWS IoT resources were imported. In PowerShell:

1. **Raise the Lambda limit in `us-east-2`.** A region AWS hasn't used in the account allows only 10 concurrent Lambda executions, and the IoT authorizer reserves 50, so the deploy would fail. In the console: Service Quotas → `us-east-2` → AWS Lambda → **Concurrent executions** → request 1000. Check it with `aws lambda get-account-settings --region us-east-2 --profile irrigation`.
2. **Bootstrap CDK** in the region:
   ```powershell
   npx.cmd cdk bootstrap aws://289865615258/us-east-2 --profile irrigation
   ```
3. **Let the workflow deploy to `us-east-2`:** deploy prod's `Irrigation-GithubDeploy` again. Its role gets the bootstrap roles of `us-east-2` as well; the diff shows only those four.
   ```powershell
   npx.cmd cdk diff Irrigation-GithubDeploy --profile irrigation
   npx.cmd cdk deploy Irrigation-GithubDeploy --profile irrigation
   ```
4. **Deploy dev** from your computer the first time, as in [Deploy to dev](#deploy-to-dev). The user pool, table, policies, Fleet Provisioning template, thing group, authorizer, firmware bucket and the role `irrigation-dev-firmware-release` are created new. From then on a push to `main` deploys it.
5. **A claim certificate for dev controllers:** in the AWS IoT console in `us-east-2`, Security → Certificates → Create, download the certificate and key, activate it, and attach the policy `ESP32IrrigationClaimProvisioningPolicy`. It belongs in the firmware repo's `certs/dev/` (its DEPLOYMENT.md, "A dev controller"). Never commit or share the key.
6. **The app's settings:** copy the outputs of the dev stacks into the app's `config/development.json` ([Values the app needs](#values-the-app-needs)).
7. **Firmware releases to dev:** in the firmware repository on GitHub, Settings → Secrets and variables → Actions, add the outputs of `Irrigation-Dev-Firmware` as the **variables** `AWS_RELEASE_ROLE_ARN_DEV` (`ReleaseRoleArn`), `FIRMWARE_BUCKET_DEV` (`FirmwareBucketName`) and `JOBS_DOWNLOAD_ROLE_ARN_DEV` (`JobsDownloadRoleArn`), and dev's claim certificate and key as the **secrets** `CLAIM_CERTIFICATE_DEV` and `CLAIM_PRIVATE_KEY_DEV`. Then a `dev-v*` tag releases to dev's controllers (the firmware repo's DEPLOYMENT.md).

## Before a public release

- Consider having the workflow deploy `Irrigation-Controllers` as well.
