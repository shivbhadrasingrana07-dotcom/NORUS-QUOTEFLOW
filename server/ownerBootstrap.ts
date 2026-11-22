import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '../src/db/index.ts';
import {
  auditLogs,
  invitations,
  organizationMemberships,
  organizations,
  users,
} from '../src/db/schema.ts';
import { generateSecureToken, sha256Hex } from './security.ts';

export class BootstrapError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'BootstrapError';
    this.statusCode = statusCode;
  }
}

export interface OrganizationOwnershipStatus {
  organizationId: string;
  organizationExists: boolean;
  organizationName: string | null;
  activeMemberCount: number;
  activeOwnerCount: number;
  pendingOwnerClaimCount: number;
  requiresFirstOwnerBootstrap: boolean;
}

export async function inspectOrganizationOwnership(
  db: DrizzleDb,
  organizationId: string
): Promise<OrganizationOwnershipStatus> {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!org) {
    return {
      organizationId,
      organizationExists: false,
      organizationName: null,
      activeMemberCount: 0,
      activeOwnerCount: 0,
      pendingOwnerClaimCount: 0,
      requiresFirstOwnerBootstrap: false,
    };
  }

  const memberships = await db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.status, 'active')
      )
    );

  const pendingClaims = await db
    .select({ id: invitations.id, expiresAt: invitations.expiresAt })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, organizationId),
        eq(invitations.role, 'owner'),
        eq(invitations.status, 'pending')
      )
    );

  const now = Date.now();
  const activeOwnerCount = memberships.filter((m) => m.role === 'owner').length;
  const validPendingClaims = pendingClaims.filter((c) => c.expiresAt.getTime() > now).length;

  return {
    organizationId,
    organizationExists: true,
    organizationName: org.name,
    activeMemberCount: memberships.length,
    activeOwnerCount,
    pendingOwnerClaimCount: validPendingClaims,
    requiresFirstOwnerBootstrap: activeOwnerCount === 0,
  };
}

export async function bootstrapFirstOwnerDirect(params: {
  db: DrizzleDb;
  organizationId: string;
  userEmail: string;
}): Promise<{
  organizationId: string;
  organizationName: string;
  ownerUserId: string;
  ownerEmail: string;
  membershipId: string;
}> {
  const email = String(params.userEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BootstrapError(400, 'A valid registered owner email is required.');
  }

  return await params.db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, params.organizationId))
      .limit(1);

    if (!org) {
      throw new BootstrapError(404, `Organization "${params.organizationId}" not found.`);
    }

    const existingOwners = await tx
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, params.organizationId),
          eq(organizationMemberships.role, 'owner'),
          eq(organizationMemberships.status, 'active')
        )
      );

    if (existingOwners.length > 0) {
      throw new BootstrapError(
        409,
        `Organization "${params.organizationId}" already has an active owner. Unauthorized reassignment blocked.`
      );
    }

    const [targetUser] = await tx
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!targetUser) {
      throw new BootstrapError(
        404,
        `No registered user account found for "${email}". Register the founder account first or issue a one-time owner claim token.`
      );
    }

    const [existingMembership] = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, params.organizationId),
          eq(organizationMemberships.userId, targetUser.id)
        )
      )
      .limit(1);

    let membershipId: string;
    if (existingMembership) {
      membershipId = existingMembership.id;
      await tx
        .update(organizationMemberships)
        .set({ role: 'owner', status: 'active', updatedAt: new Date() })
        .where(eq(organizationMemberships.id, membershipId));
    } else {
      membershipId = `mem-boot-${Date.now().toString(36)}-${generateSecureToken(4)}`;
      await tx.insert(organizationMemberships).values({
        id: membershipId,
        organizationId: params.organizationId,
        userId: targetUser.id,
        role: 'owner',
        status: 'active',
      });
    }

    if (!targetUser.lastActiveOrgId) {
      await tx
        .update(users)
        .set({ lastActiveOrgId: params.organizationId, updatedAt: new Date() })
        .where(eq(users.id, targetUser.id));
    }

    await tx.insert(auditLogs).values({
      id: `aud-boot-${Date.now().toString(36)}-${generateSecureToken(4)}`,
      organizationId: params.organizationId,
      actorUserId: targetUser.id,
      actorName: targetUser.fullName,
      actorRole: 'owner',
      entityType: 'membership',
      entityId: targetUser.id,
      action: 'FIRST_OWNER_BOOTSTRAPPED',
      detail: `Bootstrapped initial organization owner ${targetUser.fullName} (${targetUser.email}).`,
      createdAt: new Date().toISOString(),
    });

    return {
      organizationId: org.id,
      organizationName: org.name,
      ownerUserId: targetUser.id,
      ownerEmail: targetUser.email,
      membershipId,
    };
  });
}

export async function issueFirstOwnerClaimToken(params: {
  db: DrizzleDb;
  organizationId: string;
  allowedEmail: string;
  ttlHours?: number;
}): Promise<{
  invitationId: string;
  organizationId: string;
  organizationName: string;
  allowedEmail: string;
  expiresAt: string;
  rawClaimToken: string;
}> {
  const email = String(params.allowedEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BootstrapError(400, 'A valid email address for the authorized founder is required.');
  }
  const ttlHours = Math.max(1, Math.min(168, params.ttlHours ?? 72));

  return await params.db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, params.organizationId))
      .limit(1);

    if (!org) {
      throw new BootstrapError(404, `Organization "${params.organizationId}" not found.`);
    }

    const existingOwners = await tx
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, params.organizationId),
          eq(organizationMemberships.role, 'owner'),
          eq(organizationMemberships.status, 'active')
        )
      );

    if (existingOwners.length > 0) {
      throw new BootstrapError(
        409,
        `Organization "${params.organizationId}" already has an active owner. Claim token issuance blocked.`
      );
    }

    // Revoke any older unaccepted owner-claim tokens for this org
    await tx
      .update(invitations)
      .set({ status: 'revoked' })
      .where(
        and(
          eq(invitations.organizationId, params.organizationId),
          eq(invitations.role, 'owner'),
          eq(invitations.status, 'pending')
        )
      );

    const rawClaimToken = generateSecureToken(32);
    const tokenHash = sha256Hex(rawClaimToken);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const invitationId = `inv-boot-${Date.now().toString(36)}-${generateSecureToken(4)}`;

    await tx.insert(invitations).values({
      id: invitationId,
      organizationId: params.organizationId,
      email,
      role: 'owner',
      tokenHash,
      invitedByUserId: null,
      status: 'pending',
      expiresAt,
    });

    await tx.insert(auditLogs).values({
      id: `aud-claim-${Date.now().toString(36)}-${generateSecureToken(4)}`,
      organizationId: params.organizationId,
      actorUserId: null,
      actorName: 'System Bootstrap Operator',
      actorRole: 'owner',
      entityType: 'membership',
      entityId: invitationId,
      action: 'OWNER_CLAIM_TOKEN_ISSUED',
      detail: `Issued one-time first-owner claim token restricted to ${email} (expires ${expiresAt.toISOString()}).`,
      createdAt: new Date().toISOString(),
    });

    return {
      invitationId,
      organizationId: org.id,
      organizationName: org.name,
      allowedEmail: email,
      expiresAt: expiresAt.toISOString(),
      rawClaimToken,
    };
  });
}
