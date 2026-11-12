import type { ControllerRecord, Role } from '../lambda/controllers/access-store';
import {
  INVITATION_DAYS,
  isInvitationCode,
  MAX_MANAGERS,
  normalizedCode,
  SharingService,
} from '../lambda/controllers/sharing-service';
import type { Invitation, Member, SharingStore } from '../lambda/controllers/sharing-store';

const DEVICE_ID = '1C8F57371AA4';
const OWNER = 'owner-sub';
const MANAGER = 'manager-sub';
const STRANGER = 'stranger-sub';
const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const CODE = 'ABCDE23456';

class FakeSharingStore implements SharingStore {
  members: Member[] = [{ userId: OWNER, role: 'owner' }];
  invitations: Invitation[] = [];
  accepted: Member[] = [];
  /** What the next conditional write answers. */
  writes = true;

  async membersOf(): Promise<Member[]> {
    return this.members;
  }

  async invitationsOf(): Promise<Invitation[]> {
    return this.invitations;
  }

  async invitationByCode(codeHash: string): Promise<Invitation | null> {
    return this.invitations.find((invitation) => invitation.codeHash === codeHash) ?? null;
  }

  async addInvitation(_ownerId: string, invitation: Invitation): Promise<boolean> {
    if (this.writes) this.invitations.push(invitation);
    return this.writes;
  }

  async removeInvitation(_ownerId: string, invitation: Invitation): Promise<boolean> {
    this.invitations = this.invitations.filter((other) => other !== invitation);
    return this.writes;
  }

  async acceptInvitation(invitation: Invitation, manager: Member): Promise<boolean> {
    if (!this.writes) return false;
    this.accepted.push(manager);
    this.invitations = this.invitations.filter((other) => other !== invitation);
    return true;
  }

  async removeManager(_deviceId: string, _ownerId: string, managerId: string): Promise<boolean> {
    const found = this.members.some((m) => m.userId === managerId && m.role === 'manager');
    this.members = this.members.filter((m) => m.userId !== managerId);
    return found;
  }

  async leave(_deviceId: string, userId: string): Promise<boolean> {
    return this.removeManager(DEVICE_ID, OWNER, userId);
  }
}

function setUp() {
  const record: ControllerRecord = {
    deviceId: DEVICE_ID,
    name: 'Home lawn',
    ownerId: OWNER,
    lastClaimHash: 'hash',
  };
  const roles = new Map<string, Role>([[OWNER, 'owner']]);
  const access = {
    find: jest.fn(async (deviceId: string) => (deviceId === DEVICE_ID ? record : null)),
    roleOf: jest.fn(async (_deviceId: string, userId: string) => roles.get(userId) ?? null),
  };
  const store = new FakeSharingStore();
  const emails = { emailOf: jest.fn(async (): Promise<string | null> => 'manager@example.com') };
  const revoker = { revoke: jest.fn(async () => undefined) };
  let now = NOW;
  let ids = 0;

  const service = new SharingService(
    access,
    store,
    emails,
    revoker,
    () => now,
    () => `00000000-0000-4000-8000-00000000000${ids++}`,
    () => CODE,
  );

  return {
    service,
    store,
    roles,
    emails,
    revoker,
    later: (ms: number) => {
      now += ms;
    },
  };
}

const DAY = 86_400_000;

describe('invitation codes', () => {
  it('reads what people type or paste', () => {
    expect(normalizedCode(' abcde-23456 ')).toBe(CODE);
    expect(isInvitationCode('abcde-23456')).toBe(true);
  });

  it.each(['ABCDE2345', 'ABCDE234567', 'ABCDE2345O', 'ABCDE23451'])(
    'refuses %s, which is no code',
    (code) => {
      expect(isInvitationCode(code)).toBe(false);
    },
  );

  it('makes different codes of letters and digits that are easily told apart', async () => {
    const store = new FakeSharingStore();
    // The default code generator.
    const service = new SharingService(
      {
        find: async () => ({ deviceId: DEVICE_ID, name: 'x', ownerId: OWNER, lastClaimHash: 'h' }),
        roleOf: async () => null,
      },
      store,
      { emailOf: async () => null },
      { revoke: async () => undefined },
    );
    const codes = new Set<string>();

    for (let i = 0; i < 5; i++) {
      store.invitations = [];
      const created = await service.createInvitation(OWNER, DEVICE_ID);
      if (created.result !== 'ok') throw new Error(created.result);
      expect(isInvitationCode(created.code)).toBe(true);
      codes.add(created.code);
    }

    expect(codes.size).toBe(5);
  });
});

