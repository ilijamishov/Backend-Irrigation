# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AWS backend of the irrigation system, as AWS CDK stacks in TypeScript (`bin/app.ts`, `lib/`), with Lambda code in `lambda/`. Region `us-east-1`. The app is `../Mobile-Irrigation` and the firmware `../ESP32-Irrigation`. Use the terms in `../Mobile-Irrigation/docs/glossary.md`. User roles are specified in `../Mobile-Irrigation/docs/user-roles.md`.

## Commands

```sh
npm ci
npm run build      # tsc --noEmit
npm test           # jest
npx cdk synth      # needs googleWebClientId set in cdk.json (or -c googleWebClientId=...)
```

Never run `cdk deploy`, `cdk bootstrap` or `cdk destroy` unless the user explicitly asks in that request. Deploys happen through GitHub Actions on a push to `main`.

## Architecture

- **`Irrigation-Auth`** (`lib/auth-stack.ts`): Cognito user pool without a Hosted UI. Native Google sign-in uses custom auth: pre sign-up, define, create and verify auth challenge triggers in `lambda/auth/`. `GoogleTokenVerifier` checks the Google ID token: Google's keys via `jose`, issuer, audience = the web client ID(s) in `GOOGLE_CLIENT_IDS`, at most 5 minutes old, verified email. Usernames are `google_<sub>` (`usernames.ts`). Handlers are built by factories (`createPreSignUpHandler(verifier)`), so tests inject a verifier with a test key pair (`test/support/google-tokens.ts`). The module-level `handler` creates its verifier on the first call. The user pool is `RETAIN` with deletion protection.
- **`Irrigation-GithubDeploy`** (`lib/github-deploy-stack.ts`): GitHub OIDC provider and the deploy role. It trusts only `repo:<githubRepository>:ref:refs/heads/main` and may only assume the CDK bootstrap roles. It's deployed by hand, never by the workflow. Don't add `environment:` to the deploy job, because that changes the OIDC subject the role trusts.
- **Settings** are CDK context in `cdk.json`. They aren't secrets, and secrets don't go there.

## Code style

Code is object-oriented and follows SOLID. Lambdas keep logic in testable classes or factories; the AWS event types come from `@types/aws-lambda`. Never log tokens, passwords or other credentials.

## Definition of done

Every change comes with tests. Before saying a change is finished, run `npm run build` and `npm test`; for stack changes also `npx cdk synth -c googleWebClientId=test.apps.googleusercontent.com --quiet`. Keep `README.md` up to date.

## Testing notes

- `jose` is ESM-only; `jest.config.js` compiles it with ts-jest. Its path patterns accept `/` and `\`, so they work on Windows too.
- The stack tests bundle the Lambdas with esbuild, which takes a while (timeout 120 s).
