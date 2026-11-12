import { createHash, randomInt, randomUUID } from 'node:crypto';

import type { AccessStore, UserController } from './access-store';
import type { EmailDirectory } from './cognito-users';
import type { Invitation, Member, SharingStore } from './sharing-store';

/** How long an invitation can be accepted (docs/user-roles.md §6.1). */
export const INVITATION_LIFETIME_MS = 60 * 60 * 1000;
/** Managers and pending invitations together, per controller. */
export const MAX_MANAGERS = 10;

/** Six digits, easy to read out and type. */
export const CODE_LENGTH = 6;
const CODE = /^\d{6}$/;
/** A new code that happens to be in use is replaced by another. */
const CODE_ATTEMPTS = 5;

/** Revokes a user's open connections after their access changed. */
export interface Revoker {
  revoke(userId: string): Promise<void>;
}

export type InvitationCreation =
  | { readonly result: 'ok'; readonly invitation: Invitation; readonly code: string }
  | { readonly result: 'not_owner' | 'limit_reached' };

export type InvitationList =
  | { readonly result: 'ok'; readonly invitations: Invitation[] }
  | { readonly result: 'not_owner' };

export type InvitationPreview =
  | { readonly result: 'ok'; readonly name: string; readonly expiresAt: string }
  | { readonly result: 'invitation_not_found' | 'invitation_expired' };

export type InvitationAcceptance =
  | { readonly result: 'ok'; readonly controller: UserController }
  | { readonly result: 'invitation_not_found' | 'invitation_expired' | 'already_has_access' };

export type PeopleList =
  | { readonly result: 'ok'; readonly people: Member[] }
  | { readonly result: 'not_owner' };

/**
 * Sharing a controller with Managers (docs/user-roles.md §6). The Owner
 * creates an invitation and shares its code; whoever enters the code becomes a
 * Manager. The code itself is never stored or logged, only its hash.
 */
export class SharingService {
  constructor(
    private readonly access: Pick<AccessStore, 'find' | 'roleOf'>,
    private readonly store: SharingStore,
    private readonly emails: EmailDirectory,
    private readonly revoker: Revoker,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
    private readonly newCode: () => string = randomCode,
  ) {}

  async createInvitation(userId: string, deviceId: string): Promise<InvitationCreation> {
    if (!(await this.isOwner(userId, deviceId))) return { result: 'not_owner' };

    const [members, invitations] = await Promise.all([
      this.store.membersOf(deviceId),
      this.pendingOf(deviceId),
    ]);
    const managers = members.filter((member) => member.role === 'manager');
    if (managers.length + invitations.length >= MAX_MANAGERS) return { result: 'limit_reached' };

    for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt++) {
      const code = this.newCode();
      const invitation: Invitation = {
        invitationId: this.newId(),
        deviceId,
        codeHash: hashOf(code),
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + INVITATION_LIFETIME_MS).toISOString(),
      };