describe('SharingService', () => {
  describe('creating an invitation', () => {
    it('gives the Owner a code that expires after 3 days, and stores only its hash', async () => {
      const { service, store } = setUp();

      const created = await service.createInvitation(OWNER, DEVICE_ID);

      expect(created).toMatchObject({ result: 'ok', code: CODE });
      if (created.result !== 'ok') return;
      expect(created.invitation.expiresAt).toBe(
        new Date(NOW + INVITATION_DAYS * DAY).toISOString(),
      );
      expect(JSON.stringify(store.invitations)).not.toContain(CODE);
    });

    it('is only for the Owner', async () => {
      const { service, store } = setUp();

      await expect(service.createInvitation(MANAGER, DEVICE_ID)).resolves.toEqual({
        result: 'not_owner',
      });
      expect(store.invitations).toEqual([]);
    });

    it('counts Managers and pending invitations together', async () => {
      const { service, store } = setUp();
      for (let i = 0; i < MAX_MANAGERS - 1; i++) {
        store.members.push({ userId: `m${i}`, role: 'manager' });
      }
      await service.createInvitation(OWNER, DEVICE_ID);

      await expect(service.createInvitation(OWNER, DEVICE_ID)).resolves.toEqual({
        result: 'limit_reached',
      });
    });

    it('stops counting an invitation once it has expired', async () => {
      const { service, store, later } = setUp();
      for (let i = 0; i < MAX_MANAGERS - 1; i++) {
        store.members.push({ userId: `m${i}`, role: 'manager' });
      }
      await service.createInvitation(OWNER, DEVICE_ID);
      later(INVITATION_DAYS * DAY);

      await expect(service.createInvitation(OWNER, DEVICE_ID)).resolves.toMatchObject({
        result: 'ok',
      });
    });
  });

  describe('listing and cancelling invitations', () => {
    it('lists only those still pending', async () => {
      const { service, later } = setUp();
      await service.createInvitation(OWNER, DEVICE_ID);
      later(INVITATION_DAYS * DAY);

      const list = await service.listInvitations(OWNER, DEVICE_ID);

      expect(list).toEqual({ result: 'ok', invitations: [] });
    });

    it('lets only the Owner see them', async () => {
      const { service } = setUp();

      await expect(service.listInvitations(MANAGER, DEVICE_ID)).resolves.toEqual({
        result: 'not_owner',
      });
    });

    it('cancels one, so its code no longer works', async () => {
      const { service } = setUp();
      const created = await service.createInvitation(OWNER, DEVICE_ID);
      if (created.result !== 'ok') throw new Error(created.result);

      await expect(
        service.cancelInvitation(OWNER, DEVICE_ID, created.invitation.invitationId),
      ).resolves.toEqual({ result: 'ok' });
      await expect(service.previewInvitation(CODE)).resolves.toEqual({
        result: 'invitation_not_found',
      });
    });

    it('says when there is nothing to cancel', async () => {
      const { service } = setUp();

      await expect(
        service.cancelInvitation(OWNER, DEVICE_ID, '00000000-0000-4000-8000-000000000009'),
      ).resolves.toEqual({ result: 'invitation_not_found' });
    });
  });

  describe('joining', () => {
    it('shows the controller name before joining', async () => {
      const { service } = setUp();
      await service.createInvitation(OWNER, DEVICE_ID);

      await expect(service.previewInvitation('abcde-23456')).resolves.toEqual({
        result: 'ok',
        name: 'Home lawn',
        expiresAt: new Date(NOW + INVITATION_DAYS * DAY).toISOString(),
      });
    });

    it('makes the user a Manager, with their email for the Owner', async () => {
      const { service, store, emails } = setUp();
      await service.createInvitation(OWNER, DEVICE_ID);

      const accepted = await service.acceptInvitation(STRANGER, 'google_123', CODE);

      expect(accepted).toEqual({
        result: 'ok',
        controller: { deviceId: DEVICE_ID, name: 'Home lawn', role: 'manager' },
      });
      expect(emails.emailOf).toHaveBeenCalledWith('google_123');
      expect(store.accepted).toEqual([
        { userId: STRANGER, role: 'manager', email: 'manager@example.com' },
      ]);
    });

    it('joins without an email when there is none', async () => {
      const { service, store, emails } = setUp();
      emails.emailOf.mockResolvedValue(null);
      await service.createInvitation(OWNER, DEVICE_ID);

      await service.acceptInvitation(STRANGER, 'google_123', CODE);

      expect(store.accepted).toEqual([{ userId: STRANGER, role: 'manager' }]);
    });

    it('works once only', async () => {
      const { service } = setUp();
      await service.createInvitation(OWNER, DEVICE_ID);
      await service.acceptInvitation(STRANGER, 'google_123', CODE);

      await expect(service.acceptInvitation('another-sub', 'google_456', CODE)).resolves.toEqual({
        result: 'invitation_not_found',
      });
    });

    it('refuses an expired invitation', async () => {
      const { service, later } = setUp();
      await service.createInvitation(OWNER, DEVICE_ID);
      later(INVITATION_DAYS * DAY);

      await expect(service.acceptInvitation(STRANGER, 'google_123', CODE)).resolves.toEqual({
        result: 'invitation_expired',
      });
      await expect(service.previewInvitation(CODE)).resolves.toEqual({
        result: 'invitation_expired',
      });
    });

    it('leaves the Owner, or a Manager, the role they have', async () => {
      const { service, store } = setUp();
      await service.createInvitation(OWNER, DEVICE_ID);

      await expect(service.acceptInvitation(OWNER, 'google_owner', CODE)).resolves.toEqual({
        result: 'already_has_access',
      });
      expect(store.invitations).toHaveLength(1);
    });

    it('refuses when the invitation went meanwhile', async () => {
      const { service, store } = setUp();
      await service.createInvitation(OWNER, DEVICE_ID);
      store.writes = false;

      await expect(service.acceptInvitation(STRANGER, 'google_123', CODE)).resolves.toEqual({
        result: 'invitation_not_found',
      });
    });
  });

  describe('people', () => {
    it('lists the Owner first, then Managers by email', async () => {
      const { service, store } = setUp();
      store.members = [
        { userId: 'b', role: 'manager', email: 'zoe@example.com' },
        { userId: OWNER, role: 'owner' },
        { userId: 'a', role: 'manager', email: 'ann@example.com' },
      ];

      const list = await service.listPeople(OWNER, DEVICE_ID);

      expect(list.result === 'ok' && list.people.map((p) => p.userId)).toEqual([OWNER, 'a', 'b']);
    });

    it('shows them to the Owner only', async () => {
      const { service } = setUp();

      await expect(service.listPeople(MANAGER, DEVICE_ID)).resolves.toEqual({
        result: 'not_owner',
      });
    });

    it('removes a Manager and closes their connections', async () => {
      const { service, store, revoker } = setUp();
      store.members.push({ userId: MANAGER, role: 'manager' });

      await expect(service.removeManager(OWNER, DEVICE_ID, MANAGER)).resolves.toEqual({
        result: 'ok',
      });
      expect(revoker.revoke).toHaveBeenCalledWith(MANAGER);
    });

    it('removes no one but a Manager', async () => {
      const { service, revoker } = setUp();

      await expect(service.removeManager(OWNER, DEVICE_ID, OWNER)).resolves.toEqual({
        result: 'not_a_manager',
      });
      expect(revoker.revoke).not.toHaveBeenCalled();
    });

    it('lets only the Owner remove anyone', async () => {
      const { service, store } = setUp();
      store.members.push({ userId: MANAGER, role: 'manager' });

      await expect(service.removeManager(MANAGER, DEVICE_ID, MANAGER)).resolves.toEqual({
        result: 'not_owner',
      });
    });
  });

  describe('leaving', () => {
    it('lets a Manager leave, and closes their connections', async () => {
      const { service, store, roles, revoker } = setUp();
      store.members.push({ userId: MANAGER, role: 'manager' });
      roles.set(MANAGER, 'manager');

      await expect(service.leave(MANAGER, DEVICE_ID)).resolves.toEqual({ result: 'ok' });
      expect(revoker.revoke).toHaveBeenCalledWith(MANAGER);
    });

    it('never lets the Owner leave: they transfer or release instead', async () => {
      const { service } = setUp();

      await expect(service.leave(OWNER, DEVICE_ID)).resolves.toEqual({
        result: 'owner_cannot_leave',
      });
    });

    it('says so to someone without access', async () => {
      const { service, revoker } = setUp();

      await expect(service.leave(STRANGER, DEVICE_ID)).resolves.toEqual({ result: 'no_access' });
      expect(revoker.revoke).not.toHaveBeenCalled();
    });
  });
});
