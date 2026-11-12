import * as fs from 'node:fs';
import * as path from 'node:path';

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { AuthStack } from '../lib/auth-stack';
import {
  ACCESS_TABLE_NAME,
  AUTHORIZER_NAME,
  CLAIM_POLICY_NAME,
  CONTROLLER_GROUP_NAME,
  ControllersStack,
  DEVICE_POLICY_NAME,
  JOBS_POLICY_NAME,
  TEMPLATE_NAME,
} from '../lib/controllers-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const provisioningRoleArn = 'arn:aws:iam::123456789012:role/service-role/Provisioning';
const iot = 'arn:aws:iot:us-east-1:123456789012';
const thing = '${iot:Connection.Thing.ThingName}';

let lastAssembly: string;

function synth(importPhase: boolean): Template {
  const app = new App();
  const auth = new AuthStack(app, 'Auth', {
    env,
    googleClientIds: ['web-client.apps.googleusercontent.com'],
  });
  const template = Template.fromStack(
    new ControllersStack(app, 'Controllers', {
      env,
      provisioningRoleArn,
      importPhase,
      iotDataEndpoint: 'example-ats.iot.us-east-1.amazonaws.com',
      userPool: auth.userPool,
      appClient: auth.appClient,
    }),
  );
  if (!importPhase) lastAssembly = app.synth().directory;
  return template;
}

function policyNamed(template: Template, name: string) {
  const [resource] = Object.values(
    template.findResources('AWS::IoT::Policy', { Properties: { PolicyName: name } }),
  );
  return resource.Properties.PolicyDocument;
}

/** AWS IoT refuses a policy longer than this, not counting whitespace. */
const POLICY_SIZE_LIMIT = 2048;

function registrationTemplate(template: Template) {
  const [resource] = Object.values(template.findResources('AWS::IoT::ProvisioningTemplate'));
  return JSON.parse(resource.Properties.TemplateBody);
}

