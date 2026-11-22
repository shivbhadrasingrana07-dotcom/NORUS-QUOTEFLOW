import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '../src/db/index.ts';
import {
  auditLogs,
  awardAllocations,
  awards,
  catalogItems,
  invitations,
  organizationMemberships,
  organizations,
  priceHistory,
  quotationLines,
  quotations,
  rfqItems,
  rfqs,
  sessions,
  storedDocuments,
  suppliers,
  users,
} from '../src/db/schema.ts';
import { rankQuotations } from '../src/lib/ranking.ts';
import type {
  AuditLogEntry,
  AuthUser,
  AwardAllocation,
  AwardDecision,
  CatalogItem,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationSettings,
  OrganizationSummary,
  Quotation,
  QuotationLine,
  Rfq,
  SessionInfo,
  Supplier,
  TaxRegime,
  UserRole,
  WorkspaceState,
} from '../src/types.ts';
import { recomputeQuotation } from './normalization.ts';
import { canAssignRole, INVITABLE_ROLES, VALID_ORG_ROLES } from './rbac.ts';
import {
  generateSecureToken,
  hashPassword,
  redactSensitiveText,
  SESSION_TTL_MS,
  sha256Hex,
  slugifyOrgName,
  validatePasswordStrength,
  verifyPassword,
} from './security.ts';
import { createSampleRfqAndQuotes } from './seedData.ts';

export class StoreError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'StoreError';
    this.statusCode = statusCode;
  }
}

const DEFAULT_UOM_ALIASES: Record<string, string> = {
  nos: 'pcs',
  units: 'pcs',
  pc: 'pcs',
  kgs: 'kg',
  mtr: 'm',
  mtrs: 'm',
};

const VALID_CURRENCIES = new Set(['INR', 'USD', 'GBP', 'EUR']);
const VALID_TAX_REGIMES = new Set(['INDIA_GST', 'UK_VAT', 'US_TAX', 'NONE']);

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${generateSecureToken(6)}`;
}

function normalizeEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

function isNonNegativeFinite(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

function isPositiveFinite(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0;
}

function handleDbError(err: unknown, context: string): never {
  if (err instanceof StoreError) throw err;
  const rawMsg = err instanceof Error ? err.message : String(err);
  const safeMsg = redactSensitiveText(rawMsg);
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[pgStore:${context}]`, safeMsg);
  }
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === '23505') {
    throw new StoreError(409, 'A conflicting record already exists.');
  }
  if (pgCode === '23503') {
    throw new StoreError(400, 'Referenced record does not exist or cannot be removed.');
  }
  throw new StoreError(500, `Database operation failed during ${context}.`);
}

function mapUserRow(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    title: row.title,
    emailVerified: row.emailVerified,
    hasPassword: Boolean(row.passwordHash),
    hasGoogleLinked: Boolean(row.firebaseUid),
  };
}

function mapOrgSummary(
  org: typeof organizations.$inferSelect,
  role: UserRole
): OrganizationSummary {
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    countryCode: org.countryCode,
    defaultCurrency: (VALID_CURRENCIES.has(org.defaultCurrency)
      ? org.defaultCurrency
      : 'INR') as OrganizationSummary['defaultCurrency'],
    taxRegime: (VALID_TAX_REGIMES.has(org.taxRegime)
      ? org.taxRegime
      : 'INDIA_GST') as TaxRegime,
    defaultTaxCreditable: org.defaultTaxCreditable,
    role,
  };
}

export interface SessionAuthContext {
  sessionId: string;
  csrfToken: string;
  user: AuthUser;
  activeOrganization: OrganizationSummary | null;
  organizations: OrganizationSummary[];
}

