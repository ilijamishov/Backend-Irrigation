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

Never run `cdk deploy`, `cdk bootstrap` or `cdk destroy` unless the user explicitly asks in that request. `Irrigation-Auth` deploys through GitHub Actions on a push to `main`; the other stacks are deployed by hand.

## Architecture

- **`Irrigation-Auth`** (`lib/auth-stack.ts`): Cognito user pool without a Hosted UI. Native Google sign-in uses custom auth: pre sign-up, define, create and verify auth challenge triggers in `lambda/auth/`. `GoogleTokenVerifier` checks the Google ID token: Google's keys via `jose`, issuer, audience = the web client ID(s) in `GOOGLE_CLIENT_IDS`, at most 5 minutes old, verified email. Usernames are `google_<sub>` (`usernames.ts`). Handlers are built by factories (`createPreSignUpHandler(verifier)`), so tests inject a verifier with a test key pair (`test/support/google-tokens.ts`). The module-level `handler` creates its verifier on the first call. The user pool is `RETAIN` with deletion protection.
- **`Irrigation-Controllers`** (`lib/controllers-stack.ts`): what every controller shares in AWS IoT. The device policy, the claim policy and the Fleet Provisioning template were created by hand and are **imported** (`controllers-import.json`, README "Adopting the AWS IoT resources"), so they keep fixed logical IDs and `RETAIN`. `importPhase` describes them as they were before adoption, because CloudFormation compares a deploy with its last template, not with AWS. The registration hook (`lambda/controllers/registration-hook.ts`) refuses a device ID that already has a Thing, and refuses on any failure; `ThingRegistry` is injected, so tests use a fake. The device policy must follow the MQTT contract in `../ESP32-Irrigation/docs/mqtt-contract.md`: a topic the policy doesn't allow makes AWS close the controller's connection. AWS keeps at most 5 versions of a policy. Deployed by hand, not by the workflow.
- **Controllers API** (same stack, `lambda/controllers/`): `ControllersApi` (`api.ts`) is the HTTP side and takes the user only from the JWT `sub`. `ClaimService` holds the rules of the app repo's `docs/claiming.md` §4, in that order: the used hash first, because a claim clears the report. `AccessStore` (`DynamoAccessStore`) writes a claim as one conditional transaction and names whose access it ended, whose connections `ClaimService` then closes through the same `AccessRevoker` as sharing, and `ClaimReportSource` (`IotClaimReportSource`) reads the retained message; both are injected, so tests use fakes. Never log the code or its hash. `TimeZoneLookup` (`MapTimeZoneLookup`, `time-zones.ts`) finds a location's time zone with `geo-tz`, loaded on first use. An `afterBundling` hook copies its data file into the Lambda package and `GEO_TZ_DATA_PATH` points at it; tests check it is packed. The location is for the Owner only: `controllersOf` leaves it out for a Manager. Never log the position. `ZoneService` holds the zone rules of the app repo's `docs/zones.md`: a zone is a named area on one relay, which the firmware calls a "zone". Each change is one transaction with `zonesVersion` on `META`, so two changes can't put one relay on two zones. This Lambda bundles the SDK as CommonJS (`externalModules: []`), because the runtime doesn't promise every package it uses and its dependencies use `require()`.
- **Sharing** (same Lambda): `SharingService` holds the rules of the app repo's `docs/user-roles.md` §6: invitation codes of six digits (only their hash is stored, never logged), 1 hour, once, another code if one is in use, at most 10 Managers and invitations per controller. `SharingStore` (`DynamoSharingStore`) keeps each invitation as two items (under the controller, and under the code's hash), which accepting removes in the transaction that adds the Manager. `EmailDirectory` (`CognitoUsers`) reads a new Manager's email. Removal and leaving call `AccessRevoker`, which closes the user's recorded connections (`ConnectionRegistry`, `ConnectionCloser` with `DeleteConnection`) and never throws. Items that aren't a user's role have no `userId` attribute, so the `byUser` index never sees them.
- **Ownership** (same Lambda): `OwnershipService` holds the app repo's `docs/user-roles.md` §5: transfer to an existing Manager (one transaction: `ownerId` changes, the location is removed, the new Owner's role changes, the old Owner's item is deleted), release (one transaction deleting every item of the controller, plus the code items of pending invitations), and account deletion (refused while the user owns a controller; leaves each controller, then `CognitoUsers.deleteUser`). `OwnershipStore` (`DynamoOwnershipStore`) does the writes; everyone affected is revoked. Accepting an invitation checks that the controller still exists.
- **IoT authorizer** (same stack, `iot-authorizer.ts`): `TokenChecker` (`CognitoTokenVerifier`) and `AccessReader` (`DynamoAccessStore`) are injected, and `AccessPolicyBuilder` holds what each role may do, within AWS IoT's limits of 10 documents of 2,048 characters. It runs at each connection and policy refresh, and signing is off, so a bad token is refused before anything else is read. When the app names its client ID (`x-irrigation-client-id`, `<sub>-<installation ID>`), only that one may connect, and it is recorded so access changes can close it; the authorizer may `PutItem` only under `CONNECTIONS#`. The API and the authorizer must agree with the app repo's `docs/claiming.md` §7 and the MQTT contract.
- **`Irrigation-GithubDeploy`** (`lib/github-deploy-stack.ts`): GitHub OIDC provider and the deploy role. It trusts only GitHub's immutable OIDC subject `repo:<owner>@<ownerId>/<name>@<repositoryId>:ref:refs/heads/main` (`githubSubject`, IDs in `cdk.json`), not the old name-only format, and may only assume the CDK bootstrap roles. It's deployed by hand, never by the workflow. Don't add `environment:` to the deploy job, because that changes the OIDC subject the role trusts.
- **Settings** are CDK context in `cdk.json`. They aren't secrets, and secrets don't go there.

## Code style

Code is object-oriented and follows SOLID. Lambdas keep logic in testable classes or factories; the AWS event types come from `@types/aws-lambda`. Never log tokens, passwords or other credentials.

## Definition of done

Every change comes with tests. Before saying a change is finished, run `npm run build` and `npm test`; for stack changes also `npx cdk synth -c googleWebClientId=test.apps.googleusercontent.com --quiet`. Keep `README.md` up to date.

## Testing notes

- `@aws-sdk/*` is part of the Lambda runtime, so esbuild leaves it out of the bundles by default (the hook relies on this; the API bundles it).
- Unit tests can't show that a bundle loads. After changing bundling, load the synthesized `index.js` in Node once.
- `jose` is ESM-only; `jest.config.js` compiles it with ts-jest. Its path patterns accept `/` and `\`, so they work on Windows too.
- The stack tests bundle the Lambdas with esbuild, which takes a while (timeout 120 s).