describe('ControllersStack', () => {
  // Synthesizing bundles the Lambda with esbuild, which takes a while.
  jest.setTimeout(120_000);

  let template: Template;

  beforeAll(() => {
    template = synth(false);
  });

  it('keeps the resources controllers depend on if the stack is deleted', () => {
    for (const type of ['AWS::IoT::Policy', 'AWS::IoT::ProvisioningTemplate']) {
      for (const resource of Object.values(template.findResources(type))) {
        expect(resource.DeletionPolicy).toBe('Retain');
        expect(resource.UpdateReplacePolicy).toBe('Retain');
      }
    }
  });

  it('lets the claim certificate connect only under its own client IDs', () => {
    const statements = policyNamed(template, CLAIM_POLICY_NAME).Statement;

    expect(statements[0]).toEqual({
      Effect: 'Allow',
      Action: 'iot:Connect',
      Resource: `${iot}:client/prov-*`,
    });
  });

  it('lets the claim certificate do nothing but register', () => {
    const resources = policyNamed(template, CLAIM_POLICY_NAME).Statement.slice(1).flatMap(
      (statement: { Resource: string[] }) => statement.Resource,
    );

    expect(resources).toHaveLength(4);
    for (const resource of resources) {
      expect(resource).toMatch(/\/\$aws\/(certificates\/create|provisioning-templates)\//);
    }
    expect(JSON.stringify(policyNamed(template, CLAIM_POLICY_NAME))).not.toContain('esp32-irrigation');
  });

  it('lets a controller connect only as itself, with its certificate and Last Will', () => {
    const [connect] = policyNamed(template, DEVICE_POLICY_NAME).Statement;

    expect(connect.Resource).toBe(`${iot}:client/${thing}`);
    expect(connect.Condition.Bool['iot:Connection.Thing.IsAttached']).toBe('true');
    expect(connect.Condition['ForAllValues:StringEquals']['iot:ConnectAttributes']).toEqual([
      'LastWill',
    ]);
  });

  it('lets a controller reach only its own topics', () => {
    const statements = policyNamed(template, DEVICE_POLICY_NAME).Statement.slice(1);

    for (const { Resource } of statements) {
      for (const resource of Resource as string[]) {
        expect(resource).toContain(`/esp32-irrigation/${thing}/`);
      }
    }
  });

  it('keeps every policy within the size AWS IoT accepts', () => {
    const policies = Object.values(template.findResources('AWS::IoT::Policy'));

    expect(policies.length).toBeGreaterThanOrEqual(3);
    for (const policy of policies) {
      const size = JSON.stringify(policy.Properties.PolicyDocument).replace(/\s/g, '').length;
      expect(size).toBeLessThanOrEqual(POLICY_SIZE_LIMIT);
    }
  });

  it('follows the MQTT contract: what a controller retains, sends and receives', () => {
    const [retained, sent, subscribed, received] = policyNamed(
      template,
      DEVICE_POLICY_NAME,
    ).Statement.slice(1);
    const topicNames = (statement: { Resource: string[] }) =>
      statement.Resource.map((resource) => resource.split(`/${thing}/`)[1]);

    expect(retained.Action).toEqual(['iot:Publish', 'iot:RetainPublish']);
    expect(topicNames(retained)).toEqual([
      'status',
      'availability',
      'schedule_index',
      'schedules/*',
      'claim',
    ]);
    expect(topicNames(sent)).toEqual(['ack', 'telemetry']);
    expect(topicNames(subscribed)).toEqual(['config', 'command', 'schedule']);
    expect(topicNames(received)).toEqual(['config', 'command', 'schedule']);
  });

  it('lets a controller get its own next job and report on it, and nothing else', () => {
    const statements = policyNamed(template, JOBS_POLICY_NAME).Statement;
    const [published, subscribed, received] = statements;
    const jobs = (type: string, names: string[]) =>
      names.map((name) => `${iot}:${type}/$aws/things/${thing}/jobs/${name}`);
    const replies = [
      'notify-next',
      '$next/get/accepted',
      '$next/get/rejected',
      '*/update/accepted',
      '*/update/rejected',
    ];

    expect(published).toEqual({
      Effect: 'Allow',
      Action: 'iot:Publish',
      Resource: jobs('topic', ['$next/get', '*/update']),
    });
    expect(subscribed).toEqual({
      Effect: 'Allow',
      Action: 'iot:Subscribe',
      Resource: jobs('topicfilter', replies),
    });
    expect(received).toEqual({
      Effect: 'Allow',
      Action: 'iot:Receive',
      Resource: jobs('topic', replies),
    });
    expect(statements).toHaveLength(3);
  });

  describe('the controller group', () => {
    it('exists, and is kept if the stack is deleted', () => {
      template.hasResource('AWS::IoT::ThingGroup', {
        Properties: { ThingGroupName: CONTROLLER_GROUP_NAME },
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });

    it('gets every controller that registers', () => {
      expect(registrationTemplate(template).Resources.thing.Properties.ThingGroups).toEqual([
        CONTROLLER_GROUP_NAME,
      ]);
    });

    it('is created before the template can add a controller to it', () => {
      const [groupId] = Object.keys(template.findResources('AWS::IoT::ThingGroup'));
      const [resource] = Object.values(template.findResources('AWS::IoT::ProvisioningTemplate'));

      expect(resource.DependsOn).toContain(groupId);
    });

    it('has the Jobs policy attached, so every controller in it gets it', () => {
      const [attachment] = Object.values(template.findResources('Custom::AWS'));
      const create = JSON.parse(attachment.Properties.Create);

      expect(create).toMatchObject({
        service: '@aws-sdk/client-iot',
        action: 'AttachPolicy',
        parameters: {
          policyName: JOBS_POLICY_NAME,
          target: `${iot}:thinggroup/${CONTROLLER_GROUP_NAME}`,
        },
      });
      expect(attachment.Properties.Update).toBe(attachment.Properties.Create);
      // Deleting the stack keeps the group and its policy, so nothing detaches.
      expect(attachment.Properties.Delete).toBeUndefined();
    });

    it('attaches only after the group and the policy exist', () => {
      const [groupId] = Object.keys(template.findResources('AWS::IoT::ThingGroup'));
      const [policyId] = Object.keys(
        template.findResources('AWS::IoT::Policy', {
          Properties: { PolicyName: JOBS_POLICY_NAME },
        }),
      );
      const [attachment] = Object.values(template.findResources('Custom::AWS'));

      expect(attachment.DependsOn).toEqual(expect.arrayContaining([groupId, policyId]));
    });

    it('may only attach policies to the group, for the attachment', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'iot:AttachPolicy',
              Effect: 'Allow',
              Resource: [
                `${iot}:thinggroup/${CONTROLLER_GROUP_NAME}`,
                `${iot}:policy/${JOBS_POLICY_NAME}`,
              ],
            },
          ],
        },
      });
    });
  });

  it('runs the hook before a controller registers', () => {
    template.hasResourceProperties('AWS::IoT::ProvisioningTemplate', {
      TemplateName: TEMPLATE_NAME,
      TemplateType: 'FLEET_PROVISIONING',
      Enabled: true,
      ProvisioningRoleArn: provisioningRoleArn,
      PreProvisioningHook: {
        PayloadVersion: '2020-04-01',
        TargetArn: Match.anyValue(),
      },
    });
  });

  it('lets only this template call the hook', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'iot.amazonaws.com',
      SourceAccount: '123456789012',
      SourceArn: `${iot}:provisioningtemplate/${TEMPLATE_NAME}`,
    });
  });

  it('lets the hook only look up Things', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          { Action: 'iot:DescribeThing', Effect: 'Allow', Resource: `${iot}:thing/*` },
        ],
      },
    });
  });

  it('gives the hook no longer than AWS IoT waits for it', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Timeout: 5,
    });
  });

  it('registers controllers under their device ID with the device policy', () => {
    const body = registrationTemplate(template);

    expect(body.Resources.thing.Properties.ThingName).toEqual({
      'Fn::Join': ['', ['', { Ref: 'SerialNumber' }]],
    });
    expect(body.Resources.policy_ESP32IrrigationDevicePolicy.Properties.PolicyName).toBe(
      DEVICE_POLICY_NAME,
    );
  });

  describe('the access table', () => {
    it('keeps ownership when the stack is deleted, and guards against mistakes', () => {
      template.hasResource('AWS::DynamoDB::GlobalTable', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
      template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        TableName: ACCESS_TABLE_NAME,
        BillingMode: 'PAY_PER_REQUEST',
        Replicas: [
          Match.objectLike({
            DeletionProtectionEnabled: true,
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          }),
        ],
      });
    });

    it('removes expired invitations and connections by itself', () => {
      template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        TimeToLiveSpecification: { AttributeName: 'expiresAtSeconds', Enabled: true },
      });
    });

    it('can list the controllers of a user', () => {
      template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: 'byUser',
            KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
          }),
        ],
      });
    });
  });

  describe('the API', () => {
    it.each([
      'GET /controllers',
      'POST /controllers/{deviceId}/claim',
      'PUT /controllers/{deviceId}/name',
      'PUT /controllers/{deviceId}/location',
      'GET /controllers/{deviceId}/zones',
      'POST /controllers/{deviceId}/zones',
      'PUT /controllers/{deviceId}/zones/{zoneId}',
      'DELETE /controllers/{deviceId}/zones/{zoneId}',
      'POST /controllers/{deviceId}/invitations',
      'GET /controllers/{deviceId}/invitations',
      'DELETE /controllers/{deviceId}/invitations/{invitationId}',
      'POST /invitations/preview',
      'POST /invitations/accept',
      'GET /controllers/{deviceId}/people',
      'DELETE /controllers/{deviceId}/people/{userId}',
      'DELETE /controllers/{deviceId}/access',
      'POST /controllers/{deviceId}/transfer',
      'DELETE /controllers/{deviceId}',
      'DELETE /account',
    ])('needs a token from the app for %s', (routeKey) => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        AuthorizationType: 'JWT',
        AuthorizerId: Match.anyValue(),
      });
    });

    it('has no other routes', () => {
      template.resourceCountIs('AWS::ApiGatewayV2::Route', 19);
    });

    it('packs the time zone map where the Lambda looks for it', () => {
      const [{ Properties: api }] = Object.values(
        template.findResources('AWS::Lambda::Function', {
          Properties: { Environment: { Variables: { GEO_TZ_DATA_PATH: Match.anyValue() } } },
        }),
      );
      const folder = api.Environment.Variables.GEO_TZ_DATA_PATH.replace('/var/task/', '');

      const packed = fs
        .readdirSync(lastAssembly, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(lastAssembly, entry.name, folder, 'timezones.geojson.geo.dat'))
        .filter((file) => fs.existsSync(file));

      expect(packed).toHaveLength(1);
      expect(fs.statSync(packed[0]).size).toBeGreaterThan(1_000_000);
    });

    it('accepts only tokens from the app client of the user pool', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        AuthorizerType: 'JWT',
        JwtConfiguration: { Audience: [Match.anyValue()], Issuer: Match.anyValue() },
      });
    });

    it('is throttled', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        StageName: '$default',
        AutoDeploy: true,
        DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      });
    });

    it('may touch only the claim topics in AWS IoT', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: ['iot:GetRetainedMessage', 'iot:Publish', 'iot:RetainPublish'],
              Effect: 'Allow',
              Resource: `${iot}:topic/esp32-irrigation/*/claim`,
            },
          ]),
        },
      });
    });

    it('may close app connections, and nothing else of a client', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: 'iot:DeleteConnection',
              Effect: 'Allow',
              Resource: `${iot}:client/*`,
            },
          ]),
        },
      });
    });

    it('may read and delete a user of the user pool, and nothing else there', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminDeleteUser'],
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    it('is told where the data lives', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            TABLE_NAME: Match.anyValue(),
            USER_INDEX_NAME: 'byUser',
            IOT_DATA_ENDPOINT: 'example-ats.iot.us-east-1.amazonaws.com',
            USER_POOL_ID: Match.anyValue(),
          }),
        },
      });
    });
  });

  describe('the app authorizer', () => {
    it('is active, without token signing', () => {
      template.hasResourceProperties('AWS::IoT::Authorizer', {
        AuthorizerName: AUTHORIZER_NAME,
        SigningDisabled: true,
        Status: 'ACTIVE',
      });
    });

    it('can be called only by this authorizer', () => {
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Principal: 'iot.amazonaws.com',
        SourceArn: `${iot}:authorizer/${AUTHORIZER_NAME}`,
        SourceAccount: '123456789012',
      });
    });

    it('answers within what AWS IoT waits, and knows the app client', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 5,
        MemorySize: 512,
        Environment: {
          Variables: Match.objectLike({
            USER_POOL_ID: Match.anyValue(),
            APP_CLIENT_ID: Match.anyValue(),
            IOT_ARN_PREFIX: `${iot}:`,
          }),
        },
      });
    });

    it('may only read the access table, and record its connections', () => {
      const policies = template.findResources('AWS::IAM::Policy');
      const authorizer = Object.entries(policies).find(([id]) => id.startsWith('IotAuthorizer'));
      const statements = authorizer?.[1].Properties.PolicyDocument.Statement as {
        Action: string | string[];
        Condition?: unknown;
      }[];

      const actions = JSON.stringify(statements);
      expect(actions).toContain('dynamodb:Query');
      expect(actions).not.toMatch(/dynamodb:(Update|Delete|BatchWrite)/);
      expect(actions).not.toContain('iot:');

      const writes = statements.filter((statement) => JSON.stringify(statement).includes('Put'));
      expect(writes).toEqual([
        expect.objectContaining({
          Action: 'dynamodb:PutItem',
          Condition: {
            'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONNECTIONS#*'] },
          },
        }),
      ]);
    });
  });

  describe('import phase', () => {
    let imported: Template;

    beforeAll(() => {
      imported = synth(true);
    });

    it('has only what can be imported, with nothing left dangling', () => {
      imported.resourceCountIs('AWS::Lambda::Function', 0);
      imported.resourceCountIs('AWS::Lambda::Permission', 0);
      imported.resourceCountIs('AWS::DynamoDB::GlobalTable', 0);
      imported.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
      imported.resourceCountIs('AWS::IoT::Authorizer', 0);
      imported.resourceCountIs('AWS::IoT::ThingGroup', 0);
      imported.resourceCountIs('Custom::AWS', 0);
      expect(
        Object.keys(
          imported.findResources('AWS::IoT::Policy', {
            Properties: { PolicyName: JOBS_POLICY_NAME },
          }),
        ),
      ).toHaveLength(0);

      const [resource] = Object.values(imported.findResources('AWS::IoT::ProvisioningTemplate'));
      expect(resource.Properties.PreProvisioningHook).toBeUndefined();
    });

    it('describes the claim policy as it is, so the next deploy applies the change', () => {
      const before = policyNamed(imported, CLAIM_POLICY_NAME);
      const after = policyNamed(template, CLAIM_POLICY_NAME);

      expect(before.Statement[0].Resource).toBe(`${iot}:client/*`);
      expect(before.Statement.slice(1)).toEqual(after.Statement.slice(1));
    });

    it('leaves the device policy unchanged, so deploying needs no new policy version', () => {
      expect(policyNamed(imported, DEVICE_POLICY_NAME)).toEqual(
        policyNamed(template, DEVICE_POLICY_NAME),
      );
    });

    it('describes the template as it was, adding controllers to no group', () => {
      const before = registrationTemplate(imported);
      const after = registrationTemplate(template);

      expect(before.Resources.thing.Properties.ThingGroups).toEqual([]);
      expect({ ...before.Resources.thing.Properties, ThingGroups: undefined }).toEqual({
        ...after.Resources.thing.Properties,
        ThingGroups: undefined,
      });
    });

    it('maps every imported resource in the import file', () => {
      const mapping = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'controllers-import.json'), 'utf8'),
      );
      const resources = imported.toJSON().Resources as Record<string, { Type: string }>;
      const adopted = Object.entries(resources)
        .filter(([, resource]) => resource.Type.startsWith('AWS::IoT::'))
        .map(([logicalId]) => logicalId);

      expect(Object.keys(mapping).sort()).toEqual(adopted.sort());
      expect(mapping.DevicePolicy.Id).toBe(DEVICE_POLICY_NAME);
      expect(mapping.ClaimPolicy.Id).toBe(CLAIM_POLICY_NAME);
      expect(mapping.FleetProvisioningTemplate.TemplateName).toBe(TEMPLATE_NAME);
    });
  });
});
