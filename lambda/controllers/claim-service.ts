import { createHash } from 'node:crypto';

import { type AccessStore, ClaimConflictError, type ControllerRecord } from './access-store';
import type { ClaimReportSource } from './claim-report';

/** How long a controller's report can be claimed, from when it reached the broker. */
export const CLAIM_REPORT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const ATTEMPTS = 2;

export type ClaimOutcome =
  | { readonly result: 'pending' }
  | { readonly result: 'expired' }
  | { readonly result: 'already_owned' }
  | { readonly result: 'claimed' | 'already_owner'; readonly controller: ControllerRecord };

/** Decides a claim, by the rules in the app repo's docs/claiming.md §4. */
export class ClaimService {
  constructor(
    private readonly store: AccessStore,
    private readonly reports: ClaimReportSource,
    private readonly now: () => number = Date.now,
  ) {}

  async claim(userId: string, deviceId: string, code: Uint8Array): Promise<ClaimOutcome> {
    const codeHash = createHash('sha256').update(code).digest('hex');

    // Two users can race for a controller: the loser sees the winner's result.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.decide(userId, deviceId, codeHash);
      } catch (error) {
        if (!(error instanceof ClaimConflictError) || attempt >= ATTEMPTS) throw error;
      }
    }
  }

  private async decide(userId: string, deviceId: string, codeHash: string): Promise<ClaimOutcome> {
    const current = await this.store.find(deviceId);

    // Checked first: a claim clears the report, and a retry after a lost
    // response must still get its answer.
    if (current?.lastClaimHash === codeHash) {
      return current.ownerId === userId
        ? { result: 'claimed', controller: current }
        : { result: 'already_owned' };
    }

    // An older report can remain until the controller sends the new one, so a
    // different hash means "not yet", not a refusal. It also tells a caller
    // without the right code nothing about the controller.
    const report = await this.reports.latest(deviceId);
    if (report?.codeHash !== codeHash) return { result: 'pending' };

    if (this.now() - report.storedAt > CLAIM_REPORT_LIFETIME_MS) return { result: 'expired' };

    if (current && !report.reset) {
      return current.ownerId === userId
        ? { result: 'already_owner', controller: current }
        : { result: 'already_owned' };
    }

    const controller = await this.store.claim({
      deviceId,
      userId,
      name: defaultControllerName(deviceId),
      codeHash,
      claimedAt: new Date(this.now()).toISOString(),
      previous: current,
    });

    await this.clearReport(deviceId);

    return { result: 'claimed', controller };
  }

  /** The hash is recorded as used, so a report left behind can't be reused. */
  private async clearReport(deviceId: string): Promise<void> {
    try {
      await this.reports.clear(deviceId);
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      console.warn(`Could not clear the claim report of ${deviceId} (${reason}).`);
    }
  }
}

export function defaultControllerName(deviceId: string): string {
  return `Controller ${deviceId.slice(-4)}`;
}
