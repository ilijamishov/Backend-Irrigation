import * as path from 'node:path';

import { CfnOutput, CfnResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  type AwsSdkCall,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

import { EXPIRY_ATTRIBUTE } from '../lambda/controllers/connections';

export const DEVICE_POLICY_NAME = 'ESP32IrrigationDevicePolicy';
/** Firmware updates through AWS IoT Jobs, attached to the controller group. */
export const JOBS_POLICY_NAME = 'ESP32IrrigationJobsPolicy';
export const CLAIM_POLICY_NAME = 'ESP32IrrigationClaimProvisioningPolicy';
export const TEMPLATE_NAME = 'ESP32IrrigationFleetProvisioning';
export const ACCESS_TABLE_NAME = 'irrigation-access';
export const AUTHORIZER_NAME = 'irrigation-app';
/** How many app connection checks may run at once: far more than needed. */
export const AUTHORIZER_CONCURRENCY = 50;
/** Every registered controller; firmware updates are sent to this group. */
export const CONTROLLER_GROUP_NAME = 'irrigation-controllers';
/** Where the time zone map is in the API's Lambda package. */
const TIME_ZONE_MAP_FOLDER = 'time-zone-map';
const TIME_ZONE_MAP_FILE = 'timezones.geojson.geo.dat';
const USER_INDEX_NAME = 'byUser';

/** The controller's own Thing name, which AWS IoT fills in on each request. */
const THING = '${iot:Connection.Thing.ThingName}';

export interface ControllersStackProps extends StackProps {
  /** The existing role that lets AWS IoT register controllers. */
  readonly provisioningRoleArn: string;
  /** Whose tokens the API accepts. */
  readonly userPool: cognito.IUserPool;
  readonly appClient: cognito.IUserPoolClient;
  /** The AWS IoT data endpoint of this account, for retained messages. */
  readonly iotDataEndpoint: string;
  /**
   * Describes the AWS IoT resources exactly as they were before this stack
   * adopted them, for `cdk import`. CloudFormation compares a deploy with its
   * last template, not with AWS, so importing anything else would mean the
   * following deploy never applies the difference.
   */
  readonly importPhase?: boolean;
  /** What `GET /version` answers: the commit the stacks were built from. */
  readonly backendVersion?: string;
}

/**
 * What every controller shares in AWS IoT. Nothing here is per controller: a
 * new one registers through the template and reaches only its own topics.
 */
export class ControllersStack extends Stack {
  constructor(scope: Construct, id: string, props: ControllersStackProps) {
    super(scope, id, props);

    const importPhase = props.importPhase ?? false;

    adopted(
      new iot.CfnPolicy(this, 'DevicePolicy', {
        policyName: DEVICE_POLICY_NAME,
        policyDocument: this.devicePolicy(),
      }),
    );

    adopted(
      new iot.CfnPolicy(this, 'ClaimPolicy', {
        policyName: CLAIM_POLICY_NAME,
        // Before: any client ID, which could knock a controller offline.
        policyDocument: this.claimPolicy(importPhase ? 'client/*' : 'client/prov-*'),
      }),
    );

    const template = adopted(
      new iot.CfnProvisioningTemplate(this, 'FleetProvisioningTemplate', {
        templateName: TEMPLATE_NAME,
        templateType: 'FLEET_PROVISIONING',
        enabled: true,
        provisioningRoleArn: props.provisioningRoleArn,
        // Before: new controllers joined no group.
        templateBody: JSON.stringify(registrationTemplate(importPhase ? [] : [CONTROLLER_GROUP_NAME])),
      }),
    );

    if (importPhase) return;

    // A registration adds the new Thing to the group, so it must exist first.
    template.node.addDependency(this.addControllerGroup());

    const hook = new NodejsFunction(this, 'RegistrationHook', {
      entry: path.join(__dirname, '..', 'lambda', 'controllers', 'registration-hook.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // AWS IoT waits 5 seconds and then refuses the registration.
      timeout: Duration.seconds(5),
      logGroup: new logs.LogGroup(this, 'RegistrationHookLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true, format: OutputFormat.ESM, target: 'node24' },
    });

    hook.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:DescribeThing'],
        resources: [this.iotArn('thing/*')],
      }),
    );

    hook.addPermission('InvokedByFleetProvisioning', {
      principal: new iam.ServicePrincipal('iot.amazonaws.com'),
      sourceAccount: this.account,
      sourceArn: this.iotArn(`provisioningtemplate/${TEMPLATE_NAME}`),
    });

    template.preProvisioningHook = {
      payloadVersion: '2020-04-01',
      targetArn: hook.functionArn,
    };
    // The function, its role and its permission must exist before the first
    // registration can reach them.
    template.node.addDependency(hook);

    new CfnOutput(this, 'RegistrationHookName', { value: hook.functionName });

    this.addApi(props);
  }

  /**
   * The group of every controller, which firmware updates are sent to, with
   * the policy for AWS IoT Jobs attached to it. AWS IoT applies a group's
   * policies to its members, because a controller connects with its Thing name
   * as client ID. The Jobs topics are a policy of their own: the device policy
   * is close to AWS IoT's limit of 2,048 characters.
   *
   * All of it is kept if the stack is deleted, like the rest of what
   * controllers depend on.
   */
  private addControllerGroup(): Construct {
    const group = new iot.CfnThingGroup(this, 'ControllerGroup', {
      thingGroupName: CONTROLLER_GROUP_NAME,
      thingGroupProperties: { thingGroupDescription: 'Every registered irrigation controller' },
    });
    group.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const policy = new iot.CfnPolicy(this, 'JobsPolicy', {
      policyName: JOBS_POLICY_NAME,
      policyDocument: { Version: '2012-10-17', Statement: this.jobsStatements() },
    });
    policy.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const groupArn = this.iotArn(`thinggroup/${CONTROLLER_GROUP_NAME}`);
    // CloudFormation can't attach a policy to a thing group. Attaching again
    // changes nothing, and nothing is detached, so the controllers keep it.
    const attachment = new AwsCustomResource(this, 'JobsPolicyAttachment', {
      onCreate: attachPolicy(JOBS_POLICY_NAME, groupArn),
      onUpdate: attachPolicy(JOBS_POLICY_NAME, groupArn),
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['iot:AttachPolicy'],
          resources: [groupArn, this.iotArn(`policy/${JOBS_POLICY_NAME}`)],
        }),
      ]),
      installLatestAwsSdk: false,
      logGroup: new logs.LogGroup(this, 'JobsPolicyAttachmentLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    attachment.node.addDependency(group, policy);

    new CfnOutput(this, 'ControllerGroupName', { value: CONTROLLER_GROUP_NAME });
    return group;
  }

  /** Who owns and manages which controller, and the API the app reads it with. */
  private addApi(props: ControllersStackProps): void {
    const table = new dynamodb.TableV2(this, 'AccessTable', {
      tableName: ACCESS_TABLE_NAME,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // Invitations and recorded connections remove themselves.
      timeToLiveAttribute: EXPIRY_ATTRIBUTE,
      globalSecondaryIndexes: [
        {
          indexName: USER_INDEX_NAME,
          partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
        },
      ],
      // Ownership must survive mistakes and outlive the stack.
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const handler = new NodejsFunction(this, 'ControllersApi', {
      entry: path.join(__dirname, '..', 'lambda', 'controllers', 'api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        USER_INDEX_NAME,
        IOT_DATA_ENDPOINT: props.iotDataEndpoint,
        USER_POOL_ID: props.userPool.userPoolId,
        GEO_TZ_DATA_PATH: `/var/task/${TIME_ZONE_MAP_FOLDER}`,
        BACKEND_VERSION: props.backendVersion ?? 'unknown',
      },
      logGroup: new logs.LogGroup(this, 'ControllersApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      // The SDK is bundled, because the Lambda runtime doesn't promise every
      // package this uses. CommonJS, because its dependencies use require().
      bundling: {
        minify: true,
        sourceMap: true,
        format: OutputFormat.CJS,
        target: 'node24',
        externalModules: [],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          // esbuild can't see this file: geo-tz opens it by path when it runs.
          afterBundling: (inputDir, outputDir) => [
            copyFileCommand(
              path.join(inputDir, 'node_modules', 'geo-tz', 'data', TIME_ZONE_MAP_FILE),
              path.join(outputDir, TIME_ZONE_MAP_FOLDER, TIME_ZONE_MAP_FILE),
            ),
          ],
        },
      },
    });

    table.grantReadWriteData(handler);

    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:GetRetainedMessage', 'iot:Publish', 'iot:RetainPublish'],
        resources: [this.iotArn('topic/esp32-irrigation/*/claim')],
      }),
    );

    // Closes the app connections of someone whose access ended.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:DeleteConnection'],
        resources: [this.iotArn('client/*')],
      }),
    );

    // The email of a new Manager, so the Owner can tell them apart, and
    // deleting the sign-in of a user who deletes their account.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminDeleteUser'],
        // From the ID, which the Auth stack already exports: a new export would
        // tie the order the two stacks deploy in.
        resources: [
          `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.userPool.userPoolId}`,
        ],
      }),
    );

    const api = new apigateway.HttpApi(this, 'Api', {
      apiName: 'irrigation-controllers',
      createDefaultStage: false,
      defaultAuthorizer: new HttpUserPoolAuthorizer('AppUsers', props.userPool, {
        userPoolClients: [props.appClient],
      }),
    });

    // The claim code is too long to guess, so this mostly limits the cost. An
    // invitation code of six digits could be guessed within its hour at this
    // rate; that risk is accepted (the app repo's docs/user-roles.md §6.1).
    const stage = new apigateway.HttpStage(this, 'ApiStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
    });

    const integration = new HttpLambdaIntegration('ControllersApiIntegration', handler);
    for (const [method, routePath] of [
      [apigateway.HttpMethod.GET, '/version'],
      [apigateway.HttpMethod.GET, '/controllers'],
      [apigateway.HttpMethod.POST, '/controllers/{deviceId}/claim'],
      [apigateway.HttpMethod.PUT, '/controllers/{deviceId}/name'],
      [apigateway.HttpMethod.PUT, '/controllers/{deviceId}/location'],
      [apigateway.HttpMethod.GET, '/controllers/{deviceId}/zones'],
      [apigateway.HttpMethod.POST, '/controllers/{deviceId}/zones'],
      [apigateway.HttpMethod.PUT, '/controllers/{deviceId}/zones/{zoneId}'],
      [apigateway.HttpMethod.DELETE, '/controllers/{deviceId}/zones/{zoneId}'],
      [apigateway.HttpMethod.POST, '/controllers/{deviceId}/invitations'],
      [apigateway.HttpMethod.GET, '/controllers/{deviceId}/invitations'],
      [apigateway.HttpMethod.DELETE, '/controllers/{deviceId}/invitations/{invitationId}'],
      [apigateway.HttpMethod.POST, '/invitations/preview'],
      [apigateway.HttpMethod.POST, '/invitations/accept'],
      [apigateway.HttpMethod.GET, '/controllers/{deviceId}/people'],
      [apigateway.HttpMethod.DELETE, '/controllers/{deviceId}/people/{userId}'],
      [apigateway.HttpMethod.DELETE, '/controllers/{deviceId}/access'],
      [apigateway.HttpMethod.POST, '/controllers/{deviceId}/transfer'],
      [apigateway.HttpMethod.DELETE, '/controllers/{deviceId}'],
      [apigateway.HttpMethod.DELETE, '/account'],
    ] as const) {
      api.addRoutes({ path: routePath, methods: [method], integration });
    }

    new CfnOutput(this, 'ApiUrl', { value: stage.url });
    new CfnOutput(this, 'ControllersApiName', { value: handler.functionName });

    this.addAuthorizer(props, table);
  }

  /** Decides what each app connection may do in AWS IoT, from the user's roles. */
  private addAuthorizer(props: ControllersStackProps, table: dynamodb.TableV2): void {
    const handler = new NodejsFunction(this, 'IotAuthorizer', {
      entry: path.join(__dirname, '..', 'lambda', 'controllers', 'iot-authorizer.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // AWS IoT waits 5 seconds, also on the first call after a quiet time.
      memorySize: 512,
      timeout: Duration.seconds(5),
      // Anyone can make AWS IoT call it (token signing is off). The cap keeps a
      // flood of connection attempts from using up what sign-in and the API
      // need, and also keeps this much for the authorizer itself.
      reservedConcurrentExecutions: AUTHORIZER_CONCURRENCY,
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        APP_CLIENT_ID: props.appClient.userPoolClientId,
        TABLE_NAME: table.tableName,
        USER_INDEX_NAME,
        IOT_ARN_PREFIX: this.iotArn(''),
      },
      logGroup: new logs.LogGroup(this, 'IotAuthorizerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      // As for the API, and esbuild turns jose into CommonJS as well.
      bundling: {
        minify: true,
        sourceMap: true,
        format: OutputFormat.CJS,
        target: 'node24',
        externalModules: [],
      },
    });

    table.grantReadData(handler);

    // Records each connection so it can be closed, and may write nothing else.
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONNECTIONS#*'] },
        },
      }),
    );

    handler.addPermission('InvokedByIot', {
      principal: new iam.ServicePrincipal('iot.amazonaws.com'),
      sourceAccount: this.account,
      sourceArn: this.iotArn(`authorizer/${AUTHORIZER_NAME}`),
    });

    const authorizer = new iot.CfnAuthorizer(this, 'AppAuthorizer', {
      authorizerName: AUTHORIZER_NAME,
      authorizerFunctionArn: handler.functionArn,
      // An app can't keep a signing key secret. See iot-authorizer.ts.
      signingDisabled: true,
      status: 'ACTIVE',
    });
    authorizer.node.addDependency(handler);

    new CfnOutput(this, 'IotAuthorizerName', { value: AUTHORIZER_NAME });
    new CfnOutput(this, 'IotAuthorizerFunction', { value: handler.functionName });
  }

  /** Each controller may connect as itself and reach only its own topics. */
  private devicePolicy(): object {
    const topic = (name: string) => this.iotArn(`topic/esp32-irrigation/${THING}/${name}`);
    const filter = (name: string) => this.iotArn(`topicfilter/esp32-irrigation/${THING}/${name}`);
    const inbound = ['config', 'command', 'schedule'];

    return {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'iot:Connect',
          Resource: this.iotArn(`client/${THING}`),
          Condition: {
            Bool: { 'iot:Connection.Thing.IsAttached': 'true' },
            // The controller registers a Last Will; AWS IoT checks it here.
            'ForAllValues:StringEquals': { 'iot:ConnectAttributes': ['LastWill'] },
          },
        },
        {
          Effect: 'Allow',
          Action: ['iot:Publish', 'iot:RetainPublish'],
          Resource: ['status', 'availability', 'schedule_index', 'schedules/*', 'claim'].map(topic),
        },
        {
          Effect: 'Allow',
          Action: 'iot:Publish',
          Resource: ['ack', 'telemetry'].map(topic),
        },
        { Effect: 'Allow', Action: 'iot:Subscribe', Resource: inbound.map(filter) },
        { Effect: 'Allow', Action: 'iot:Receive', Resource: inbound.map(topic) },
      ],
    };
  }

  /**
   * Firmware updates through AWS IoT Jobs: the controller hears of its next
   * job, asks for it, and reports how it went. Only its own Thing's jobs.
   */
  private jobsStatements(): object[] {
    const jobs = (type: string, name: string) =>
      this.iotArn(`${type}/$aws/things/${THING}/jobs/${name}`);
    const replies = ['notify-next', '$next/get/accepted', '$next/get/rejected'];
    // `+` in a subscription is the job ID; `*` matches it in the policy.
    const updateReplies = ['*/update/accepted', '*/update/rejected'];

    return [
      {
        Effect: 'Allow',
        Action: 'iot:Publish',
        Resource: ['$next/get', '*/update'].map((name) => jobs('topic', name)),
      },
      {
        Effect: 'Allow',
        Action: 'iot:Subscribe',
        Resource: [...replies, ...updateReplies].map((name) => jobs('topicfilter', name)),
      },
      {
        Effect: 'Allow',
        Action: 'iot:Receive',
        Resource: [...replies, ...updateReplies].map((name) => jobs('topic', name)),
      },
    ];
  }

  /** The certificate in every firmware image may do nothing but register. */
  private claimPolicy(clientResource: string): object {
    const provisioning = (type: string) => [
      this.iotArn(`${type}/$aws/certificates/create/*`),
      this.iotArn(`${type}/$aws/provisioning-templates/${TEMPLATE_NAME}/provision/*`),
    ];

    return {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 'iot:Connect', Resource: this.iotArn(clientResource) },
        { Effect: 'Allow', Action: ['iot:Publish', 'iot:Receive'], Resource: provisioning('topic') },
        { Effect: 'Allow', Action: 'iot:Subscribe', Resource: provisioning('topicfilter') },
      ],
    };
  }

  private iotArn(resource: string): string {
    return `arn:aws:iot:${this.region}:${this.account}:${resource}`;
  }
}