      if (await this.store.addInvitation(userId, invitation)) {
        return { result: 'ok', invitation, code };
      }
      // Either the code is in use by a pending invitation, or ownership
      // changed meanwhile.
      if (!(await this.isOwner(userId, deviceId))) return { result: 'not_owner' };
    }

    throw new Error('No free invitation code.');
  }

  async listInvitations(userId: string, deviceId: string): Promise<InvitationList> {
    if (!(await this.isOwner(userId, deviceId))) return { result: 'not_owner' };

    const invitations = await this.pendingOf(deviceId);
    return {
      result: 'ok',
      invitations: invitations.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  }

  async cancelInvitation(
    userId: string,
    deviceId: string,
    invitationId: string,
  ): Promise<{ readonly result: 'ok' | 'not_owner' | 'invitation_not_found' }> {
    if (!(await this.isOwner(userId, deviceId))) return { result: 'not_owner' };

    const invitation = (await this.store.invitationsOf(deviceId)).find(
      (candidate) => candidate.invitationId === invitationId,
    );
    if (!invitation) return { result: 'invitation_not_found' };

    const removed = await this.store.removeInvitation(userId, invitation);
    return { result: removed ? 'ok' : 'invitation_not_found' };
  }

  /** What the invitee sees before they join. */
  async previewInvitation(code: string): Promise<InvitationPreview> {
    const found = await this.validInvitation(code);
    if (found.result !== 'ok') return found;

    const controller = await this.access.find(found.invitation.deviceId);
    if (!controller) return { result: 'invitation_not_found' };

    return { result: 'ok', name: controller.name, expiresAt: found.invitation.expiresAt };
  }

  /** [username] is the Cognito username, for the email the Owner sees. */
  async acceptInvitation(
    userId: string,
    username: string,
    code: string,
  ): Promise<InvitationAcceptance> {
    const found = await this.validInvitation(code);
    if (found.result !== 'ok') return found;

    const { invitation } = found;
    if (await this.access.roleOf(invitation.deviceId, userId)) {
      return { result: 'already_has_access' };
    }

    const controller = await this.access.find(invitation.deviceId);
    if (!controller) return { result: 'invitation_not_found' };

    const email = await this.emails.emailOf(username);
    const accepted = await this.store.acceptInvitation(invitation, {
      userId,
      role: 'manager',
      ...(email ? { email } : {}),
    });

    // Someone used it first, or the Owner cancelled it, or a reset removed it.
    if (!accepted) return { result: 'invitation_not_found' };

    return {
      result: 'ok',
      controller: { deviceId: controller.deviceId, name: controller.name, role: 'manager' },
    };
  }

  async listPeople(userId: string, deviceId: string): Promise<PeopleList> {
    if (!(await this.isOwner(userId, deviceId))) return { result: 'not_owner' };

    const people = await this.store.membersOf(deviceId);
    // The Owner first, then Managers by email.
    return {
      result: 'ok',
      people: people.sort(
        (a, b) =>
          Number(b.role === 'owner') - Number(a.role === 'owner') ||
          (a.email ?? '').localeCompare(b.email ?? ''),
      ),
    };
  }

  async removeManager(
    userId: string,
    deviceId: string,
    managerId: string,
  ): Promise<{ readonly result: 'ok' | 'not_owner' | 'not_a_manager' }> {
    if (!(await this.isOwner(userId, deviceId))) return { result: 'not_owner' };

    if (!(await this.store.removeManager(deviceId, userId, managerId))) {
      return { result: 'not_a_manager' };
    }

    await this.revoker.revoke(managerId);
    return { result: 'ok' };
  }

  async leave(
    userId: string,
    deviceId: string,
  ): Promise<{ readonly result: 'ok' | 'owner_cannot_leave' | 'no_access' }> {
    const role = await this.access.roleOf(deviceId, userId);
    if (role === 'owner') return { result: 'owner_cannot_leave' };
    if (role === null || !(await this.store.leave(deviceId, userId))) {
      return { result: 'no_access' };
    }

    await this.revoker.revoke(userId);
    return { result: 'ok' };
  }

  private async isOwner(userId: string, deviceId: string): Promise<boolean> {
    return (await this.access.find(deviceId))?.ownerId === userId;
  }

  private async pendingOf(deviceId: string): Promise<Invitation[]> {
    const invitations = await this.store.invitationsOf(deviceId);
    return invitations.filter((invitation) => !this.hasExpired(invitation));
  }

  private async validInvitation(
    code: string,
  ): Promise<
    | { readonly result: 'ok'; readonly invitation: Invitation }
    | { readonly result: 'invitation_not_found' | 'invitation_expired' }
  > {
    const invitation = await this.store.invitationByCode(hashOf(normalizedCode(code)));
    if (!invitation) return { result: 'invitation_not_found' };
    if (this.hasExpired(invitation)) return { result: 'invitation_expired' };

    return { result: 'ok', invitation };
  }

  private hasExpired(invitation: Invitation): boolean {
    return Date.parse(invitation.expiresAt) <= this.now();
  }
}

/** Without the spaces and hyphens people type or share it with. */
export function normalizedCode(code: string): string {
  return code.replace(/[\s-]/g, '');
}

/** Whether [code], once normalized, could be an invitation code at all. */
export function isInvitationCode(code: string): boolean {
  return CODE.test(normalizedCode(code));
}

/** Six random digits, leading zeros included. */
function randomCode(): string {
  return randomInt(10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, '0');
}

function hashOf(code: string): string {
  return createHash('sha256').update(code).digest('base64url');
}