export interface StoredDocumentRecord {
  id: string;
  organizationId: string;
  uploadedByUserId: string | null;
  storageProvider: 's3' | 'local';
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

export class PgDataStore {
  private readonly db: DrizzleDb;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  private async appendAuditTx(
    tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0] | DrizzleDb,
    params: {
      organizationId: string;
      actorUserId?: string | null;
      actorName: string;
      actorRole: UserRole;
      entityType: AuditLogEntry['entityType'];
      entityId: string;
      action: string;
      detail: string;
    }
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      id: makeId('aud'),
      organizationId: params.organizationId,
      actorUserId: params.actorUserId ?? null,
      actorName: params.actorName,
      actorRole: params.actorRole,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      detail: params.detail,
      createdAt: new Date().toISOString(),
    });
  }

  private async getUserOrganizations(
    txOrDb: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0] | DrizzleDb,
    userId: string
  ): Promise<OrganizationSummary[]> {
    const rows = await txOrDb
      .select({
        org: organizations,
        membership: organizationMemberships,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizationMemberships.organizationId, organizations.id))
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, 'active')
        )
      )
      .orderBy(asc(organizations.createdAt));

    return rows.map((r) => mapOrgSummary(r.org, r.membership.role as UserRole));
  }

  private async createSessionTx(
    tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0],
    params: {
      userId: string;
      activeOrganizationId: string | null;
      authMethod: string;
      ipAddress?: string | null;
      userAgent?: string | null;
    }
  ): Promise<{ rawSessionToken: string; csrfToken: string; sessionId: string }> {
    const rawSessionToken = generateSecureToken(32);
    const csrfToken = generateSecureToken(24);
    const sessionId = makeId('sess');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

    await tx.insert(sessions).values({
      id: sessionId,
      userId: params.userId,
      activeOrganizationId: params.activeOrganizationId,
      tokenHash: sha256Hex(rawSessionToken),
      csrfToken,
      authMethod: params.authMethod,
      ipAddress: params.ipAddress ? params.ipAddress.slice(0, 64) : null,
      userAgent: params.userAgent ? params.userAgent.slice(0, 240) : null,
      expiresAt,
      lastSeenAt: now,
      createdAt: now,
    });

    return { rawSessionToken, csrfToken, sessionId };
  }

  async registerWithPassword(params: {
    email: string;
    password: string;
    fullName: string;
    title?: string;
    organizationName?: string;
    inviteToken?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<SessionAuthContext & { rawSessionToken: string; rawVerificationToken: string }> {
    try {
      const email = normalizeEmail(params.email);
      if (!isValidEmail(email)) {
        throw new StoreError(400, 'Please enter a valid email address.');
      }
      const pwErr = validatePasswordStrength(params.password);
      if (pwErr) {
        throw new StoreError(400, pwErr);
      }
      const fullName = String(params.fullName || '').trim();
      if (fullName.length < 2 || fullName.length > 120) {
        throw new StoreError(400, 'Full name must be between 2 and 120 characters.');
      }
      const title = String(params.title || '').trim().slice(0, 80) || 'Procurement Lead';

      const existing = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing.length > 0) {
        throw new StoreError(409, 'An account with this email already exists.');
      }

      const passwordHash = await hashPassword(params.password);
      const rawVerificationToken = generateSecureToken(32);
      const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const userId = makeId('usr');

      const result = await this.db.transaction(async (tx) => {
        let activeOrgId: string | null = null;
        let joinedRole: UserRole = 'owner';

        if (params.inviteToken) {
          const inviteHash = sha256Hex(params.inviteToken);
          const [inv] = await tx
            .select()
            .from(invitations)
            .where(eq(invitations.tokenHash, inviteHash))
            .limit(1);

          if (!inv || inv.status !== 'pending' || inv.expiresAt.getTime() <= Date.now()) {
            throw new StoreError(400, 'This organization invitation is invalid or has expired.');
          }
          if (normalizeEmail(inv.email) !== email) {
            throw new StoreError(
              403,
              'Invitation email does not match the registering email address.'
            );
          }

          await tx.insert(users).values({
            id: userId,
            email,
            passwordHash,
            fullName,
            title,
            emailVerified: false,
            emailVerificationTokenHash: sha256Hex(rawVerificationToken),
            emailVerificationExpiresAt: verificationExpiresAt,
            lastActiveOrgId: inv.organizationId,
          });

          joinedRole = inv.role as UserRole;
          activeOrgId = inv.organizationId;

          await tx.insert(organizationMemberships).values({
            id: makeId('mem'),
            organizationId: inv.organizationId,
            userId,
            role: joinedRole,
            status: 'active',
          });

          await tx
            .update(invitations)
            .set({ status: 'accepted', acceptedAt: new Date() })
            .where(eq(invitations.id, inv.id));

          await this.appendAuditTx(tx, {
            organizationId: inv.organizationId,
            actorUserId: userId,
            actorName: fullName,
            actorRole: joinedRole,
            entityType: 'membership',
            entityId: userId,
            action: 'INVITATION_ACCEPTED',
            detail: `${fullName} (${email}) joined organization as ${joinedRole}.`,
          });
        } else {
          const orgName =
            String(params.organizationName || '').trim().slice(0, 120) ||
            `${fullName.split(' ')[0]}'s Procurement Workspace`;
          const orgId = makeId('org');
          activeOrgId = orgId;

          await tx.insert(users).values({
            id: userId,
            email,
            passwordHash,
            fullName,
            title,
            emailVerified: false,
            emailVerificationTokenHash: sha256Hex(rawVerificationToken),
            emailVerificationExpiresAt: verificationExpiresAt,
            lastActiveOrgId: orgId,
          });

          await tx.insert(organizations).values({
            id: orgId,
            slug: slugifyOrgName(orgName),
            name: orgName,
            countryCode: 'IN',
            defaultCurrency: 'INR',
            taxRegime: 'INDIA_GST',
            defaultTaxCreditable: true,
            uomAliases: { ...DEFAULT_UOM_ALIASES },
            createdByUserId: userId,
          });

          await tx.insert(organizationMemberships).values({
            id: makeId('mem'),
            organizationId: orgId,
            userId,
            role: 'owner',
            status: 'active',
          });

          await this.appendAuditTx(tx, {
            organizationId: orgId,
            actorUserId: userId,
            actorName: fullName,
            actorRole: 'owner',
            entityType: 'auth',
            entityId: orgId,
            action: 'ORGANIZATION_CREATED',
            detail: `Created organization "${orgName}" with ${fullName} as owner.`,
          });
        }

        const [userRow] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
        const orgs = await this.getUserOrganizations(tx, userId);
        const activeOrg = orgs.find((o) => o.id === activeOrgId) || orgs[0] || null;

        const sess = await this.createSessionTx(tx, {
          userId,
          activeOrganizationId: activeOrg?.id ?? null,
          authMethod: 'password',
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        });

        return {
          sessionId: sess.sessionId,
          rawSessionToken: sess.rawSessionToken,
          csrfToken: sess.csrfToken,
          rawVerificationToken,
          user: mapUserRow(userRow),
          activeOrganization: activeOrg,
          organizations: orgs,
        };
      });

      return result;
    } catch (err) {
      handleDbError(err, 'registerWithPassword');
    }
  }

  async loginWithPassword(params: {
    email: string;
    password: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<SessionAuthContext & { rawSessionToken: string }> {
    try {
      const email = normalizeEmail(params.email);
      if (!email || !params.password) {
        throw new StoreError(400, 'Email and password are required.');
      }

      const [userRow] = await this.db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (!userRow || !userRow.passwordHash) {
        throw new StoreError(401, 'Invalid email or password.');
      }

      const ok = await verifyPassword(params.password, userRow.passwordHash);
      if (!ok) {
        throw new StoreError(401, 'Invalid email or password.');
      }

      return await this.db.transaction(async (tx) => {
        const orgs = await this.getUserOrganizations(tx, userRow.id);
        const activeOrg =
          orgs.find((o) => o.id === userRow.lastActiveOrgId) || orgs[0] || null;

        if (activeOrg && activeOrg.id !== userRow.lastActiveOrgId) {
          await tx
            .update(users)
            .set({ lastActiveOrgId: activeOrg.id, updatedAt: new Date() })
            .where(eq(users.id, userRow.id));
        }

        const sess = await this.createSessionTx(tx, {
          userId: userRow.id,
          activeOrganizationId: activeOrg?.id ?? null,
          authMethod: 'password',
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        });

        return {
          sessionId: sess.sessionId,
          rawSessionToken: sess.rawSessionToken,
          csrfToken: sess.csrfToken,
          user: mapUserRow(userRow),
          activeOrganization: activeOrg,
          organizations: orgs,
        };
      });
    } catch (err) {
      handleDbError(err, 'loginWithPassword');
    }
  }

  async loginWithGoogle(params: {
    firebaseUid: string;
    email: string;
    fullName: string;
    emailVerified: boolean;
    inviteToken?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<SessionAuthContext & { rawSessionToken: string }> {
    try {
      const email = normalizeEmail(params.email);
      if (!isValidEmail(email) || !params.firebaseUid) {
        throw new StoreError(400, 'Valid Google email and identity UID are required.');
      }
      const displayName = String(params.fullName || '').trim() || email.split('@')[0];

      return await this.db.transaction(async (tx) => {
        let [userRow] = await tx
          .select()
          .from(users)
          .where(eq(users.firebaseUid, params.firebaseUid))
          .limit(1);

        if (!userRow) {
          [userRow] = await tx
            .select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
        }

        if (!userRow) {
          const userId = makeId('usr');
          let targetOrgId: string | null = null;
          let joinedRole: UserRole = 'owner';

          if (params.inviteToken) {
            const inviteHash = sha256Hex(params.inviteToken);
            const [inv] = await tx
              .select()
              .from(invitations)
              .where(eq(invitations.tokenHash, inviteHash))
              .limit(1);
            if (!inv || inv.status !== 'pending' || inv.expiresAt.getTime() <= Date.now()) {
              throw new StoreError(400, 'This invitation is invalid or has expired.');
            }
            if (normalizeEmail(inv.email) !== email) {
              throw new StoreError(
                403,
                'Your Google email does not match the invited email address.'
              );
            }
            targetOrgId = inv.organizationId;
            joinedRole = inv.role as UserRole;

            await tx.insert(users).values({
              id: userId,
              firebaseUid: params.firebaseUid,
              email,
              passwordHash: null,
              fullName: displayName.slice(0, 120),
              title: 'Procurement Member',
              emailVerified: Boolean(params.emailVerified),
              lastActiveOrgId: targetOrgId,
            });

            await tx.insert(organizationMemberships).values({
              id: makeId('mem'),
              organizationId: targetOrgId,
              userId,
              role: joinedRole,
              status: 'active',
            });

            await tx
              .update(invitations)
              .set({ status: 'accepted', acceptedAt: new Date() })
              .where(eq(invitations.id, inv.id));

            await this.appendAuditTx(tx, {
              organizationId: targetOrgId,
              actorUserId: userId,
              actorName: displayName,
              actorRole: joinedRole,
              entityType: 'membership',
              entityId: userId,
              action: 'INVITATION_ACCEPTED',
              detail: `${displayName} (${email}) joined via Google Sign-In as ${joinedRole}.`,
            });
          } else {
            const orgId = makeId('org');
            const orgName = `${displayName.split(' ')[0]}'s Procurement Workspace`;
            targetOrgId = orgId;

            await tx.insert(users).values({
              id: userId,
              firebaseUid: params.firebaseUid,
              email,
              passwordHash: null,
              fullName: displayName.slice(0, 120),
              title: 'Workspace Owner',
              emailVerified: Boolean(params.emailVerified),
              lastActiveOrgId: orgId,
            });

            await tx.insert(organizations).values({
              id: orgId,
              slug: slugifyOrgName(orgName),
              name: orgName,
              countryCode: 'IN',
              defaultCurrency: 'INR',
              taxRegime: 'INDIA_GST',
              defaultTaxCreditable: true,
              uomAliases: { ...DEFAULT_UOM_ALIASES },
              createdByUserId: userId,
            });

            await tx.insert(organizationMemberships).values({
              id: makeId('mem'),
              organizationId: orgId,
              userId,
              role: 'owner',
              status: 'active',
            });

            await this.appendAuditTx(tx, {
              organizationId: orgId,
              actorUserId: userId,
              actorName: displayName,
              actorRole: 'owner',
              entityType: 'auth',
              entityId: orgId,
              action: 'ORGANIZATION_CREATED',
              detail: `Created workspace "${orgName}" via Google Sign-In.`,
            });
          }

          [userRow] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
        } else {
          const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
          if (!userRow.firebaseUid) patch.firebaseUid = params.firebaseUid;
          if (!userRow.emailVerified && params.emailVerified) patch.emailVerified = true;
          await tx.update(users).set(patch).where(eq(users.id, userRow.id));
          [userRow] = await tx.select().from(users).where(eq(users.id, userRow.id)).limit(1);
        }

        const orgs = await this.getUserOrganizations(tx, userRow.id);
        const activeOrg =
          orgs.find((o) => o.id === userRow.lastActiveOrgId) || orgs[0] || null;

        const sess = await this.createSessionTx(tx, {
          userId: userRow.id,
          activeOrganizationId: activeOrg?.id ?? null,
          authMethod: 'google',
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        });

        return {
          sessionId: sess.sessionId,
          rawSessionToken: sess.rawSessionToken,
          csrfToken: sess.csrfToken,
          user: mapUserRow(userRow),
          activeOrganization: activeOrg,
          organizations: orgs,
        };
      });
    } catch (err) {
      handleDbError(err, 'loginWithGoogle');
    }
  }

  async getSessionContext(rawSessionToken: string): Promise<SessionAuthContext | null> {
    if (!rawSessionToken) return null;
    try {
      const tokenHash = sha256Hex(rawSessionToken);
      const now = new Date();
      const [row] = await this.db
        .select({
          session: sessions,
          user: users,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now)
          )
        )
        .limit(1);

      if (!row) return null;

      const orgs = await this.getUserOrganizations(this.db, row.user.id);
      const activeOrg =
        orgs.find((o) => o.id === row.session.activeOrganizationId) ||
        orgs.find((o) => o.id === row.user.lastActiveOrgId) ||
        orgs[0] ||
        null;

      if (now.getTime() - row.session.lastSeenAt.getTime() > 60_000) {
        await this.db
          .update(sessions)
          .set({ lastSeenAt: now })
          .where(eq(sessions.id, row.session.id));
      }

      return {
        sessionId: row.session.id,
        csrfToken: row.session.csrfToken,
        user: mapUserRow(row.user),
        activeOrganization: activeOrg,
        organizations: orgs,
      };
    } catch (err) {
      handleDbError(err, 'getSessionContext');
    }
  }

  async revokeSessionByToken(rawSessionToken: string): Promise<void> {
    if (!rawSessionToken) return;
    try {
      await this.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.tokenHash, sha256Hex(rawSessionToken)));
    } catch (err) {
      handleDbError(err, 'revokeSessionByToken');
    }
  }

  async listUserSessions(userId: string, currentSessionId: string): Promise<SessionInfo[]> {
    try {
      const now = new Date();
      const rows = await this.db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now)
          )
        )
        .orderBy(desc(sessions.lastSeenAt));

      return rows.map((s) => ({
        id: s.id,
        authMethod: s.authMethod,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        expiresAt: s.expiresAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        createdAt: s.createdAt.toISOString(),
        isCurrent: s.id === currentSessionId,
      }));
    } catch (err) {
      handleDbError(err, 'listUserSessions');
    }
  }

  async revokeSessionById(userId: string, sessionId: string): Promise<void> {
    try {
      const updated = await this.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
        .returning({ id: sessions.id });

      if (updated.length === 0) {
        throw new StoreError(404, 'Session not found.');
      }
    } catch (err) {
      handleDbError(err, 'revokeSessionById');
    }
  }

  async verifyEmailByToken(rawToken: string): Promise<AuthUser> {
    try {
      if (!rawToken) throw new StoreError(400, 'Verification token is required.');
      const hash = sha256Hex(rawToken);
      const [userRow] = await this.db
        .select()
        .from(users)
        .where(eq(users.emailVerificationTokenHash, hash))
        .limit(1);

      if (
        !userRow ||
        !userRow.emailVerificationExpiresAt ||
        userRow.emailVerificationExpiresAt.getTime() <= Date.now()
      ) {
        throw new StoreError(400, 'Verification link is invalid or has expired.');
      }

      const [updated] = await this.db
        .update(users)
        .set({
          emailVerified: true,
          emailVerificationTokenHash: null,
          emailVerificationExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userRow.id))
        .returning();

      return mapUserRow(updated);
    } catch (err) {
      handleDbError(err, 'verifyEmailByToken');
    }
  }

  async createEmailVerificationToken(userId: string): Promise<{ email: string; fullName: string; rawToken: string }> {
    try {
      const rawToken = generateSecureToken(32);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const [updated] = await this.db
        .update(users)
        .set({
          emailVerificationTokenHash: sha256Hex(rawToken),
          emailVerificationExpiresAt: expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning();

      if (!updated) throw new StoreError(404, 'User not found.');
      return { email: updated.email, fullName: updated.fullName, rawToken };
    } catch (err) {
      handleDbError(err, 'createEmailVerificationToken');
    }
  }

  async createPasswordResetToken(rawEmail: string): Promise<{
    email: string;
    fullName: string;
    rawToken: string;
  } | null> {
    try {
      const email = normalizeEmail(rawEmail);
      if (!isValidEmail(email)) return null;
      const [userRow] = await this.db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (!userRow) return null;

      const rawToken = generateSecureToken(32);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await this.db
        .update(users)
        .set({
          passwordResetTokenHash: sha256Hex(rawToken),
          passwordResetExpiresAt: expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userRow.id));

      return { email: userRow.email, fullName: userRow.fullName, rawToken };
    } catch (err) {
      handleDbError(err, 'createPasswordResetToken');
    }
  }

  async resetPasswordByToken(rawToken: string, newPassword: string): Promise<void> {
    try {
      if (!rawToken) throw new StoreError(400, 'Reset token is required.');
      const pwErr = validatePasswordStrength(newPassword);
      if (pwErr) throw new StoreError(400, pwErr);

      const hash = sha256Hex(rawToken);
      const newHash = await hashPassword(newPassword);

      await this.db.transaction(async (tx) => {
        const [userRow] = await tx
          .select()
          .from(users)
          .where(eq(users.passwordResetTokenHash, hash))
          .limit(1);

        if (
          !userRow ||
          !userRow.passwordResetExpiresAt ||
          userRow.passwordResetExpiresAt.getTime() <= Date.now()
        ) {
          throw new StoreError(400, 'Password reset token is invalid or has expired.');
        }

        await tx
          .update(users)
          .set({
            passwordHash: newHash,
            passwordResetTokenHash: null,
            passwordResetExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userRow.id));

        // Revoke all existing sessions on password reset
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, userRow.id), isNull(sessions.revokedAt)));
      });
    } catch (err) {
      handleDbError(err, 'resetPasswordByToken');
    }
  }

  async createOrganization(params: {
    userId: string;
    userName: string;
    sessionId: string;
    name: string;
    countryCode?: string;
    defaultCurrency?: OrganizationSettings['defaultCurrency'];
    taxRegime?: TaxRegime;
  }): Promise<OrganizationSummary> {
    try {
      const name = String(params.name || '').trim().slice(0, 120);
      if (name.length < 2) {
        throw new StoreError(400, 'Organization name must be at least 2 characters.');
      }
      const currency = VALID_CURRENCIES.has(params.defaultCurrency || '')
        ? params.defaultCurrency!
        : 'INR';
      const taxRegime = VALID_TAX_REGIMES.has(params.taxRegime || '')
        ? params.taxRegime!
        : 'INDIA_GST';
      const countryCode = String(params.countryCode || 'IN').trim().slice(0, 8) || 'IN';

      return await this.db.transaction(async (tx) => {
        const orgId = makeId('org');
        const [org] = await tx
          .insert(organizations)
          .values({
            id: orgId,
            slug: slugifyOrgName(name),
            name,
            countryCode,
            defaultCurrency: currency,
            taxRegime,
            defaultTaxCreditable: true,
            uomAliases: { ...DEFAULT_UOM_ALIASES },
            createdByUserId: params.userId,
          })
          .returning();

        await tx.insert(organizationMemberships).values({
          id: makeId('mem'),
          organizationId: orgId,
          userId: params.userId,
          role: 'owner',
          status: 'active',
        });

        await tx
          .update(users)
          .set({ lastActiveOrgId: orgId, updatedAt: new Date() })
          .where(eq(users.id, params.userId));

        await tx
          .update(sessions)
          .set({ activeOrganizationId: orgId })
          .where(and(eq(sessions.id, params.sessionId), eq(sessions.userId, params.userId)));

        await this.appendAuditTx(tx, {
          organizationId: orgId,
          actorUserId: params.userId,
          actorName: params.userName,
          actorRole: 'owner',
          entityType: 'auth',
          entityId: orgId,
          action: 'ORGANIZATION_CREATED',
          detail: `Created organization "${name}" (${currency} · ${taxRegime}).`,
        });

        return mapOrgSummary(org, 'owner');
      });
    } catch (err) {
      handleDbError(err, 'createOrganization');
    }
  }

  async switchActiveOrganization(params: {
    sessionId: string;
    userId: string;
    organizationId: string;
  }): Promise<OrganizationSummary> {
    try {
      const [row] = await this.db
        .select({ org: organizations, membership: organizationMemberships })
        .from(organizationMemberships)
        .innerJoin(organizations, eq(organizationMemberships.organizationId, organizations.id))
        .where(
          and(
            eq(organizationMemberships.organizationId, params.organizationId),
            eq(organizationMemberships.userId, params.userId),
            eq(organizationMemberships.status, 'active')
          )
        )
        .limit(1);

      if (!row) {
        throw new StoreError(403, 'You are not an active member of the requested organization.');
      }

      await this.db.transaction(async (tx) => {
        await tx
          .update(sessions)
          .set({ activeOrganizationId: params.organizationId })
          .where(and(eq(sessions.id, params.sessionId), eq(sessions.userId, params.userId)));
        await tx
          .update(users)
          .set({ lastActiveOrgId: params.organizationId, updatedAt: new Date() })
          .where(eq(users.id, params.userId));
      });

      return mapOrgSummary(row.org, row.membership.role as UserRole);
    } catch (err) {
      handleDbError(err, 'switchActiveOrganization');
    }
  }

  async listOrganizationMembers(organizationId: string): Promise<OrganizationMember[]> {
    try {
      const rows = await this.db
        .select({
          membership: organizationMemberships,
          user: users,
        })
        .from(organizationMemberships)
        .innerJoin(users, eq(organizationMemberships.userId, users.id))
        .where(eq(organizationMemberships.organizationId, organizationId))
        .orderBy(asc(organizationMemberships.createdAt));

      return rows.map((r) => ({
        membershipId: r.membership.id,
        userId: r.user.id,
        email: r.user.email,
        fullName: r.user.fullName,
        title: r.user.title,
        role: r.membership.role as UserRole,
        status: r.membership.status as 'active' | 'suspended',
        emailVerified: r.user.emailVerified,
        createdAt: r.membership.createdAt.toISOString(),
      }));
    } catch (err) {
      handleDbError(err, 'listOrganizationMembers');
    }
  }

  async updateMemberRole(params: {
    organizationId: string;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
    targetUserId: string;
    newRole: UserRole;
  }): Promise<OrganizationMember> {
    try {
      if (!VALID_ORG_ROLES.has(params.newRole)) {
        throw new StoreError(400, 'Invalid organization role specified.');
      }

      return await this.db.transaction(async (tx) => {
        const [target] = await tx
          .select({ membership: organizationMemberships, user: users })
          .from(organizationMemberships)
          .innerJoin(users, eq(organizationMemberships.userId, users.id))
          .where(
            and(
              eq(organizationMemberships.organizationId, params.organizationId),
              eq(organizationMemberships.userId, params.targetUserId)
            )
          )
          .limit(1);

        if (!target) {
          throw new StoreError(404, 'Organization member not found.');
        }

        const currentRole = target.membership.role as UserRole;
        const permCheck = canAssignRole(params.actorRole, currentRole, params.newRole);
        if (!permCheck.allowed) {
          throw new StoreError(403, permCheck.reason || 'Insufficient permission to assign role.');
        }

        if (currentRole === 'owner' && params.newRole !== 'owner') {
          const owners = await tx
            .select({ id: organizationMemberships.id })
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.organizationId, params.organizationId),
                eq(organizationMemberships.role, 'owner'),
                eq(organizationMemberships.status, 'active')
              )
            );
          if (owners.length <= 1) {
            throw new StoreError(
              409,
              'Organization must retain at least one active owner. Promote another owner first.'
            );
          }
        }

        const [updated] = await tx
          .update(organizationMemberships)
          .set({ role: params.newRole, updatedAt: new Date() })
          .where(eq(organizationMemberships.id, target.membership.id))
          .returning();

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'membership',
          entityId: target.user.id,
          action: 'MEMBER_ROLE_UPDATED',
          detail: `Updated ${target.user.fullName} (${target.user.email}) role from ${currentRole} to ${params.newRole}.`,
        });

        return {
          membershipId: updated.id,
          userId: target.user.id,
          email: target.user.email,
          fullName: target.user.fullName,
          title: target.user.title,
          role: updated.role as UserRole,
          status: updated.status as 'active' | 'suspended',
          emailVerified: target.user.emailVerified,
          createdAt: updated.createdAt.toISOString(),
        };
      });
    } catch (err) {
      handleDbError(err, 'updateMemberRole');
    }
  }

  async removeMember(params: {
    organizationId: string;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
    targetUserId: string;
  }): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const [target] = await tx
          .select({ membership: organizationMemberships, user: users })
          .from(organizationMemberships)
          .innerJoin(users, eq(organizationMemberships.userId, users.id))
          .where(
            and(
              eq(organizationMemberships.organizationId, params.organizationId),
              eq(organizationMemberships.userId, params.targetUserId)
            )
          )
          .limit(1);

        if (!target) {
          throw new StoreError(404, 'Organization member not found.');
        }

        const targetRole = target.membership.role as UserRole;
        if (targetRole === 'owner' && params.actorRole !== 'owner') {
          throw new StoreError(403, 'Only an Owner can remove another Owner.');
        }

        if (targetRole === 'owner') {
          const owners = await tx
            .select({ id: organizationMemberships.id })
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.organizationId, params.organizationId),
                eq(organizationMemberships.role, 'owner'),
                eq(organizationMemberships.status, 'active')
              )
            );
          if (owners.length <= 1) {
            throw new StoreError(409, 'Cannot remove the last owner of an organization.');
          }
        }

        await tx
          .delete(organizationMemberships)
          .where(eq(organizationMemberships.id, target.membership.id));

        await tx
          .update(sessions)
          .set({ activeOrganizationId: null })
          .where(
            and(
              eq(sessions.userId, params.targetUserId),
              eq(sessions.activeOrganizationId, params.organizationId)
            )
          );

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'membership',
          entityId: params.targetUserId,
          action: 'MEMBER_REMOVED',
          detail: `Removed ${target.user.fullName} (${target.user.email}) from organization.`,
        });
      });
    } catch (err) {
      handleDbError(err, 'removeMember');
    }
  }

  async listInvitations(organizationId: string): Promise<OrganizationInvitation[]> {
    try {
      const rows = await this.db
        .select()
        .from(invitations)
        .where(eq(invitations.organizationId, organizationId))
        .orderBy(desc(invitations.createdAt));

      const now = Date.now();
      return rows.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        email: r.email,
        role: r.role as UserRole,
        status:
          r.status === 'pending' && r.expiresAt.getTime() <= now
            ? 'expired'
            : (r.status as OrganizationInvitation['status']),
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      }));
    } catch (err) {
      handleDbError(err, 'listInvitations');
    }
  }

  async createInvitation(params: {
    organizationId: string;
    email: string;
    role: UserRole;
    invitedByUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<{ invitation: OrganizationInvitation; rawToken: string; organizationName: string }> {
    try {
      const email = normalizeEmail(params.email);
      if (!isValidEmail(email)) {
        throw new StoreError(400, 'Please enter a valid recipient email address.');
      }
      if (!INVITABLE_ROLES.has(params.role)) {
        throw new StoreError(400, 'Invited role must be admin, buyer, approver, or viewer.');
      }

      const rawToken = generateSecureToken(24);
      const tokenHash = sha256Hex(rawToken);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      return await this.db.transaction(async (tx) => {
        const [org] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, params.organizationId))
          .limit(1);
        if (!org) throw new StoreError(404, 'Organization not found.');

        // Check if user is already an active member
        const [existingUser] = await tx
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (existingUser) {
          const [existingMem] = await tx
            .select()
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.organizationId, params.organizationId),
                eq(organizationMemberships.userId, existingUser.id)
              )
            )
            .limit(1);
          if (existingMem) {
            throw new StoreError(409, `${email} is already a member of this organization.`);
          }
        }

        // Revoke previous pending invites for same org + email
        await tx
          .update(invitations)
          .set({ status: 'revoked' })
          .where(
            and(
              eq(invitations.organizationId, params.organizationId),
              eq(invitations.email, email),
              eq(invitations.status, 'pending')
            )
          );

        const [created] = await tx
          .insert(invitations)
          .values({
            id: makeId('inv'),
            organizationId: params.organizationId,
            email,
            role: params.role,
            tokenHash,
            invitedByUserId: params.invitedByUserId,
            status: 'pending',
            expiresAt,
          })
          .returning();

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.invitedByUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'membership',
          entityId: created.id,
          action: 'INVITATION_CREATED',
          detail: `Invited ${email} to join as ${params.role}.`,
        });

        return {
          invitation: {
            id: created.id,
            organizationId: created.organizationId,
            email: created.email,
            role: created.role as UserRole,
            status: 'pending',
            expiresAt: created.expiresAt.toISOString(),
            createdAt: created.createdAt.toISOString(),
          },
          rawToken,
          organizationName: org.name,
        };
      });
    } catch (err) {
      handleDbError(err, 'createInvitation');
    }
  }

  async revokeInvitation(params: {
    organizationId: string;
    invitationId: string;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(invitations)
          .set({ status: 'revoked' })
          .where(
            and(
              eq(invitations.id, params.invitationId),
              eq(invitations.organizationId, params.organizationId),
              eq(invitations.status, 'pending')
            )
          )
          .returning();

        if (!updated) {
          throw new StoreError(404, 'Pending invitation not found.');
        }

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'membership',
          entityId: updated.id,
          action: 'INVITATION_REVOKED',
          detail: `Revoked pending invitation for ${updated.email}.`,
        });
      });
    } catch (err) {
      handleDbError(err, 'revokeInvitation');
    }
  }

  async acceptInvitation(params: {
    userId: string;
    userEmail: string;
    userName: string;
    sessionId: string;
    rawToken: string;
  }): Promise<OrganizationSummary> {
    try {
      if (!params.rawToken) {
        throw new StoreError(400, 'Invitation token is required.');
      }
      const tokenHash = sha256Hex(params.rawToken);

      return await this.db.transaction(async (tx) => {
        const [inv] = await tx
          .select()
          .from(invitations)
          .where(eq(invitations.tokenHash, tokenHash))
          .limit(1);

        if (!inv || inv.status !== 'pending' || inv.expiresAt.getTime() <= Date.now()) {
          throw new StoreError(400, 'This invitation is invalid or has expired.');
        }
        if (normalizeEmail(inv.email) !== normalizeEmail(params.userEmail)) {
          throw new StoreError(
            403,
            `This invitation was issued to ${inv.email} and cannot be accepted by ${params.userEmail}.`
          );
        }

        const [org] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, inv.organizationId))
          .limit(1);
        if (!org) throw new StoreError(404, 'Target organization no longer exists.');

        const [existingMem] = await tx
          .select()
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.organizationId, inv.organizationId),
              eq(organizationMemberships.userId, params.userId)
            )
          )
          .limit(1);

        const role = (existingMem?.role || inv.role) as UserRole;
        if (!existingMem) {
          await tx.insert(organizationMemberships).values({
            id: makeId('mem'),
            organizationId: inv.organizationId,
            userId: params.userId,
            role,
            status: 'active',
          });
        }

        await tx
          .update(invitations)
          .set({ status: 'accepted', acceptedAt: new Date() })
          .where(eq(invitations.id, inv.id));

        await tx
          .update(sessions)
          .set({ activeOrganizationId: org.id })
          .where(and(eq(sessions.id, params.sessionId), eq(sessions.userId, params.userId)));

        await tx
          .update(users)
          .set({ lastActiveOrgId: org.id, updatedAt: new Date() })
          .where(eq(users.id, params.userId));

        await this.appendAuditTx(tx, {
          organizationId: org.id,
          actorUserId: params.userId,
          actorName: params.userName,
          actorRole: role,
          entityType: 'membership',
          entityId: params.userId,
          action: 'INVITATION_ACCEPTED',
          detail: `${params.userName} (${params.userEmail}) accepted invitation as ${role}.`,
        });

        return mapOrgSummary(org, role);
      });
    } catch (err) {
      handleDbError(err, 'acceptInvitation');
    }
  }

  async loadTenantWorkspace(
    organizationId: string,
    user: AuthUser,
    activeRole: UserRole
  ): Promise<WorkspaceState> {
    try {
      const [org] = await this.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      if (!org) {
        throw new StoreError(404, 'Organization workspace not found.');
      }

      const [
        supplierRows,
        itemRows,
        priceHistRows,
        rfqRows,
        rfqItemRows,
        quoteRows,
        quoteLineRows,
        awardRows,
        allocRows,
        auditRows,
      ] = await Promise.all([
        this.db
          .select()
          .from(suppliers)
          .where(eq(suppliers.organizationId, organizationId))
          .orderBy(desc(suppliers.createdAt)),
        this.db
          .select()
          .from(catalogItems)
          .where(eq(catalogItems.organizationId, organizationId)),
        this.db
          .select()
          .from(priceHistory)
          .where(eq(priceHistory.organizationId, organizationId))
          .orderBy(desc(priceHistory.awardedAt)),
        this.db
          .select()
          .from(rfqs)
          .where(eq(rfqs.organizationId, organizationId))
          .orderBy(desc(rfqs.createdAt)),
        this.db
          .select()
          .from(rfqItems)
          .where(eq(rfqItems.organizationId, organizationId))
          .orderBy(asc(rfqItems.lineNo)),
        this.db
          .select()
          .from(quotations)
          .where(eq(quotations.organizationId, organizationId))
          .orderBy(desc(quotations.createdAt)),
        this.db
          .select()
          .from(quotationLines)
          .where(eq(quotationLines.organizationId, organizationId))
          .orderBy(asc(quotationLines.vendorLineNo)),
        this.db
          .select()
          .from(awards)
          .where(eq(awards.organizationId, organizationId))
          .orderBy(desc(awards.createdAt)),
        this.db
          .select()
          .from(awardAllocations)
          .where(eq(awardAllocations.organizationId, organizationId)),
        this.db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, organizationId))
          .orderBy(desc(auditLogs.createdAt))
          .limit(300),
      ]);

      const settings: OrganizationSettings = {
        id: org.id,
        slug: org.slug,
        name: org.name,
        countryCode: org.countryCode,
        defaultCurrency: (VALID_CURRENCIES.has(org.defaultCurrency)
          ? org.defaultCurrency
          : 'INR') as OrganizationSettings['defaultCurrency'],
        taxRegime: (VALID_TAX_REGIMES.has(org.taxRegime)
          ? org.taxRegime
          : 'INDIA_GST') as TaxRegime,
        defaultTaxCreditable: org.defaultTaxCreditable,
        uomAliases:
          org.uomAliases && Object.keys(org.uomAliases).length > 0
            ? org.uomAliases
            : { ...DEFAULT_UOM_ALIASES },
        activeUserName: user.fullName,
        activeUserTitle: user.title,
        activeUserRole: activeRole,
      };

      const histByItem = new Map<string, CatalogItem['priceHistory']>();
      for (const h of priceHistRows) {
        const list = histByItem.get(h.catalogItemId) || [];
        list.push({
          rfqId: h.rfqId,
          rfqNumber: h.rfqNumber,
          supplierId: h.supplierId,
          supplierName: h.supplierName,
          unitLandedPrice: h.unitLandedPrice,
          currency: h.currency,
          awardedAt: h.awardedAt,
        });
        histByItem.set(h.catalogItemId, list);
      }

      const itemsList: CatalogItem[] = itemRows.map((ci) => ({
        id: ci.id,
        skuCode: ci.skuCode,
        name: ci.name,
        normalizedName: ci.normalizedName,
        defaultUom: ci.defaultUom,
        hsnSacCode: ci.hsnSacCode,
        lastAwardedUnitPrice: ci.lastAwardedUnitPrice,
        lastAwardedCurrency: ci.lastAwardedCurrency,
        lastAwardedAt: ci.lastAwardedAt,
        lastSupplierId: ci.lastSupplierId,
        priceHistory: histByItem.get(ci.id) || [],
      }));

      const rfqItemsMap = new Map<string, Rfq['items']>();
      for (const it of rfqItemRows) {
        const arr = rfqItemsMap.get(it.rfqId) || [];
        arr.push({
          id: it.id,
          rfqId: it.rfqId,
          itemId: it.itemId,
          lineNo: it.lineNo,
          skuCode: it.skuCode,
          description: it.description,
          quantity: it.quantity,
          uom: it.uom,
          targetUnitPrice: it.targetUnitPrice,
        });
        rfqItemsMap.set(it.rfqId, arr);
      }

      const rfqList: Rfq[] = rfqRows.map((r) => ({
        id: r.id,
        rfqNumber: r.rfqNumber,
        title: r.title,
        status: r.status as Rfq['status'],
        currency: r.currency as Rfq['currency'],
        incoterms: r.incoterms,
        deliveryLocation: r.deliveryLocation,
        deadlineDate: r.deadlineDate,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        invitedSupplierIds: r.invitedSupplierIds || [],
        items: rfqItemsMap.get(r.id) || [],
      }));

      const linesByQuote = new Map<string, QuotationLine[]>();
      for (const l of quoteLineRows) {
        const arr = linesByQuote.get(l.quotationId) || [];
        arr.push({
          id: l.id,
          quotationId: l.quotationId,
          rfqItemId: l.rfqItemId,
          vendorLineNo: l.vendorLineNo,
          rawDescription: l.rawDescription,
          quotedQty: l.quotedQty,
          quotedUom: l.quotedUom,
          uomConversionFactor: l.uomConversionFactor,
          quotedUnitRate: l.quotedUnitRate,
          discountAmount: l.discountAmount,
          taxRatePct: l.taxRatePct,
          taxCreditable: l.taxCreditable,
          allocatedOverhead: l.allocatedOverhead,
          normalizedUnitBase: l.normalizedUnitBase,
          normalizedUnitLanded: l.normalizedUnitLanded,
          normalizedUnitGross: l.normalizedUnitGross,
          lineTotalQuoted: l.lineTotalQuoted,
          expectedLineTotal: l.expectedLineTotal,
          mathValid: l.mathValid,
          mathErrorDetail: l.mathErrorDetail,
          matchStatus: l.matchStatus as QuotationLine['matchStatus'],
          confidenceScore: l.confidenceScore,
          humanEdited: l.humanEdited,
          verifiedField: l.verifiedField,
          sourceTrace: l.sourceTrace,
        });
        linesByQuote.set(l.quotationId, arr);
      }

      const quoteList: Quotation[] = quoteRows.map((q) => ({
        id: q.id,
        rfqId: q.rfqId,
        supplierId: q.supplierId,
        documentId: q.documentId,
        documentName: q.documentName,
        documentKind: q.documentKind as Quotation['documentKind'],
        mimeType: q.mimeType,
        rawEmailText: q.rawEmailText ?? undefined,
        sheetPreview: q.sheetPreview ?? undefined,
        parseStatus: q.parseStatus as Quotation['parseStatus'],
        quoteReference: q.quoteReference,
        quoteDate: q.quoteDate,
        validUntil: q.validUntil,
        currency: q.currency as Quotation['currency'],
        exchangeRateToRfq: q.exchangeRateToRfq,
        leadTimeDays: q.leadTimeDays,
        paymentTerms: q.paymentTerms,
        freightCharges: q.freightCharges,
        packingForwarding: q.packingForwarding,
        otherCharges: q.otherCharges,
        globalDiscount: q.globalDiscount,
        taxIncludedInRates: q.taxIncludedInRates,
        missingFreightWarning: q.missingFreightWarning,
        subtotalBase: q.subtotalBase,
        totalTax: q.totalTax,
        totalLandedCost: q.totalLandedCost,
        totalGrossPayable: q.totalGrossPayable,
        completenessRatio: q.completenessRatio,
        isVerified: q.isVerified,
        verifiedBy: q.verifiedBy,
        verifiedAt: q.verifiedAt,
        headerTraces: q.headerTraces || {},
        lines: linesByQuote.get(q.id) || [],
        createdAt: q.createdAt,
      }));

      const allocByAward = new Map<string, AwardAllocation[]>();
      for (const al of allocRows) {
        const arr = allocByAward.get(al.awardId) || [];
        arr.push({
          rfqItemId: al.rfqItemId,
          quotationId: al.quotationId,
          quotationLineId: al.quotationLineId,
          supplierId: al.supplierId,
          awardedQty: al.awardedQty,
          awardedUnitLanded: al.awardedUnitLanded,
        });
        allocByAward.set(al.awardId, arr);
      }

      const awardList: AwardDecision[] = awardRows.map((a) => ({
        id: a.id,
        rfqId: a.rfqId,
        isSplitAward: a.isSplitAward,
        recommendedBy: a.recommendedBy,
        approvedBy: a.approvedBy,
        approvalStatus: a.approvalStatus as AwardDecision['approvalStatus'],
        nonL1Justification: a.nonL1Justification,
        approverNotes: a.approverNotes,
        totalAwardedLanded: a.totalAwardedLanded,
        allocations: allocByAward.get(a.id) || [],
        decidedAt: a.decidedAt,
        createdAt: a.createdAt,
      }));

      const suppliersList: Supplier[] = supplierRows.map((s) => ({
        id: s.id,
        name: s.name,
        taxId: s.taxId,
        city: s.city,
        contactName: s.contactName,
        email: s.email,
        phoneWhatsapp: s.phoneWhatsapp,
        defaultPaymentTerms: s.defaultPaymentTerms,
        categories: s.categories || [],
        createdAt: s.createdAt,
      }));

      const auditList: AuditLogEntry[] = auditRows.map((a) => ({
        id: a.id,
        actorName: a.actorName,
        actorRole: a.actorRole as UserRole,
        entityType: a.entityType as AuditLogEntry['entityType'],
        entityId: a.entityId,
        action: a.action,
        detail: a.detail,
        createdAt: a.createdAt,
      }));

      return {
        settings,
        suppliers: suppliersList,
        items: itemsList,
        rfqs: rfqList,
        quotations: quoteList,
        awards: awardList,
        auditLogs: auditList,
      };
    } catch (err) {
      handleDbError(err, 'loadTenantWorkspace');
    }
  }

  async updateOrganizationSettings(params: {
    organizationId: string;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
    patch: {
      name?: unknown;
      defaultCurrency?: unknown;
      taxRegime?: unknown;
      defaultTaxCreditable?: unknown;
    };
  }): Promise<OrganizationSettings> {
    try {
      const updates: Partial<typeof organizations.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (params.patch.name !== undefined) {
        if (typeof params.patch.name !== 'string' || !params.patch.name.trim()) {
          throw new StoreError(400, 'Organization name cannot be empty.');
        }
        updates.name = params.patch.name.trim().slice(0, 120);
      }
      if (params.patch.defaultCurrency !== undefined) {
        if (!VALID_CURRENCIES.has(String(params.patch.defaultCurrency))) {
          throw new StoreError(400, 'Unsupported currency.');
        }
        updates.defaultCurrency = String(params.patch.defaultCurrency);
      }
      if (params.patch.taxRegime !== undefined) {
        if (!VALID_TAX_REGIMES.has(String(params.patch.taxRegime))) {
          throw new StoreError(400, 'Unsupported tax regime.');
        }
        updates.taxRegime = String(params.patch.taxRegime);
      }
      if (typeof params.patch.defaultTaxCreditable === 'boolean') {
        updates.defaultTaxCreditable = params.patch.defaultTaxCreditable;
      }

      return await this.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(organizations)
          .set(updates)
          .where(eq(organizations.id, params.organizationId))
          .returning();

        if (!updated) throw new StoreError(404, 'Organization not found.');

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'settings',
          entityId: updated.id,
          action: 'SETTINGS_UPDATED',
          detail: `Updated workspace settings (${updated.name} · ${updated.defaultCurrency} · ${updated.taxRegime}).`,
        });

        return {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          countryCode: updated.countryCode,
          defaultCurrency: updated.defaultCurrency as OrganizationSettings['defaultCurrency'],
          taxRegime: updated.taxRegime as TaxRegime,
          defaultTaxCreditable: updated.defaultTaxCreditable,
          uomAliases:
            updated.uomAliases && Object.keys(updated.uomAliases).length > 0
              ? updated.uomAliases
              : { ...DEFAULT_UOM_ALIASES },
          activeUserName: params.actorName,
          activeUserTitle: '',
          activeUserRole: params.actorRole,
        };
      });
    } catch (err) {
      handleDbError(err, 'updateOrganizationSettings');
    }
  }

  private nextSequentialRfqNumber(existingRfqs: Array<{ rfqNumber: string }>): string {
    const year = new Date().getFullYear();
    let maxSeq = 42;
    for (const r of existingRfqs) {
      const m = r.rfqNumber.match(/^RFQ-\d{4}-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxSeq && n < 9000) {
          maxSeq = n;
        }
      }
    }
    return `RFQ-${year}-${String(maxSeq + 1).padStart(4, '0')}`;
  }

  async createRfq(params: {
    organizationId: string;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
    input: {
      title?: unknown;
      currency?: unknown;
      incoterms?: unknown;
      deliveryLocation?: unknown;
      deadlineDate?: unknown;
      items?: unknown;
      invitedSupplierIds?: unknown;
    };
  }): Promise<Rfq> {
    try {
      const { title, currency, incoterms, deliveryLocation, deadlineDate, items, invitedSupplierIds } =
        params.input;

      if (typeof title !== 'string' || !title.trim() || !Array.isArray(items) || items.length === 0) {
        throw new StoreError(400, 'RFQ title and at least one line item are required.');
      }

      for (const it of items) {
        if (!it || typeof it.description !== 'string' || !it.description.trim()) {
          throw new StoreError(400, 'Every RFQ item needs a description.');
        }
        const q = Number(it.quantity);
        if (!Number.isFinite(q) || q <= 0) {
          throw new StoreError(400, `Item "${it.description}" must have quantity > 0.`);
        }
        if (it.targetUnitPrice !== null && it.targetUnitPrice !== undefined && it.targetUnitPrice !== '') {
          const tp = Number(it.targetUnitPrice);
          if (!Number.isFinite(tp) || tp < 0) {
            throw new StoreError(400, 'Target unit price cannot be negative.');
          }
        }
      }

      return await this.db.transaction(async (tx) => {
        const [org] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, params.organizationId))
          .limit(1);
        if (!org) throw new StoreError(404, 'Organization not found.');

        const orgSuppliers = await tx
          .select({ id: suppliers.id })
          .from(suppliers)
          .where(eq(suppliers.organizationId, params.organizationId));
        const validSupplierSet = new Set(orgSuppliers.map((s) => s.id));
        const safeSuppliers = Array.isArray(invitedSupplierIds)
          ? invitedSupplierIds.filter(
              (id): id is string => typeof id === 'string' && validSupplierSet.has(id)
            )
          : [];

        const existingRfqs = await tx
          .select({ rfqNumber: rfqs.rfqNumber })
          .from(rfqs)
          .where(eq(rfqs.organizationId, params.organizationId));

        const orgItems = await tx
          .select()
          .from(catalogItems)
          .where(eq(catalogItems.organizationId, params.organizationId));

        const safeCurrency = VALID_CURRENCIES.has(String(currency))
          ? (String(currency) as Rfq['currency'])
          : (org.defaultCurrency as Rfq['currency']);

        const rfqId = makeId('rfq');
        const rfqNumber = this.nextSequentialRfqNumber(existingRfqs);
        const nowIso = new Date().toISOString();

        const newRfq: Rfq = {
          id: rfqId,
          rfqNumber,
          title: title.trim().slice(0, 200),
          status: 'collecting',
          currency: safeCurrency,
          incoterms:
            typeof incoterms === 'string' && incoterms.trim()
              ? incoterms.trim()
              : 'FOR Destination',
          deliveryLocation:
            typeof deliveryLocation === 'string' && deliveryLocation.trim()
              ? deliveryLocation.trim()
              : 'Main Manufacturing Plant',
          deadlineDate:
            typeof deadlineDate === 'string' && deadlineDate.trim()
              ? deadlineDate.trim()
              : new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          createdBy: params.actorName,
          createdAt: nowIso,
          updatedAt: nowIso,
          invitedSupplierIds: safeSuppliers,
          items: items.map((it, idx) => {
            const sku = typeof it.skuCode === 'string' ? it.skuCode.trim() : '';
            const desc = String(it.description).trim();
            const matchedCatalog = orgItems.find(
              (cat) =>
                (sku && cat.skuCode.toLowerCase() === sku.toLowerCase()) ||
                cat.normalizedName === desc.toLowerCase()
            );
            return {
              id: `${rfqId}-item-${idx + 1}`,
              rfqId,
              itemId: matchedCatalog?.id ?? null,
              lineNo: idx + 1,
              skuCode: sku,
              description: desc,
              quantity: Number(it.quantity),
              uom: typeof it.uom === 'string' && it.uom.trim() ? it.uom.trim() : 'pcs',
              targetUnitPrice:
                it.targetUnitPrice !== null &&
                it.targetUnitPrice !== undefined &&
                it.targetUnitPrice !== ''
                  ? Number(it.targetUnitPrice)
                  : matchedCatalog?.lastAwardedUnitPrice ?? null,
            };
          }),
        };

        await tx.insert(rfqs).values({
          id: newRfq.id,
          organizationId: params.organizationId,
          rfqNumber: newRfq.rfqNumber,
          title: newRfq.title,
          status: newRfq.status,
          currency: newRfq.currency,
          incoterms: newRfq.incoterms,
          deliveryLocation: newRfq.deliveryLocation,
          deadlineDate: newRfq.deadlineDate,
          createdBy: newRfq.createdBy,
          createdByUserId: params.actorUserId,
          invitedSupplierIds: newRfq.invitedSupplierIds,
          createdAt: newRfq.createdAt,
          updatedAt: newRfq.updatedAt,
        });

        await tx.insert(rfqItems).values(
          newRfq.items.map((it) => ({
            id: it.id,
            organizationId: params.organizationId,
            rfqId: newRfq.id,
            itemId: it.itemId,
            lineNo: it.lineNo,
            skuCode: it.skuCode,
            description: it.description,
            quantity: it.quantity,
            uom: it.uom,
            targetUnitPrice: it.targetUnitPrice,
          }))
        );

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'rfq',
          entityId: newRfq.id,
          action: 'RFQ_CREATED',
          detail: `Created ${newRfq.rfqNumber} (${newRfq.title}) with ${newRfq.items.length} line items.`,
        });

        return newRfq;
      });
    } catch (err) {
      handleDbError(err, 'createRfq');
    }
  }

  async loadSampleRfq(params: {
    organizationId: string;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<{ rfq: Rfq; quotes: Quotation[] }> {
    try {
      const suffix = `${params.organizationId.slice(-5)}-${String(Date.now()).slice(-4)}`;
      const sample = createSampleRfqAndQuotes(suffix);

      return await this.db.transaction(async (tx) => {
        const orgSuppliers = await tx
          .select()
          .from(suppliers)
          .where(eq(suppliers.organizationId, params.organizationId));

        const defaultTemplates: Array<{
          key: string;
          name: string;
          taxId: string;
          city: string;
          contactName: string;
          email: string;
          phoneWhatsapp: string;
          defaultPaymentTerms: string;
          categories: string[];
        }> = [
          {
            key: 'sup-ganesh',
            name: 'Shree Ganesh Precision Works',
            taxId: '27AABCS4821M1Z5',
            city: 'Pune, MH',
            contactName: 'Suresh Kulkarni',
            email: 'quotes@shreeganeshprecision.in',
            phoneWhatsapp: '+91 98220 44120',
            defaultPaymentTerms: 'Net 30 Days',
            categories: ['CNC Machining', 'Manifolds', 'Hydraulic Fittings'],
          },
          {
            key: 'sup-bharat',
            name: 'Bharat Industrial Fasteners Pvt. Ltd.',
            taxId: '24AAACB7732R1Z9',
            city: 'Rajkot, GJ',
            contactName: 'Kiran Patel',
            email: 'sales@bharatfasteners.co.in',
            phoneWhatsapp: '+91 98980 71204',
            defaultPaymentTerms: '50% Advance',
            categories: ['Fasteners', 'SS Hardware', 'Seals'],
          },
          {
            key: 'sup-apex',
            name: 'Apex Alloys & Hardware',
            taxId: '27AADCA9104K1Z2',
            city: 'Mumbai, MH',
            contactName: 'Vikram Mehta',
            email: 'vikram@apexalloys.in',
            phoneWhatsapp: '+91 98201 33981',
            defaultPaymentTerms: 'Net 45 Days',
            categories: ['SS304/316', 'Instrumentation', 'Fasteners'],
          },
        ];

        const supplierIdMap = new Map<string, string>();
        for (const tpl of defaultTemplates) {
          const existing = orgSuppliers.find(
            (s) =>
              s.id === tpl.key ||
              s.name.toLowerCase() === tpl.name.toLowerCase() ||
              (s.taxId && s.taxId === tpl.taxId)
          );
          if (existing) {
            supplierIdMap.set(tpl.key, existing.id);
          } else {
            const newSupId = makeId('sup');
            await tx.insert(suppliers).values({
              id: newSupId,
              organizationId: params.organizationId,
              name: tpl.name,
              taxId: tpl.taxId,
              city: tpl.city,
              contactName: tpl.contactName,
              email: tpl.email,
              phoneWhatsapp: tpl.phoneWhatsapp,
              defaultPaymentTerms: tpl.defaultPaymentTerms,
              categories: tpl.categories,
              createdAt: new Date().toISOString(),
            });
            supplierIdMap.set(tpl.key, newSupId);
          }
        }

        const existingItems = await tx
          .select()
          .from(catalogItems)
          .where(eq(catalogItems.organizationId, params.organizationId));
        const validItemIds = new Set(existingItems.map((i) => i.id));

        const rfq: Rfq = {
          ...sample.rfq,
          createdBy: params.actorName,
          invitedSupplierIds: sample.rfq.invitedSupplierIds.map(
            (id) => supplierIdMap.get(id) || id
          ),
          items: sample.rfq.items.map((it) => ({
            ...it,
            itemId: it.itemId && validItemIds.has(it.itemId) ? it.itemId : null,
          })),
        };

        const quotes: Quotation[] = sample.quotes.map((q) => ({
          ...q,
          supplierId: supplierIdMap.get(q.supplierId) || q.supplierId,
        }));

        await tx.insert(rfqs).values({
          id: rfq.id,
          organizationId: params.organizationId,
          rfqNumber: rfq.rfqNumber,
          title: rfq.title,
          status: rfq.status,
          currency: rfq.currency,
          incoterms: rfq.incoterms,
          deliveryLocation: rfq.deliveryLocation,
          deadlineDate: rfq.deadlineDate,
          createdBy: rfq.createdBy,
          createdByUserId: params.actorUserId,
          invitedSupplierIds: rfq.invitedSupplierIds,
          createdAt: rfq.createdAt,
          updatedAt: rfq.updatedAt,
        });

        await tx.insert(rfqItems).values(
          rfq.items.map((it) => ({
            id: it.id,
            organizationId: params.organizationId,
            rfqId: rfq.id,
            itemId: it.itemId,
            lineNo: it.lineNo,
            skuCode: it.skuCode,
            description: it.description,
            quantity: it.quantity,
            uom: it.uom,
            targetUnitPrice: it.targetUnitPrice,
          }))
        );

        for (const q of quotes) {
          await tx.insert(quotations).values({
            id: q.id,
            organizationId: params.organizationId,
            rfqId: rfq.id,
            supplierId: q.supplierId,
            documentId: null,
            documentName: q.documentName,
            documentKind: q.documentKind,
            mimeType: q.mimeType,
            rawEmailText: q.rawEmailText ?? null,
            sheetPreview: q.sheetPreview ?? null,
            parseStatus: q.parseStatus,
            quoteReference: q.quoteReference,
            quoteDate: q.quoteDate,
            validUntil: q.validUntil,
            currency: q.currency,
            exchangeRateToRfq: q.exchangeRateToRfq,
            leadTimeDays: q.leadTimeDays,
            paymentTerms: q.paymentTerms,
            freightCharges: q.freightCharges,
            packingForwarding: q.packingForwarding,
            otherCharges: q.otherCharges,
            globalDiscount: q.globalDiscount,
            taxIncludedInRates: q.taxIncludedInRates,
            missingFreightWarning: q.missingFreightWarning,
            subtotalBase: q.subtotalBase,
            totalTax: q.totalTax,
            totalLandedCost: q.totalLandedCost,
            totalGrossPayable: q.totalGrossPayable,
            completenessRatio: q.completenessRatio,
            isVerified: q.isVerified,
            verifiedBy: q.verifiedBy,
            verifiedAt: q.verifiedAt,
            headerTraces: q.headerTraces,
            createdAt: q.createdAt,
          });

          if (q.lines.length > 0) {
            await tx.insert(quotationLines).values(
              q.lines.map((l) => ({
                id: l.id,
                organizationId: params.organizationId,
                quotationId: q.id,
                rfqItemId: l.rfqItemId,
                vendorLineNo: l.vendorLineNo,
                rawDescription: l.rawDescription,
                quotedQty: l.quotedQty,
                quotedUom: l.quotedUom,
                uomConversionFactor: l.uomConversionFactor,
                quotedUnitRate: l.quotedUnitRate,
                discountAmount: l.discountAmount,
                taxRatePct: l.taxRatePct,
                taxCreditable: l.taxCreditable,
                allocatedOverhead: l.allocatedOverhead,
                normalizedUnitBase: l.normalizedUnitBase,
                normalizedUnitLanded: l.normalizedUnitLanded,
                normalizedUnitGross: l.normalizedUnitGross,
                lineTotalQuoted: l.lineTotalQuoted,
                expectedLineTotal: l.expectedLineTotal,
                mathValid: l.mathValid,
                mathErrorDetail: l.mathErrorDetail,
                matchStatus: l.matchStatus,
                confidenceScore: l.confidenceScore,
                humanEdited: l.humanEdited,
                verifiedField: l.verifiedField,
                sourceTrace: l.sourceTrace,
              }))
            );
          }
        }

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'rfq',
          entityId: rfq.id,
          action: 'SAMPLE_RFQ_LOADED',
          detail: `Loaded sample RFQ ${rfq.rfqNumber} with 3 multi-format supplier quotes.`,
        });

        return { rfq, quotes };
      });
    } catch (err) {
      handleDbError(err, 'loadSampleRfq');
    }
  }

  async createSupplier(params: {
    organizationId: string;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
    input: {
      name?: unknown;
      taxId?: unknown;
      city?: unknown;
      contactName?: unknown;
      email?: unknown;
      phoneWhatsapp?: unknown;
      defaultPaymentTerms?: unknown;
      categories?: unknown;
    };
  }): Promise<Supplier> {
    try {
      const { name, taxId, city, contactName, email, phoneWhatsapp, defaultPaymentTerms, categories } =
        params.input;
      if (typeof name !== 'string' || !name.trim()) {
        throw new StoreError(400, 'Supplier name is required.');
      }
      const trimmedName = name.trim();
      const trimmedTaxId = typeof taxId === 'string' ? taxId.trim() : '';

      return await this.db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(suppliers)
          .where(eq(suppliers.organizationId, params.organizationId));

        const duplicate = existing.find(
          (s) =>
            s.name.toLowerCase() === trimmedName.toLowerCase() ||
            (trimmedTaxId && s.taxId && s.taxId.toLowerCase() === trimmedTaxId.toLowerCase())
        );
        if (duplicate) {
          throw new StoreError(
            409,
            `Duplicate supplier detected: "${duplicate.name}" matches this name or Tax ID/GSTIN.`
          );
        }

        const supplier: Supplier = {
          id: makeId('sup'),
          name: trimmedName,
          taxId: trimmedTaxId,
          city: typeof city === 'string' ? city.trim() : '',
          contactName: typeof contactName === 'string' ? contactName.trim() : '',
          email: typeof email === 'string' ? email.trim() : '',
          phoneWhatsapp: typeof phoneWhatsapp === 'string' ? phoneWhatsapp.trim() : '',
          defaultPaymentTerms:
            typeof defaultPaymentTerms === 'string' && defaultPaymentTerms.trim()
              ? defaultPaymentTerms.trim()
              : 'Net 30 Days',
          categories: Array.isArray(categories)
            ? categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            : [],
          createdAt: new Date().toISOString(),
        };

        await tx.insert(suppliers).values({
          id: supplier.id,
          organizationId: params.organizationId,
          name: supplier.name,
          taxId: supplier.taxId,
          city: supplier.city,
          contactName: supplier.contactName,
          email: supplier.email,
          phoneWhatsapp: supplier.phoneWhatsapp,
          defaultPaymentTerms: supplier.defaultPaymentTerms,
          categories: supplier.categories,
          createdAt: supplier.createdAt,
        });

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'supplier',
          entityId: supplier.id,
          action: 'SUPPLIER_CREATED',
          detail: `Added supplier ${supplier.name} (${supplier.taxId || 'No Tax ID'}).`,
        });

        return supplier;
      });
    } catch (err) {
      handleDbError(err, 'createSupplier');
    }
  }

  async createCatalogItem(params: {
    organizationId: string;
    input: { skuCode?: unknown; name?: unknown; defaultUom?: unknown; hsnSacCode?: unknown };
  }): Promise<CatalogItem> {
    try {
      const { skuCode, name, defaultUom, hsnSacCode } = params.input;
      if (typeof name !== 'string' || !name.trim()) {
        throw new StoreError(400, 'Item name is required.');
      }

      const item: CatalogItem = {
        id: makeId('item'),
        skuCode: typeof skuCode === 'string' ? skuCode.trim() : '',
        name: name.trim(),
        normalizedName: name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim(),
        defaultUom: typeof defaultUom === 'string' && defaultUom.trim() ? defaultUom.trim() : 'pcs',
        hsnSacCode: typeof hsnSacCode === 'string' ? hsnSacCode.trim() : '',
        lastAwardedUnitPrice: null,
        lastAwardedCurrency: null,
        lastAwardedAt: null,
        lastSupplierId: null,
        priceHistory: [],
      };

      await this.db.insert(catalogItems).values({
        id: item.id,
        organizationId: params.organizationId,
        skuCode: item.skuCode,
        name: item.name,
        normalizedName: item.normalizedName,
        defaultUom: item.defaultUom,
        hsnSacCode: item.hsnSacCode,
        lastAwardedUnitPrice: null,
        lastAwardedCurrency: null,
        lastAwardedAt: null,
        lastSupplierId: null,
      });

      return item;
    } catch (err) {
      handleDbError(err, 'createCatalogItem');
    }
  }

  async getExtractionContext(params: {
    organizationId: string;
    rfqId: string;
    supplierId: string;
  }): Promise<{ rfq: Rfq; settings: OrganizationSettings; supplierName: string }> {
    try {
      const [org] = await this.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, params.organizationId))
        .limit(1);
      if (!org) throw new StoreError(404, 'Organization not found.');

      const [rfqRow] = await this.db
        .select()
        .from(rfqs)
        .where(and(eq(rfqs.id, params.rfqId), eq(rfqs.organizationId, params.organizationId)))
        .limit(1);
      if (!rfqRow) throw new StoreError(404, 'RFQ not found.');

      const [supRow] = await this.db
        .select()
        .from(suppliers)
        .where(
          and(
            eq(suppliers.id, params.supplierId),
            eq(suppliers.organizationId, params.organizationId)
          )
        )
        .limit(1);
      if (!supRow) throw new StoreError(400, 'Valid supplierId is required.');

      const itemRows = await this.db
        .select()
        .from(rfqItems)
        .where(
          and(eq(rfqItems.rfqId, rfqRow.id), eq(rfqItems.organizationId, params.organizationId))
        )
        .orderBy(asc(rfqItems.lineNo));

      const rfq: Rfq = {
        id: rfqRow.id,
        rfqNumber: rfqRow.rfqNumber,
        title: rfqRow.title,
        status: rfqRow.status as Rfq['status'],
        currency: rfqRow.currency as Rfq['currency'],
        incoterms: rfqRow.incoterms,
        deliveryLocation: rfqRow.deliveryLocation,
        deadlineDate: rfqRow.deadlineDate,
        createdBy: rfqRow.createdBy,
        createdAt: rfqRow.createdAt,
        updatedAt: rfqRow.updatedAt,
        invitedSupplierIds: rfqRow.invitedSupplierIds || [],
        items: itemRows.map((it) => ({
          id: it.id,
          rfqId: it.rfqId,
          itemId: it.itemId,
          lineNo: it.lineNo,
          skuCode: it.skuCode,
          description: it.description,
          quantity: it.quantity,
          uom: it.uom,
          targetUnitPrice: it.targetUnitPrice,
        })),
      };

      const settings: OrganizationSettings = {
        id: org.id,
        slug: org.slug,
        name: org.name,
        countryCode: org.countryCode,
        defaultCurrency: org.defaultCurrency as OrganizationSettings['defaultCurrency'],
        taxRegime: org.taxRegime as TaxRegime,
        defaultTaxCreditable: org.defaultTaxCreditable,
        uomAliases:
          org.uomAliases && Object.keys(org.uomAliases).length > 0
            ? org.uomAliases
            : { ...DEFAULT_UOM_ALIASES },
        activeUserName: '',
        activeUserTitle: '',
        activeUserRole: 'buyer',
      };

      return { rfq, settings, supplierName: supRow.name };
    } catch (err) {
      handleDbError(err, 'getExtractionContext');
    }
  }

  async saveExtractedQuotation(params: {
    organizationId: string;
    rfqId: string;
    supplierName: string;
    quotation: Quotation;
    storedDoc?: StoredDocumentRecord | null;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Quotation> {
    try {
      return await this.db.transaction(async (tx) => {
        const [targetRfq] = await tx
          .select()
          .from(rfqs)
          .where(and(eq(rfqs.id, params.rfqId), eq(rfqs.organizationId, params.organizationId)))
          .limit(1);

        if (!targetRfq) {
          throw new StoreError(404, 'RFQ was removed while extracting.');
        }

        if (params.storedDoc) {
          await tx.insert(storedDocuments).values({
            id: params.storedDoc.id,
            organizationId: params.organizationId,
            uploadedByUserId: params.actorUserId,
            storageProvider: params.storedDoc.storageProvider,
            storageKey: params.storedDoc.storageKey,
            originalFilename: params.storedDoc.originalFilename,
            mimeType: params.storedDoc.mimeType,
            byteSize: params.storedDoc.byteSize,
            sha256: params.storedDoc.sha256,
            createdAt: params.storedDoc.createdAt,
          });
        }

        const q = {
          ...params.quotation,
          documentId: params.storedDoc?.id ?? null,
          fileDataUrl: undefined,
        };

        await tx.insert(quotations).values({
          id: q.id,
          organizationId: params.organizationId,
          rfqId: q.rfqId,
          supplierId: q.supplierId,
          documentId: q.documentId,
          documentName: q.documentName,
          documentKind: q.documentKind,
          mimeType: q.mimeType,
          rawEmailText: q.rawEmailText ?? null,
          sheetPreview: q.sheetPreview ?? null,
          parseStatus: q.parseStatus,
          quoteReference: q.quoteReference,
          quoteDate: q.quoteDate,
          validUntil: q.validUntil,
          currency: q.currency,
          exchangeRateToRfq: q.exchangeRateToRfq,
          leadTimeDays: q.leadTimeDays,
          paymentTerms: q.paymentTerms,
          freightCharges: q.freightCharges,
          packingForwarding: q.packingForwarding,
          otherCharges: q.otherCharges,
          globalDiscount: q.globalDiscount,
          taxIncludedInRates: q.taxIncludedInRates,
          missingFreightWarning: q.missingFreightWarning,
          subtotalBase: q.subtotalBase,
          totalTax: q.totalTax,
          totalLandedCost: q.totalLandedCost,
          totalGrossPayable: q.totalGrossPayable,
          completenessRatio: q.completenessRatio,
          isVerified: q.isVerified,
          verifiedBy: q.verifiedBy,
          verifiedAt: q.verifiedAt,
          headerTraces: q.headerTraces,
          createdAt: q.createdAt,
        });

        if (q.lines.length > 0) {
          await tx.insert(quotationLines).values(
            q.lines.map((l) => ({
              id: l.id,
              organizationId: params.organizationId,
              quotationId: q.id,
              rfqItemId: l.rfqItemId,
              vendorLineNo: l.vendorLineNo,
              rawDescription: l.rawDescription,
              quotedQty: l.quotedQty,
              quotedUom: l.quotedUom,
              uomConversionFactor: l.uomConversionFactor,
              quotedUnitRate: l.quotedUnitRate,
              discountAmount: l.discountAmount,
              taxRatePct: l.taxRatePct,
              taxCreditable: l.taxCreditable,
              allocatedOverhead: l.allocatedOverhead,
              normalizedUnitBase: l.normalizedUnitBase,
              normalizedUnitLanded: l.normalizedUnitLanded,
              normalizedUnitGross: l.normalizedUnitGross,
              lineTotalQuoted: l.lineTotalQuoted,
              expectedLineTotal: l.expectedLineTotal,
              mathValid: l.mathValid,
              mathErrorDetail: l.mathErrorDetail,
              matchStatus: l.matchStatus,
              confidenceScore: l.confidenceScore,
              humanEdited: l.humanEdited,
              verifiedField: l.verifiedField,
              sourceTrace: l.sourceTrace,
            }))
          );
        }

        if (targetRfq.status === 'draft' || targetRfq.status === 'collecting') {
          await tx
            .update(rfqs)
            .set({ status: 'in_review', updatedAt: new Date().toISOString() })
            .where(
              and(eq(rfqs.id, targetRfq.id), eq(rfqs.organizationId, params.organizationId))
            );
        }

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'quotation',
          entityId: q.id,
          action: 'QUOTATION_EXTRACTED',
          detail: `Extracted ${q.lines.length} lines from ${q.documentName} (${params.supplierName}) for ${targetRfq.rfqNumber}.`,
        });

        return q;
      });
    } catch (err) {
      handleDbError(err, 'saveExtractedQuotation');
    }
  }

  private async loadQuotationWithRfqTx(
    tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0],
    organizationId: string,
    quoteId: string
  ): Promise<{ quote: Quotation; rfq: Rfq }> {
    const [qRow] = await tx
      .select()
      .from(quotations)
      .where(and(eq(quotations.id, quoteId), eq(quotations.organizationId, organizationId)))
      .limit(1);
    if (!qRow) throw new StoreError(404, 'Quotation not found.');

    const [rfqRow] = await tx
      .select()
      .from(rfqs)
      .where(and(eq(rfqs.id, qRow.rfqId), eq(rfqs.organizationId, organizationId)))
      .limit(1);
    if (!rfqRow) throw new StoreError(404, 'Parent RFQ not found.');

    const rItems = await tx
      .select()
      .from(rfqItems)
      .where(and(eq(rfqItems.rfqId, rfqRow.id), eq(rfqItems.organizationId, organizationId)))
      .orderBy(asc(rfqItems.lineNo));
    const qLines = await tx
      .select()
      .from(quotationLines)
      .where(
        and(
          eq(quotationLines.quotationId, qRow.id),
          eq(quotationLines.organizationId, organizationId)
        )
      )
      .orderBy(asc(quotationLines.vendorLineNo));

    const rfq: Rfq = {
      id: rfqRow.id,
      rfqNumber: rfqRow.rfqNumber,
      title: rfqRow.title,
      status: rfqRow.status as Rfq['status'],
      currency: rfqRow.currency as Rfq['currency'],
      incoterms: rfqRow.incoterms,
      deliveryLocation: rfqRow.deliveryLocation,
      deadlineDate: rfqRow.deadlineDate,
      createdBy: rfqRow.createdBy,
      createdAt: rfqRow.createdAt,
      updatedAt: rfqRow.updatedAt,
      invitedSupplierIds: rfqRow.invitedSupplierIds || [],
      items: rItems.map((it) => ({
        id: it.id,
        rfqId: it.rfqId,
        itemId: it.itemId,
        lineNo: it.lineNo,
        skuCode: it.skuCode,
        description: it.description,
        quantity: it.quantity,
        uom: it.uom,
        targetUnitPrice: it.targetUnitPrice,
      })),
    };

    const quote: Quotation = {
      id: qRow.id,
      rfqId: qRow.rfqId,
      supplierId: qRow.supplierId,
      documentId: qRow.documentId,
      documentName: qRow.documentName,
      documentKind: qRow.documentKind as Quotation['documentKind'],
      mimeType: qRow.mimeType,
      rawEmailText: qRow.rawEmailText ?? undefined,
      sheetPreview: qRow.sheetPreview ?? undefined,
      parseStatus: qRow.parseStatus as Quotation['parseStatus'],
      quoteReference: qRow.quoteReference,
      quoteDate: qRow.quoteDate,
      validUntil: qRow.validUntil,
      currency: qRow.currency as Quotation['currency'],
      exchangeRateToRfq: qRow.exchangeRateToRfq,
      leadTimeDays: qRow.leadTimeDays,
      paymentTerms: qRow.paymentTerms,
      freightCharges: qRow.freightCharges,
      packingForwarding: qRow.packingForwarding,
      otherCharges: qRow.otherCharges,
      globalDiscount: qRow.globalDiscount,
      taxIncludedInRates: qRow.taxIncludedInRates,
      missingFreightWarning: qRow.missingFreightWarning,
      subtotalBase: qRow.subtotalBase,
      totalTax: qRow.totalTax,
      totalLandedCost: qRow.totalLandedCost,
      totalGrossPayable: qRow.totalGrossPayable,
      completenessRatio: qRow.completenessRatio,
      isVerified: qRow.isVerified,
      verifiedBy: qRow.verifiedBy,
      verifiedAt: qRow.verifiedAt,
      headerTraces: qRow.headerTraces || {},
      createdAt: qRow.createdAt,
      lines: qLines.map((l) => ({
        id: l.id,
        quotationId: l.quotationId,
        rfqItemId: l.rfqItemId,
        vendorLineNo: l.vendorLineNo,
        rawDescription: l.rawDescription,
        quotedQty: l.quotedQty,
        quotedUom: l.quotedUom,
        uomConversionFactor: l.uomConversionFactor,
        quotedUnitRate: l.quotedUnitRate,
        discountAmount: l.discountAmount,
        taxRatePct: l.taxRatePct,
        taxCreditable: l.taxCreditable,
        allocatedOverhead: l.allocatedOverhead,
        normalizedUnitBase: l.normalizedUnitBase,
        normalizedUnitLanded: l.normalizedUnitLanded,
        normalizedUnitGross: l.normalizedUnitGross,
        lineTotalQuoted: l.lineTotalQuoted,
        expectedLineTotal: l.expectedLineTotal,
        mathValid: l.mathValid,
        mathErrorDetail: l.mathErrorDetail,
        matchStatus: l.matchStatus as QuotationLine['matchStatus'],
        confidenceScore: l.confidenceScore,
        humanEdited: l.humanEdited,
        verifiedField: l.verifiedField,
        sourceTrace: l.sourceTrace,
      })),
    };

    return { quote, rfq };
  }

  private async persistRecomputedQuotationTx(
    tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0],
    organizationId: string,
    q: Quotation
  ): Promise<void> {
    await tx
      .update(quotations)
      .set({
        quoteReference: q.quoteReference,
        leadTimeDays: q.leadTimeDays,
        paymentTerms: q.paymentTerms,
        freightCharges: q.freightCharges,
        packingForwarding: q.packingForwarding,
        otherCharges: q.otherCharges,
        globalDiscount: q.globalDiscount,
        taxIncludedInRates: q.taxIncludedInRates,
        missingFreightWarning: q.missingFreightWarning,
        exchangeRateToRfq: q.exchangeRateToRfq,
        validUntil: q.validUntil,
        parseStatus: q.parseStatus,
        subtotalBase: q.subtotalBase,
        totalTax: q.totalTax,
        totalLandedCost: q.totalLandedCost,
        totalGrossPayable: q.totalGrossPayable,
        completenessRatio: q.completenessRatio,
        isVerified: q.isVerified,
        verifiedBy: q.verifiedBy,
        verifiedAt: q.verifiedAt,
      })
      .where(and(eq(quotations.id, q.id), eq(quotations.organizationId, organizationId)));

    for (const l of q.lines) {
      await tx
        .update(quotationLines)
        .set({
          rfqItemId: l.rfqItemId,
          matchStatus: l.matchStatus,
          quotedQty: l.quotedQty,
          quotedUnitRate: l.quotedUnitRate,
          uomConversionFactor: l.uomConversionFactor,
          taxRatePct: l.taxRatePct,
          taxCreditable: l.taxCreditable,
          discountAmount: l.discountAmount,
          lineTotalQuoted: l.lineTotalQuoted,
          expectedLineTotal: l.expectedLineTotal,
          allocatedOverhead: l.allocatedOverhead,
          normalizedUnitBase: l.normalizedUnitBase,
          normalizedUnitLanded: l.normalizedUnitLanded,
          normalizedUnitGross: l.normalizedUnitGross,
          mathValid: l.mathValid,
          mathErrorDetail: l.mathErrorDetail,
          humanEdited: l.humanEdited,
          verifiedField: l.verifiedField,
        })
        .where(
          and(
            eq(quotationLines.id, l.id),
            eq(quotationLines.quotationId, q.id),
            eq(quotationLines.organizationId, organizationId)
          )
        );
    }
  }

  async updateQuotationHeader(params: {
    organizationId: string;
    quoteId: string;
    body: Record<string, unknown>;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Quotation> {
    try {
      const body = params.body;
      for (const numField of [
        'freightCharges',
        'packingForwarding',
        'otherCharges',
        'globalDiscount',
      ] as const) {
        if (body[numField] !== undefined && !isNonNegativeFinite(body[numField])) {
          throw new StoreError(400, `${numField} must be a non-negative finite number.`);
        }
      }
      if (body.exchangeRateToRfq !== undefined && !isPositiveFinite(body.exchangeRateToRfq)) {
        throw new StoreError(400, 'exchangeRateToRfq must be greater than 0.');
      }
      if (
        body.leadTimeDays !== undefined &&
        body.leadTimeDays !== null &&
        (!Number.isFinite(body.leadTimeDays) || Number(body.leadTimeDays) < 0)
      ) {
        throw new StoreError(400, 'leadTimeDays cannot be negative.');
      }

      return await this.db.transaction(async (tx) => {
        const { quote, rfq } = await this.loadQuotationWithRfqTx(
          tx,
          params.organizationId,
          params.quoteId
        );

        const updated: Quotation = { ...quote, isVerified: false };
        if (body.quoteReference !== undefined) {
          updated.quoteReference = String(body.quoteReference).trim();
        }
        if (body.leadTimeDays !== undefined) {
          updated.leadTimeDays = body.leadTimeDays as number | null;
        }
        if (body.paymentTerms !== undefined) {
          updated.paymentTerms = body.paymentTerms as string | null;
        }
        if (body.freightCharges !== undefined) {
          updated.freightCharges = body.freightCharges as number;
        }
        if (body.packingForwarding !== undefined) {
          updated.packingForwarding = body.packingForwarding as number;
        }
        if (body.otherCharges !== undefined) {
          updated.otherCharges = body.otherCharges as number;
        }
        if (body.globalDiscount !== undefined) {
          updated.globalDiscount = body.globalDiscount as number;
        }
        if (body.taxIncludedInRates !== undefined) {
          updated.taxIncludedInRates = Boolean(body.taxIncludedInRates);
        }
        if (body.missingFreightWarning !== undefined) {
          updated.missingFreightWarning = Boolean(body.missingFreightWarning);
        }
        if (body.exchangeRateToRfq !== undefined) {
          updated.exchangeRateToRfq = body.exchangeRateToRfq as number;
        }
        if (body.validUntil !== undefined) {
          updated.validUntil = body.validUntil as string | null;
        }

        const recomputed = recomputeQuotation(updated, rfq);
        await this.persistRecomputedQuotationTx(tx, params.organizationId, recomputed);

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'quotation',
          entityId: quote.id,
          action: 'QUOTATION_HEADER_EDITED',
          detail: `Updated commercial terms on ${quote.quoteReference} (Freight: ${recomputed.freightCharges}, P&F: ${recomputed.packingForwarding}, FX: ${recomputed.exchangeRateToRfq}).`,
        });

        return recomputed;
      });
    } catch (err) {
      handleDbError(err, 'updateQuotationHeader');
    }
  }

  async updateQuotationLine(params: {
    organizationId: string;
    quoteId: string;
    lineId: string;
    body: Record<string, unknown>;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Quotation> {
    try {
      const body = params.body;
      if (
        body.quotedQty !== undefined &&
        body.quotedQty !== null &&
        !isPositiveFinite(body.quotedQty)
      ) {
        throw new StoreError(400, 'quotedQty must be greater than 0.');
      }
      if (
        body.quotedUnitRate !== undefined &&
        body.quotedUnitRate !== null &&
        !isNonNegativeFinite(body.quotedUnitRate)
      ) {
        throw new StoreError(400, 'quotedUnitRate cannot be negative.');
      }
      if (
        body.uomConversionFactor !== undefined &&
        !isPositiveFinite(body.uomConversionFactor)
      ) {
        throw new StoreError(400, 'uomConversionFactor must be greater than 0.');
      }
      if (
        body.taxRatePct !== undefined &&
        (!isNonNegativeFinite(body.taxRatePct) || Number(body.taxRatePct) > 100)
      ) {
        throw new StoreError(400, 'taxRatePct must be between 0 and 100.');
      }
      if (body.discountAmount !== undefined && !isNonNegativeFinite(body.discountAmount)) {
        throw new StoreError(400, 'discountAmount cannot be negative.');
      }
      if (
        body.lineTotalQuoted !== undefined &&
        body.lineTotalQuoted !== null &&
        !isNonNegativeFinite(body.lineTotalQuoted)
      ) {
        throw new StoreError(400, 'lineTotalQuoted cannot be negative.');
      }

      return await this.db.transaction(async (tx) => {
        const { quote, rfq } = await this.loadQuotationWithRfqTx(
          tx,
          params.organizationId,
          params.quoteId
        );

        const lineIndex = quote.lines.findIndex((l) => l.id === params.lineId);
        if (lineIndex === -1) throw new StoreError(404, 'Quotation line not found.');

        if (body.rfqItemId !== undefined && body.rfqItemId !== null) {
          if (!rfq.items.some((it) => it.id === body.rfqItemId)) {
            throw new StoreError(400, 'rfqItemId does not belong to this RFQ.');
          }
        }

        const prevLine = quote.lines[lineIndex];
        const updatedLine: QuotationLine = {
          ...prevLine,
          ...(body.rfqItemId !== undefined ? { rfqItemId: body.rfqItemId as string | null } : {}),
          ...(body.matchStatus !== undefined
            ? { matchStatus: body.matchStatus as QuotationLine['matchStatus'] }
            : {}),
          ...(body.quotedQty !== undefined ? { quotedQty: body.quotedQty as number | null } : {}),
          ...(body.quotedUnitRate !== undefined
            ? { quotedUnitRate: body.quotedUnitRate as number | null }
            : {}),
          ...(body.uomConversionFactor !== undefined
            ? { uomConversionFactor: body.uomConversionFactor as number }
            : {}),
          ...(body.taxRatePct !== undefined ? { taxRatePct: body.taxRatePct as number } : {}),
          ...(body.taxCreditable !== undefined
            ? { taxCreditable: Boolean(body.taxCreditable) }
            : {}),
          ...(body.discountAmount !== undefined
            ? { discountAmount: body.discountAmount as number }
            : {}),
          ...(body.lineTotalQuoted !== undefined
            ? { lineTotalQuoted: body.lineTotalQuoted as number | null }
            : {}),
          humanEdited: true,
          verifiedField: typeof body.verifiedField === 'boolean' ? body.verifiedField : true,
        };

        const nextQuote: Quotation = {
          ...quote,
          isVerified: false,
          lines: quote.lines.map((l, idx) => (idx === lineIndex ? updatedLine : l)),
        };

        const recomputed = recomputeQuotation(nextQuote, rfq);
        await this.persistRecomputedQuotationTx(tx, params.organizationId, recomputed);

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'quotation_line',
          entityId: prevLine.id,
          action: 'LINE_HUMAN_OVERRIDE',
          detail: `Edited line "${prevLine.rawDescription}" on ${quote.quoteReference}: rate ${prevLine.quotedUnitRate} -> ${updatedLine.quotedUnitRate}, UOM factor ${prevLine.uomConversionFactor} -> ${updatedLine.uomConversionFactor}.`,
        });

        return recomputed;
      });
    } catch (err) {
      handleDbError(err, 'updateQuotationLine');
    }
  }

  async verifyQuotation(params: {
    organizationId: string;
    quoteId: string;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Quotation> {
    try {
      return await this.db.transaction(async (tx) => {
        const { quote, rfq } = await this.loadQuotationWithRfqTx(
          tx,
          params.organizationId,
          params.quoteId
        );

        const recomputedPre = recomputeQuotation(quote, rfq);
        const unresolvedMath = recomputedPre.lines.filter((l) => !l.mathValid);
        if (unresolvedMath.length > 0) {
          throw new StoreError(
            422,
            `Cannot verify quotation: ${unresolvedMath.length} line item(s) still have unresolved arithmetic mismatches.`
          );
        }

        const verifiedQuote = recomputeQuotation(
          {
            ...recomputedPre,
            isVerified: true,
            parseStatus: 'verified',
            verifiedBy: params.actorName,
            verifiedAt: new Date().toISOString(),
            lines: recomputedPre.lines.map((l) => ({ ...l, verifiedField: true })),
          },
          rfq
        );

        await this.persistRecomputedQuotationTx(tx, params.organizationId, verifiedQuote);

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'quotation',
          entityId: verifiedQuote.id,
          action: 'QUOTATION_VERIFIED',
          detail: `Verified ${verifiedQuote.quoteReference} (${verifiedQuote.documentName}) for ${rfq.rfqNumber}.`,
        });

        return verifiedQuote;
      });
    } catch (err) {
      handleDbError(err, 'verifyQuotation');
    }
  }

  async deleteQuotation(params: {
    organizationId: string;
    quoteId: string;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<{ deletedDocument?: { id: string; storageKey: string } }> {
    try {
      return await this.db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(quotations)
          .where(
            and(eq(quotations.id, params.quoteId), eq(quotations.organizationId, params.organizationId))
          )
          .limit(1);

        if (!target) throw new StoreError(404, 'Quotation not found.');

        const linkedAllocs = await tx
          .select({
            award: awards,
          })
          .from(awardAllocations)
          .innerJoin(awards, eq(awardAllocations.awardId, awards.id))
          .where(
            and(
              eq(awardAllocations.quotationId, target.id),
              eq(awardAllocations.organizationId, params.organizationId)
            )
          );

        if (linkedAllocs.some((row) => row.award.approvalStatus === 'approved')) {
          throw new StoreError(
            409,
            'Cannot delete a quotation that is part of an approved award decision.'
          );
        }

        const pendingAwardIds = [
          ...new Set(
            linkedAllocs
              .filter((row) => row.award.approvalStatus === 'pending')
              .map((row) => row.award.id)
          ),
        ];

        for (const awardId of pendingAwardIds) {
          await tx
            .delete(awards)
            .where(and(eq(awards.id, awardId), eq(awards.organizationId, params.organizationId)));
        }

        if (pendingAwardIds.length > 0) {
          await tx
            .update(rfqs)
            .set({ status: 'in_review', updatedAt: new Date().toISOString() })
            .where(
              and(
                eq(rfqs.id, target.rfqId),
                eq(rfqs.organizationId, params.organizationId),
                eq(rfqs.status, 'pending_approval')
              )
            );
        }

        let deletedDoc: { id: string; storageKey: string } | undefined;
        if (target.documentId) {
          const [doc] = await tx
            .select()
            .from(storedDocuments)
            .where(
              and(
                eq(storedDocuments.id, target.documentId),
                eq(storedDocuments.organizationId, params.organizationId)
              )
            )
            .limit(1);
          if (doc) {
            deletedDoc = { id: doc.id, storageKey: doc.storageKey };
          }
        }

        await tx
          .delete(quotations)
          .where(
            and(eq(quotations.id, target.id), eq(quotations.organizationId, params.organizationId))
          );

        if (deletedDoc) {
          await tx
            .delete(storedDocuments)
            .where(
              and(
                eq(storedDocuments.id, deletedDoc.id),
                eq(storedDocuments.organizationId, params.organizationId)
              )
            );
        }

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'quotation',
          entityId: target.id,
          action: 'QUOTATION_DELETED',
          detail: `Removed quotation ${target.quoteReference} (${target.documentName}).`,
        });

        return { deletedDocument: deletedDoc };
      });
    } catch (err) {
      handleDbError(err, 'deleteQuotation');
    }
  }

  async submitAward(params: {
    organizationId: string;
    rfqId: string;
    isSplitAward: boolean;
    nonL1Justification?: string | null;
    allocations: Array<{ rfqItemId: string; quotationId: string; quotationLineId: string }>;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<AwardDecision> {
    try {
      if (!Array.isArray(params.allocations) || params.allocations.length === 0) {
        throw new StoreError(
          400,
          'Award recommendation must include at least one item allocation.'
        );
      }

      return await this.db.transaction(async (tx) => {
        const [rfqRow] = await tx
          .select()
          .from(rfqs)
          .where(and(eq(rfqs.id, params.rfqId), eq(rfqs.organizationId, params.organizationId)))
          .limit(1);
        if (!rfqRow) throw new StoreError(404, 'RFQ not found.');

        const rItems = await tx
          .select()
          .from(rfqItems)
          .where(and(eq(rfqItems.rfqId, rfqRow.id), eq(rfqItems.organizationId, params.organizationId)));

        const qRows = await tx
          .select()
          .from(quotations)
          .where(
            and(eq(quotations.rfqId, rfqRow.id), eq(quotations.organizationId, params.organizationId))
          );

        const qLineRows = await tx
          .select()
          .from(quotationLines)
          .where(eq(quotationLines.organizationId, params.organizationId));

        const linesByQuote = new Map<string, QuotationLine[]>();
        for (const l of qLineRows) {
          const arr = linesByQuote.get(l.quotationId) || [];
          arr.push({
            id: l.id,
            quotationId: l.quotationId,
            rfqItemId: l.rfqItemId,
            vendorLineNo: l.vendorLineNo,
            rawDescription: l.rawDescription,
            quotedQty: l.quotedQty,
            quotedUom: l.quotedUom,
            uomConversionFactor: l.uomConversionFactor,
            quotedUnitRate: l.quotedUnitRate,
            discountAmount: l.discountAmount,
            taxRatePct: l.taxRatePct,
            taxCreditable: l.taxCreditable,
            allocatedOverhead: l.allocatedOverhead,
            normalizedUnitBase: l.normalizedUnitBase,
            normalizedUnitLanded: l.normalizedUnitLanded,
            normalizedUnitGross: l.normalizedUnitGross,
            lineTotalQuoted: l.lineTotalQuoted,
            expectedLineTotal: l.expectedLineTotal,
            mathValid: l.mathValid,
            mathErrorDetail: l.mathErrorDetail,
            matchStatus: l.matchStatus as QuotationLine['matchStatus'],
            confidenceScore: l.confidenceScore,
            humanEdited: l.humanEdited,
            verifiedField: l.verifiedField,
            sourceTrace: l.sourceTrace,
          });
          linesByQuote.set(l.quotationId, arr);
        }

        const rfqQuotes: Quotation[] = qRows.map((q) => ({
          id: q.id,
          rfqId: q.rfqId,
          supplierId: q.supplierId,
          documentId: q.documentId,
          documentName: q.documentName,
          documentKind: q.documentKind as Quotation['documentKind'],
          mimeType: q.mimeType,
          parseStatus: q.parseStatus as Quotation['parseStatus'],
          quoteReference: q.quoteReference,
          quoteDate: q.quoteDate,
          validUntil: q.validUntil,
          currency: q.currency as Quotation['currency'],
          exchangeRateToRfq: q.exchangeRateToRfq,
          leadTimeDays: q.leadTimeDays,
          paymentTerms: q.paymentTerms,
          freightCharges: q.freightCharges,
          packingForwarding: q.packingForwarding,
          otherCharges: q.otherCharges,
          globalDiscount: q.globalDiscount,
          taxIncludedInRates: q.taxIncludedInRates,
          missingFreightWarning: q.missingFreightWarning,
          subtotalBase: q.subtotalBase,
          totalTax: q.totalTax,
          totalLandedCost: q.totalLandedCost,
          totalGrossPayable: q.totalGrossPayable,
          completenessRatio: q.completenessRatio,
          isVerified: q.isVerified,
          verifiedBy: q.verifiedBy,
          verifiedAt: q.verifiedAt,
          headerTraces: q.headerTraces || {},
          lines: linesByQuote.get(q.id) || [],
          createdAt: q.createdAt,
        }));

        const verifiedAllocations: AwardAllocation[] = [];
        let computedTotalLanded = 0;

        for (const al of params.allocations) {
          const rfqItem = rItems.find((it) => it.id === al.rfqItemId);
          const quote = rfqQuotes.find((q) => q.id === al.quotationId);
          const line = quote?.lines.find((l) => l.id === al.quotationLineId);

          if (!rfqItem || !quote || !line || line.matchStatus === 'not_quoted') {
            throw new StoreError(400, 'Invalid allocation reference to RFQ item or quotation line.');
          }
          if (!line.mathValid || line.normalizedUnitLanded === null) {
            throw new StoreError(
              422,
              `Cannot include line "${line.rawDescription}" in an award while arithmetic mismatch or missing price remains.`
            );
          }

          const qty = rfqItem.quantity;
          const unitLanded = line.normalizedUnitLanded;
          computedTotalLanded += unitLanded * qty;
          verifiedAllocations.push({
            rfqItemId: rfqItem.id,
            quotationId: quote.id,
            quotationLineId: line.id,
            supplierId: quote.supplierId,
            awardedQty: qty,
            awardedUnitLanded: unitLanded,
          });
        }

        const distinctQuoteIds = new Set(verifiedAllocations.map((a) => a.quotationId));
        if (!params.isSplitAward && distinctQuoteIds.size === 1) {
          const soleQuote = rfqQuotes.find((q) => q.id === [...distinctQuoteIds][0]);
          if (soleQuote && verifiedAllocations.length === rItems.length) {
            computedTotalLanded = soleQuote.totalLandedCost;
          }
        }
        computedTotalLanded = Math.round(computedTotalLanded * 100) / 100;

        const ranked = rankQuotations(rfqQuotes, 'landed');
        const l1Eligible = ranked.find((r) => r.rankIndex === 1);
        const isNonL1Server = l1Eligible
          ? computedTotalLanded > l1Eligible.totalForBasis + 1
          : false;

        const trimmedJust =
          typeof params.nonL1Justification === 'string' && params.nonL1Justification.trim()
            ? params.nonL1Justification.trim()
            : null;
        if (isNonL1Server && !trimmedJust) {
          throw new StoreError(
            400,
            'Justification is mandatory when awarding above the L1 lowest landed cost.'
          );
        }

        await tx
          .delete(awards)
          .where(
            and(
              eq(awards.rfqId, rfqRow.id),
              eq(awards.organizationId, params.organizationId),
              eq(awards.approvalStatus, 'pending')
            )
          );

        const nowIso = new Date().toISOString();
        const awardId = makeId('award');
        const award: AwardDecision = {
          id: awardId,
          rfqId: rfqRow.id,
          isSplitAward: Boolean(params.isSplitAward),
          recommendedBy: params.actorName,
          approvedBy: null,
          approvalStatus: 'pending',
          nonL1Justification: trimmedJust,
          approverNotes: null,
          totalAwardedLanded: computedTotalLanded,
          allocations: verifiedAllocations,
          decidedAt: null,
          createdAt: nowIso,
        };

        await tx.insert(awards).values({
          id: award.id,
          organizationId: params.organizationId,
          rfqId: award.rfqId,
          isSplitAward: award.isSplitAward,
          recommendedBy: award.recommendedBy,
          recommendedByUserId: params.actorUserId,
          approvedBy: null,
          approvedByUserId: null,
          approvalStatus: 'pending',
          nonL1Justification: award.nonL1Justification,
          approverNotes: null,
          totalAwardedLanded: award.totalAwardedLanded,
          decidedAt: null,
          createdAt: award.createdAt,
        });

        await tx.insert(awardAllocations).values(
          verifiedAllocations.map((al) => ({
            id: makeId('al'),
            organizationId: params.organizationId,
            awardId: award.id,
            rfqItemId: al.rfqItemId,
            quotationId: al.quotationId,
            quotationLineId: al.quotationLineId,
            supplierId: al.supplierId,
            awardedQty: al.awardedQty,
            awardedUnitLanded: al.awardedUnitLanded,
          }))
        );

        await tx
          .update(rfqs)
          .set({ status: 'pending_approval', updatedAt: nowIso })
          .where(and(eq(rfqs.id, rfqRow.id), eq(rfqs.organizationId, params.organizationId)));

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'award',
          entityId: award.id,
          action: 'AWARD_RECOMMENDED',
          detail: `Submitted ${award.isSplitAward ? 'Split' : 'Full'} award recommendation for ${rfqRow.rfqNumber} (Landed total: ${award.totalAwardedLanded}).`,
        });

        return award;
      });
    } catch (err) {
      handleDbError(err, 'submitAward');
    }
  }

  async decideAward(params: {
    organizationId: string;
    awardId: string;
    decision: 'approved' | 'rejected';
    approverNotes?: string | null;
    actorUserId: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<{ award: AwardDecision; rfq: Rfq }> {
    try {
      if (params.decision !== 'approved' && params.decision !== 'rejected') {
        throw new StoreError(400, 'Decision must be "approved" or "rejected".');
      }

      return await this.db.transaction(async (tx) => {
        const [awardRow] = await tx
          .select()
          .from(awards)
          .where(
            and(eq(awards.id, params.awardId), eq(awards.organizationId, params.organizationId))
          )
          .limit(1);

        if (!awardRow) throw new StoreError(404, 'Award decision not found.');
        if (awardRow.approvalStatus !== 'pending') {
          throw new StoreError(409, 'This award decision has already been finalized.');
        }

        const [rfqRow] = await tx
          .select()
          .from(rfqs)
          .where(
            and(eq(rfqs.id, awardRow.rfqId), eq(rfqs.organizationId, params.organizationId))
          )
          .limit(1);
        if (!rfqRow) throw new StoreError(404, 'Parent RFQ not found.');

        const rItems = await tx
          .select()
          .from(rfqItems)
          .where(
            and(eq(rfqItems.rfqId, rfqRow.id), eq(rfqItems.organizationId, params.organizationId))
          )
          .orderBy(asc(rfqItems.lineNo));
        const allocRows = await tx
          .select()
          .from(awardAllocations)
          .where(
            and(
              eq(awardAllocations.awardId, awardRow.id),
              eq(awardAllocations.organizationId, params.organizationId)
            )
          );
        const orgSuppliers = await tx
          .select()
          .from(suppliers)
          .where(eq(suppliers.organizationId, params.organizationId));
        const orgCatalog = await tx
          .select()
          .from(catalogItems)
          .where(eq(catalogItems.organizationId, params.organizationId));

        const nowIso = new Date().toISOString();
        const notes =
          typeof params.approverNotes === 'string' && params.approverNotes.trim()
            ? params.approverNotes.trim()
            : null;

        await tx
          .update(awards)
          .set({
            approvalStatus: params.decision,
            approvedBy: params.actorName,
            approvedByUserId: params.actorUserId,
            approverNotes: notes,
            decidedAt: nowIso,
          })
          .where(
            and(eq(awards.id, awardRow.id), eq(awards.organizationId, params.organizationId))
          );

        const nextStatus: Rfq['status'] =
          params.decision === 'approved' ? 'awarded' : 'in_review';
        await tx
          .update(rfqs)
          .set({ status: nextStatus, updatedAt: nowIso })
          .where(and(eq(rfqs.id, rfqRow.id), eq(rfqs.organizationId, params.organizationId)));

        if (params.decision === 'approved') {
          for (const alloc of allocRows) {
            const rfqItem = rItems.find((it) => it.id === alloc.rfqItemId);
            if (!rfqItem) continue;

            const supplier = orgSuppliers.find((s) => s.id === alloc.supplierId);
            let catItem = orgCatalog.find(
              (ci) =>
                ci.id === rfqItem.itemId ||
                (rfqItem.skuCode && ci.skuCode.toLowerCase() === rfqItem.skuCode.toLowerCase()) ||
                ci.normalizedName === rfqItem.description.toLowerCase().trim()
            );

            if (!catItem) {
              const newCatId = makeId('item');
              const [insertedCat] = await tx
                .insert(catalogItems)
                .values({
                  id: newCatId,
                  organizationId: params.organizationId,
                  skuCode: rfqItem.skuCode || `SKU-${rfqItem.lineNo}`,
                  name: rfqItem.description,
                  normalizedName: rfqItem.description.toLowerCase().trim(),
                  defaultUom: rfqItem.uom,
                  hsnSacCode: '',
                  lastAwardedUnitPrice: alloc.awardedUnitLanded,
                  lastAwardedCurrency: rfqRow.currency,
                  lastAwardedAt: nowIso,
                  lastSupplierId: alloc.supplierId,
                })
                .returning();
              catItem = insertedCat;
              orgCatalog.push(insertedCat);

              await tx
                .update(rfqItems)
                .set({ itemId: newCatId })
                .where(
                  and(eq(rfqItems.id, rfqItem.id), eq(rfqItems.organizationId, params.organizationId))
                );
            } else {
              await tx
                .update(catalogItems)
                .set({
                  lastAwardedUnitPrice: alloc.awardedUnitLanded,
                  lastAwardedCurrency: rfqRow.currency,
                  lastAwardedAt: nowIso,
                  lastSupplierId: alloc.supplierId,
                })
                .where(
                  and(
                    eq(catalogItems.id, catItem.id),
                    eq(catalogItems.organizationId, params.organizationId)
                  )
                );
            }

            await tx.insert(priceHistory).values({
              id: makeId('ph'),
              organizationId: params.organizationId,
              catalogItemId: catItem.id,
              rfqId: rfqRow.id,
              rfqNumber: rfqRow.rfqNumber,
              supplierId: alloc.supplierId,
              supplierName: supplier?.name || 'Supplier',
              unitLandedPrice: alloc.awardedUnitLanded,
              currency: rfqRow.currency,
              awardedAt: nowIso,
            });
          }
        }

        await this.appendAuditTx(tx, {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          actorName: params.actorName,
          actorRole: params.actorRole,
          entityType: 'award',
          entityId: awardRow.id,
          action: params.decision === 'approved' ? 'AWARD_APPROVED' : 'AWARD_REJECTED',
          detail: `${params.decision === 'approved' ? 'Approved' : 'Returned for revision'} award for ${rfqRow.rfqNumber}. ${notes || ''}`.trim(),
        });

        const award: AwardDecision = {
          id: awardRow.id,
          rfqId: awardRow.rfqId,
          isSplitAward: awardRow.isSplitAward,
          recommendedBy: awardRow.recommendedBy,
          approvedBy: params.actorName,
          approvalStatus: params.decision,
          nonL1Justification: awardRow.nonL1Justification,
          approverNotes: notes,
          totalAwardedLanded: awardRow.totalAwardedLanded,
          allocations: allocRows.map((al) => ({
            rfqItemId: al.rfqItemId,
            quotationId: al.quotationId,
            quotationLineId: al.quotationLineId,
            supplierId: al.supplierId,
            awardedQty: al.awardedQty,
            awardedUnitLanded: al.awardedUnitLanded,
          })),
          decidedAt: nowIso,
          createdAt: awardRow.createdAt,
        };

        const rfq: Rfq = {
          id: rfqRow.id,
          rfqNumber: rfqRow.rfqNumber,
          title: rfqRow.title,
          status: nextStatus,
          currency: rfqRow.currency as Rfq['currency'],
          incoterms: rfqRow.incoterms,
          deliveryLocation: rfqRow.deliveryLocation,
          deadlineDate: rfqRow.deadlineDate,
          createdBy: rfqRow.createdBy,
          createdAt: rfqRow.createdAt,
          updatedAt: nowIso,
          invitedSupplierIds: rfqRow.invitedSupplierIds || [],
          items: rItems.map((it) => ({
            id: it.id,
            rfqId: it.rfqId,
            itemId: it.itemId,
            lineNo: it.lineNo,
            skuCode: it.skuCode,
            description: it.description,
            quantity: it.quantity,
            uom: it.uom,
            targetUnitPrice: it.targetUnitPrice,
          })),
        };

        return { award, rfq };
      });
    } catch (err) {
      handleDbError(err, 'decideAward');
    }
  }

  async getStoredDocumentForOrg(
    organizationId: string,
    documentId: string
  ): Promise<StoredDocumentRecord | null> {
    try {
      const [doc] = await this.db
        .select()
        .from(storedDocuments)
        .where(
          and(
            eq(storedDocuments.id, documentId),
            eq(storedDocuments.organizationId, organizationId)
          )
        )
        .limit(1);

      if (!doc) return null;
      return {
        id: doc.id,
        organizationId: doc.organizationId,
        uploadedByUserId: doc.uploadedByUserId,
        storageProvider: doc.storageProvider as 's3' | 'local',
        storageKey: doc.storageKey,
        originalFilename: doc.originalFilename,
        mimeType: doc.mimeType,
        byteSize: doc.byteSize,
        sha256: doc.sha256,
        createdAt: doc.createdAt,
      };
    } catch (err) {
      handleDbError(err, 'getStoredDocumentForOrg');
    }
  }
}
