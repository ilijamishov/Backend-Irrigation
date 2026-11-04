import { randomUUID } from 'node:crypto';

import {
  type AccessStore,
  type ControllerZone,
  ZoneConflictError,
} from './access-store';

const ATTEMPTS = 3;

/** What the Owner gives for a zone. A new zone may leave out its name. */
export interface ZoneInput {
  readonly name: string | null;
  readonly description: string | null;
  readonly relay: number;
  readonly enabled: boolean;
}

export type ZoneList =
  | { readonly result: 'ok'; readonly zones: ControllerZone[] }
  | { readonly result: 'no_access' };

export type ZoneChange =
  | { readonly result: 'ok'; readonly zone: ControllerZone }
  | { readonly result: 'not_owner' | 'zone_not_found' | 'relay_in_use' };

export type ZoneRemoval = {
  readonly result: 'ok' | 'not_owner' | 'zone_not_found';
};

/**
 * A controller's zones: named areas of the yard, each connected to one relay.
 * Everyone with access may read them, and only the Owner may change them.
 * The controller only ever gets the relays of the enabled zones, from the app.
 */
export class ZoneService {
  constructor(
    private readonly store: AccessStore,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  async list(userId: string, deviceId: string): Promise<ZoneList> {
    const role = await this.store.roleOf(deviceId, userId);
    if (!role) return { result: 'no_access' };

    return { result: 'ok', zones: await this.store.zonesOf(deviceId) };
  }

  add(userId: string, deviceId: string, input: ZoneInput): Promise<ZoneChange> {
    const zoneId = this.newId();
    const createdAt = new Date(this.now()).toISOString();

    return this.change(userId, deviceId, null, (zones) => ({
      zoneId,
      createdAt,
      name: input.name ?? defaultZoneName(zones),
      relay: input.relay,
      enabled: input.enabled,
      ...(input.description ? { description: input.description } : {}),
    }));
  }

  update(
    userId: string,
    deviceId: string,
    zoneId: string,
    input: ZoneInput,
  ): Promise<ZoneChange> {
    return this.change(userId, deviceId, zoneId, (zones) => {
      const current = zones.find((zone) => zone.zoneId === zoneId) as ControllerZone;

      return {
        zoneId,
        createdAt: current.createdAt,
        name: input.name ?? current.name,
        relay: input.relay,
        enabled: input.enabled,
        ...(input.description ? { description: input.description } : {}),
      };
    });
  }

  remove(userId: string, deviceId: string, zoneId: string): Promise<ZoneRemoval> {
    return this.retryingConflicts(async () => {
      const controller = await this.store.find(deviceId);
      if (controller?.ownerId !== userId) return { result: 'not_owner' };

      const zones = await this.store.zonesOf(deviceId);
      if (!zones.some((zone) => zone.zoneId === zoneId)) return { result: 'zone_not_found' };

      await this.store.deleteZone(deviceId, userId, zoneId, controller.zonesVersion ?? 0);
      return { result: 'ok' };
    });
  }

  private change(
    userId: string,
    deviceId: string,
    zoneId: string | null,
    build: (zones: ControllerZone[]) => ControllerZone,
  ): Promise<ZoneChange> {
    return this.retryingConflicts(async () => {
      const controller = await this.store.find(deviceId);
      if (controller?.ownerId !== userId) return { result: 'not_owner' };

      const zones = await this.store.zonesOf(deviceId);
      if (zoneId && !zones.some((zone) => zone.zoneId === zoneId)) {
        return { result: 'zone_not_found' };
      }

      const zone = build(zones);

      // A disabled zone keeps its relay reserved, until it is moved or deleted.
      if (zones.some((other) => other.relay === zone.relay && other.zoneId !== zone.zoneId)) {
        return { result: 'relay_in_use' };
      }

      await this.store.saveZone(deviceId, userId, zone, controller.zonesVersion ?? 0);
      return { result: 'ok', zone };
    });
  }

  /** Two saves can race for a relay: the loser decides again on what it reads then. */
  private async retryingConflicts<T>(decide: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await decide();
      } catch (error) {
        if (!(error instanceof ZoneConflictError) || attempt >= ATTEMPTS) throw error;
      }
    }
  }
}

/** The lowest "Zone N" that no zone is called yet. */
export function defaultZoneName(zones: readonly ControllerZone[]): string {
  const names = new Set(zones.map((zone) => zone.name));

  let number = 1;
  while (names.has(`Zone ${number}`)) number++;

  return `Zone ${number}`;
}