/** The SDK call that attaches [policyName] to the thing group [groupArn]. */
function attachPolicy(policyName: string, groupArn: string): AwsSdkCall {
  return {
    service: '@aws-sdk/client-iot',
    action: 'AttachPolicy',
    parameters: { policyName, target: groupArn },
    physicalResourceId: PhysicalResourceId.of(`${policyName}@${CONTROLLER_GROUP_NAME}`),
  };
}

/** In Node, because the bundling runs on Windows and on Linux. */
function copyFileCommand(source: string, target: string): string {
  const script = [
    `const fs=require('fs'),path=require('path');`,
    `fs.mkdirSync(path.dirname(process.argv[2]),{recursive:true});`,
    `fs.copyFileSync(process.argv[1],process.argv[2]);`,
  ].join('');
  return `node -e "${script}" "${source}" "${target}"`;
}

/**
 * Creates the certificate and the Thing, named by the controller's device ID,
 * in [thingGroups].
 */
function registrationTemplate(thingGroups: string[]): object {
  return {
    Parameters: {
      SerialNumber: { Type: 'String' },
      'AWS::IoT::Certificate::Id': { Type: 'String' },
    },
    Resources: {
      policy_ESP32IrrigationDevicePolicy: {
        Type: 'AWS::IoT::Policy',
        Properties: { PolicyName: DEVICE_POLICY_NAME },
      },
      certificate: {
        Type: 'AWS::IoT::Certificate',
        Properties: {
          CertificateId: { Ref: 'AWS::IoT::Certificate::Id' },
          Status: 'Active',
        },
      },
      thing: {
        Type: 'AWS::IoT::Thing',
        OverrideSettings: {
          AttributePayload: 'MERGE',
          ThingGroups: 'DO_NOTHING',
          ThingTypeName: 'REPLACE',
        },
        Properties: {
          AttributePayload: {},
          ThingGroups: thingGroups,
          ThingName: { 'Fn::Join': ['', ['', { Ref: 'SerialNumber' }]] },
        },
      },
    },
  };
}

/**
 * Keeps the name the import maps to, and keeps the resource if the stack is
 * ever deleted: controllers in the field depend on it.
 */
function adopted<T extends CfnResource>(resource: T): T {
  resource.overrideLogicalId(resource.node.id);
  resource.applyRemovalPolicy(RemovalPolicy.RETAIN);
  return resource;
}
