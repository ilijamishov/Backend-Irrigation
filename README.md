# Backend Irrigation

The AWS backend of the irrigation system, as [AWS CDK](https://docs.aws.amazon.com/cdk/) stacks in TypeScript. The app is [Mobile-Irrigation](https://github.com/ilijamishov/Mobile-Irrigation); the controller firmware is [ESP32-Irrigation](https://github.com/ilijamishov/ESP32-Irrigation).

Region: `us-east-1`, the same as the controllers' AWS IoT endpoint.

## Stacks

| Stack | What it is | Deployed by |
|---|---|---|
| `Irrigation-Auth` | Cognito user pool the app signs in to, with native Google sign-in | GitHub Actions, on every push to `main` |
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

### Irrigation-GithubDeploy: deploys from GitHub

An IAM OIDC provider for GitHub and the role `irrigation-github-deploy`. The role trusts **only** pushes to `main` of `ilijamishov/Backend-Irrigation`, and may do nothing but hand over to the CDK bootstrap roles. No AWS keys are stored in GitHub.

## Configuration

`cdk.json` holds the settings. None of them are secrets:

| Key | Value |
|---|---|
| `region` | `us-east-1` |
| `githubRepository` | `ilijamishov/Backend-Irrigation` |
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

## Deployment

`.github/workflows/ci.yml`:

- **Every push and pull request:** install, type-check, test, synthesize.
- **Push to `main`, after the tests pass:** deploy `Irrigation-Auth` (`npm run deploy:ci`). One deploy runs at a time.

`Irrigation-GithubDeploy` is never deployed by the workflow; change it by hand (step 4).
