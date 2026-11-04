import * as path from 'node:path';

import { CfnOutput, CfnResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export const DEVICE_POLICY_NAME = 'ESP32IrrigationDevicePolicy';
export const CLAIM_POLICY_NAME = 'ESP32IrrigationClaimProvisioningPolicy';
export const TEMPLATE_NAME = 'ESP32IrrigationFleetProvisioning';

/** The controller's own Thing name, which AWS IoT fills in on each request. */
const THING = '${iot:Connection.Thing.ThingName}';

export interface ControllersStackProps extends StackProps {
  /** The existing role that lets AWS IoT register controllers. */
  readonly provisioningRoleArn: string;
  /**
   * Describes the AWS IoT resources exactly as they were before this stack
   * adopted them, for `cdk import`. CloudFormation compares a deploy with its
   * last template, not with AWS, so importing anything else would mean the
   * following deploy never applies the difference.
   */
  readonly importPhase?: boolean;
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
        templateBody: JSON.stringify(registrationTemplate()),
      }),
    );

    if (importPhase) return;

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

/** Creates the certificate and the Thing, named by the controller's device ID. */
function registrationTemplate(): object {
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
          ThingGroups: [],
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
