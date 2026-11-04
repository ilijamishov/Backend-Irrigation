import { IoTClient } from '@aws-sdk/client-iot';

import { IotThingRegistry, type ThingRegistry } from './thing-registry';

/** What AWS IoT sends before Fleet Provisioning registers a controller. */
export interface RegistrationRequest {
  readonly parameters?: { readonly SerialNumber?: unknown };
}

export interface RegistrationDecision {
  readonly allowProvisioning: boolean;
}

/** 12 upper-case hex characters, from the MQTT contract. */
const DEVICE_ID = /^[0-9A-F]{12}$/;

/**
 * Runs before a controller registers. The claim certificate is in every
 * firmware image, so whoever extracts it can send any device ID. Registering
 * an existing one would give them a valid certificate for that controller, so
 * a device ID that already has a Thing is refused. Any failure also refuses.
 */
export function createRegistrationHookHandler(registry: ThingRegistry) {
  return async (event: RegistrationRequest): Promise<RegistrationDecision> => {
    const deviceId = event.parameters?.SerialNumber;

    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
      console.warn('Registration refused: not a device ID.');
      return { allowProvisioning: false };
    }

    try {
      if (await registry.exists(deviceId)) {
        console.warn(`Registration refused: ${deviceId} already has a Thing.`);
        return { allowProvisioning: false };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      console.error(`Registration refused: could not check ${deviceId} (${reason}).`);
      return { allowProvisioning: false };
    }

    console.log(`Registration allowed: ${deviceId}.`);
    return { allowProvisioning: true };
  };
}

// Created on the first call, so importing this module needs no configuration.
let configured: ReturnType<typeof createRegistrationHookHandler> | undefined;

export const handler: ReturnType<typeof createRegistrationHookHandler> = (event) => {
  // AWS IoT gives the hook 5 seconds, so one retry is all there is time for.
  configured ??= createRegistrationHookHandler(
    new IotThingRegistry(new IoTClient({ maxAttempts: 2 })),
  );
  return configured(event);
};
