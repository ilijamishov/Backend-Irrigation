import type { AccessStore } from './access-store';
import type { AccountRemover } from './cognito-users';
import type { OwnershipStore } from './ownership-store';
import type { Revoker } from './sharing-service';
import type { SharingStore } from './sharing-store';

export type Transfer = {
  readonly result: 'ok' | 'not_owner' | 'not_a_manager';
};

export type Release = { readonly result: 'ok' | 'not_owner' };

export type AccountDeletion =
  | { readonly result: 'ok' }
  | { readonly result: 'owns_controllers'; readonly deviceIds: string[] };

/**
 * Who owns a controller, and leaving the app (the app repo's
 * docs/user-roles.md §5): transferring a controller to one of its Managers,
 * releasing it, and deleting an account. Everyone who loses access, or whose
 * access changes, has their connections closed at once.
 */
export class OwnershipService {
  constructor(
    private readonly access: Pick<AccessStore, 'find' | 'accessOf'>,
    private readonly ownership: OwnershipStore,
    private readonly sharing: Pick<SharingStore, 'leave'>,
    private readonly accounts: AccountRemover,
    private readonly revoker: Revoker,
  ) {}

  /** The previous Owner loses access entirely. */
  async transfer(userId: string, deviceId: string, newOwnerId: string): Promise<Transfer> {
    if ((await this.access.find(deviceId))?.ownerId !== userId) return { result: 'not_owner' };
    if (newOwnerId === userId) return { result: 'not_a_manager' };

    if (!(await this.ownership.transfer(deviceId, userId, newOwnerId))) {
      // Only a Manager can become the Owner; the Owner was checked above.
      return { result: 'not_a_manager' };
    }

    await Promise.all([this.revoker.revoke(userId), this.revoker.revoke(newOwnerId)]);
    return { result: 'ok' };
  }

  /** The app clears the controller itself before it asks for this. */
  async release(userId: string, deviceId: string): Promise<Release> {
    const removed = await this.ownership.release(deviceId, userId);
    if (removed === null) return { result: 'not_owner' };

    await Promise.all(removed.map((removedId) => this.revoker.revoke(removedId)));
    return { result: 'ok' };
  }

  /**
   * Only once the user owns nothing, so a claimed controller always has an
   * Owner. Removes their Manager roles, then their sign-in. [username] is the
   * Cognito username.
   */
  async deleteAccount(userId: string, username: string): Promise<AccountDeletion> {
    const access = await this.access.accessOf(userId);
    const owned = access.filter(({ role }) => role === 'owner').map(({ deviceId }) => deviceId);
    if (owned.length > 0) return { result: 'owns_controllers', deviceIds: owned };

    for (const { deviceId } of access) {
      await this.sharing.leave(deviceId, userId);
    }
    await this.revoker.revoke(userId);
    await this.accounts.deleteUser(username);

    return { result: 'ok' };
  }
}
