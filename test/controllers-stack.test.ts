import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import {
  CLAIM_POLICY_NAME,
  ControllersStack,
  DEVICE_POLICY_NAME,
  TEMPLATE_NAME,
} from '../lib/controllers-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const provisioningRoleArn = 'arn:aws:iam::123456789012:role/service-role/Provisioning';
const iot = 'arn:aws:iot:us-east-1:123456789012';
const thing = '${iot:Connection.Thing.ThingName}';

function synth(importPhase: boolean): Template {
  return Template.fromStack(
    new ControllersStack(new App(), 'Controllers', { env, provisioningRoleArn, importPhase }),
  );
}

function policyNamed(template: Template, name: string) {
  const [resource] = Object.values(
    template.findResources('AWS::IoT::Policy', { Properties: { PolicyName: name } }),
  );
  return resource.Properties.PolicyDocument;
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
    const [resource] = Object.values(template.findResources('AWS::IoT::ProvisioningTemplate'));
    const body = JSON.parse(resource.Properties.TemplateBody);

    expect(body.Resources.thing.Properties.ThingName).toEqual({
      'Fn::Join': ['', ['', { Ref: 'SerialNumber' }]],
    });
    expect(body.Resources.policy_ESP32IrrigationDevicePolicy.Properties.PolicyName).toBe(
      DEVICE_POLICY_NAME,
    );
  });

  describe('import phase', () => {
    let imported: Template;

    beforeAll(() => {
      imported = synth(true);
    });

    it('has only what can be imported, with nothing left dangling', () => {
      imported.resourceCountIs('AWS::Lambda::Function', 0);
      imported.resourceCountIs('AWS::Lambda::Permission', 0);

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

    it('maps every imported resource in the import file', () => {
      const mapping = JSON.parse(
        readFileSync(path.join(__dirname, '..', 'controllers-import.json'), 'utf8'),
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
