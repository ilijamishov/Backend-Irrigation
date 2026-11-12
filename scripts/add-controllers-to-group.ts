/**
 * Adds every controller registered so far to the thing group that firmware
 * updates go to. Run once after deploying `Irrigation-Controllers` with the
 * group (docs/DEPLOYMENT.md):
 *
 *   $env:AWS_PROFILE = 'irrigation'
 *   npx.cmd ts-node scripts/add-controllers-to-group.ts
 */
import { IoTClient } from '@aws-sdk/client-iot';

import { CONTROLLER_GROUP_NAME } from '../lib/controllers-stack';
import { ControllerGroupEnrolment, IotThingDirectory } from './controller-group';

async function main(): Promise<void> {
  const client = new IoTClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const enrolled = await new ControllerGroupEnrolment(
    new IotThingDirectory(client),
    CONTROLLER_GROUP_NAME,
  ).enrolAll();

  console.log(`${enrolled.length} controller(s) in ${CONTROLLER_GROUP_NAME}: ${enrolled.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
