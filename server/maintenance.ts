import fs from 'fs';
import path from 'path';
import { and, eq, inArray, lt, lte, notExists, or } from 'drizzle-orm';
import type { DrizzleDb } from '../src/db/index.ts';
import {
  aiExtractionReservations,
  invitations,
  quotations,
  rateLimitBuckets,
  sessions,
  storedDocuments,
  users,
} from '../src/db/schema.ts';
import { logEvent } from './monitoring.ts';
import type { ObjectStorageProvider } from './objectStorage.ts';
import { redactSensitiveText } from './security.ts';

export interface MaintenanceSummary {
  startedAt: string;
  durationMs: number;
  batchSize: number;
  skippedBecauseLocked?: boolean;
  deletedSessions: number;
  expiredPendingInvitations: number;
  deletedTerminalInvitations: number;
  clearedExpiredVerificationTokens: number;
  clearedExpiredResetTokens: number;
  deletedExpiredRateBuckets: number;
  cleanedOrphanedDocuments: number;
  cleanedTempStorageFiles: number;
  releasedExpiredReservations?: number;
  errors: string[];
}

export interface AdvisoryLockPool {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    release(): void;
  }>;
}

const MAINTENANCE_ADVISORY_LOCK_ID = 842910384721;

const DEFAULT_BATCH_SIZE = 500;
const REVOKED_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_INVITATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ORPHAN_DOCUMENT_GRACE_MS = 60 * 60 * 1000;
const TEMP_FILE_GRACE_MS = 60 * 60 * 1000;

async function cleanStaleTempFiles(dir: string, cutoffMs: number): Promise<number> {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;

  async function walk(current: string) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
        const stat = await fs.promises.stat(fullPath).catch(() => null);
        if (stat && stat.mtimeMs < cutoffMs) {
          await fs.promises.unlink(fullPath).catch(() => undefined);
          removed += 1;
        }
      }
    }
  }

  await walk(dir);
  return removed;
}

export async function runScheduledMaintenance(params: {
  db: DrizzleDb;
  storageProvider: ObjectStorageProvider;
  lockPool?: AdvisoryLockPool | null;
  localStorageDir?: string;
  batchSize?: number;
  now?: Date;
  orphanGraceMs?: number;
}): Promise<MaintenanceSummary> {
  const startedAt = new Date();
  const now = params.now ?? startedAt;
  const batchSize = Math.max(10, Math.min(2000, params.batchSize ?? DEFAULT_BATCH_SIZE));
  const orphanGraceMs = params.orphanGraceMs ?? ORPHAN_DOCUMENT_GRACE_MS;
  const errors: string[] = [];

  let deletedSessions = 0;
  let expiredPendingInvitations = 0;
  let deletedTerminalInvitations = 0;
  let clearedExpiredVerificationTokens = 0;
  let clearedExpiredResetTokens = 0;
  let deletedExpiredRateBuckets = 0;
  let cleanedOrphanedDocuments = 0;
  let cleanedTempStorageFiles = 0;
  let releasedExpiredReservations = 0;

  const lockPool: AdvisoryLockPool | undefined =
    params.lockPool === null
      ? undefined
      : params.lockPool ??
        (params.db as unknown as { $client?: AdvisoryLockPool }).$client;

  let lockClient: Awaited<ReturnType<AdvisoryLockPool['connect']>> | null = null;
  if (lockPool && typeof lockPool.connect === 'function') {
    const client = await lockPool.connect();
    try {
      const lockRes = await client.query(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [MAINTENANCE_ADVISORY_LOCK_ID]
      );
      const acquired = Boolean(lockRes.rows?.[0]?.acquired);
      if (!acquired) {
        client.release();
        return {
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          batchSize,
          skippedBecauseLocked: true,
          deletedSessions: 0,
          expiredPendingInvitations: 0,
          deletedTerminalInvitations: 0,
          clearedExpiredVerificationTokens: 0,
          clearedExpiredResetTokens: 0,
          deletedExpiredRateBuckets: 0,
          cleanedOrphanedDocuments: 0,
          cleanedTempStorageFiles: 0,
          releasedExpiredReservations: 0,
          errors: [],
        };
      }
      lockClient = client;
    } catch (err) {
      client.release();
      throw err;
    }
  }

  try {

  // 1. Delete expired sessions or sessions revoked more than 7 days ago (bounded batch)
  try {
    const revokedCutoff = new Date(now.getTime() - REVOKED_SESSION_RETENTION_MS);
    const staleSessions = await params.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(or(lte(sessions.expiresAt, now), lt(sessions.revokedAt, revokedCutoff)))
      .limit(batchSize);

    if (staleSessions.length > 0) {
      const ids = staleSessions.map((s) => s.id);
      const deleted = await params.db
        .delete(sessions)
        .where(inArray(sessions.id, ids))
        .returning({ id: sessions.id });
      deletedSessions = deleted.length;
    }
  } catch (err) {
    errors.push(`sessions: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Mark expired pending invitations & prune terminal invitations older than 30 days
  try {
    const pendingExpired = await params.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.status, 'pending'), lte(invitations.expiresAt, now)))
      .limit(batchSize);

    if (pendingExpired.length > 0) {
      const updated = await params.db
        .update(invitations)
        .set({ status: 'expired' })
        .where(inArray(invitations.id, pendingExpired.map((i) => i.id)))
        .returning({ id: invitations.id });
      expiredPendingInvitations = updated.length;
    }

    const invCutoff = new Date(now.getTime() - TERMINAL_INVITATION_RETENTION_MS);
    const oldTerminal = await params.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          inArray(invitations.status, ['expired', 'revoked']),
          lt(invitations.expiresAt, invCutoff)
        )
      )
      .limit(batchSize);

    if (oldTerminal.length > 0) {
      const deleted = await params.db
        .delete(invitations)
        .where(inArray(invitations.id, oldTerminal.map((i) => i.id)))
        .returning({ id: invitations.id });
      deletedTerminalInvitations = deleted.length;
    }
  } catch (err) {
    errors.push(`invitations: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Clear expired email verification tokens & password reset tokens (never deleting user accounts)
  try {
    const expiredVerifs = await params.db
      .select({ id: users.id })
      .from(users)
      .where(lte(users.emailVerificationExpiresAt, now))
      .limit(batchSize);

    if (expiredVerifs.length > 0) {
      const updated = await params.db
        .update(users)
        .set({
          emailVerificationTokenHash: null,
          emailVerificationExpiresAt: null,
        })
        .where(inArray(users.id, expiredVerifs.map((u) => u.id)))
        .returning({ id: users.id });
      clearedExpiredVerificationTokens = updated.length;
    }

    const expiredResets = await params.db
      .select({ id: users.id })
      .from(users)
      .where(lte(users.passwordResetExpiresAt, now))
      .limit(batchSize);

    if (expiredResets.length > 0) {
      const updated = await params.db
        .update(users)
        .set({
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
        })
        .where(inArray(users.id, expiredResets.map((u) => u.id)))
        .returning({ id: users.id });
      clearedExpiredResetTokens = updated.length;
    }
  } catch (err) {
    errors.push(`user_tokens: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Prune expired rate-limit buckets
  try {
    const staleBuckets = await params.db
      .select({ bucketKey: rateLimitBuckets.bucketKey })
      .from(rateLimitBuckets)
      .where(lte(rateLimitBuckets.resetAt, now))
      .limit(batchSize);

    if (staleBuckets.length > 0) {
      const deleted = await params.db
        .delete(rateLimitBuckets)
        .where(inArray(rateLimitBuckets.bucketKey, staleBuckets.map((b) => b.bucketKey)))
        .returning({ bucketKey: rateLimitBuckets.bucketKey });
      deletedExpiredRateBuckets = deleted.length;
    }
  } catch (err) {
    errors.push(`rate_limit_buckets: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Clean orphaned stored_documents ONLY when unreferenced by any quotation & past grace window
  try {
    const orphanCutoffIso = new Date(now.getTime() - orphanGraceMs).toISOString();
    const candidates = await params.db
      .select()
      .from(storedDocuments)
      .where(
        and(
          lt(storedDocuments.createdAt, orphanCutoffIso),
          notExists(
            params.db
              .select({ id: quotations.id })
              .from(quotations)
              .where(eq(quotations.documentId, storedDocuments.id))
          )
        )
      )
      .limit(batchSize);

    for (const doc of candidates) {
      try {
        await params.storageProvider.deleteObject(doc.storageKey);
      } catch (delErr) {
        const msg = redactSensitiveText(
          delErr instanceof Error ? delErr.message : String(delErr)
        );
        errors.push(`orphaned_documents(${doc.id}): ${msg}`);
        continue;
      }
      const removed = await params.db
        .delete(storedDocuments)
        .where(
          and(
            eq(storedDocuments.id, doc.id),
            notExists(
              params.db
                .select({ id: quotations.id })
                .from(quotations)
                .where(eq(quotations.documentId, doc.id))
            )
          )
        )
        .returning({ id: storedDocuments.id });
      cleanedOrphanedDocuments += removed.length;
    }
  } catch (err) {
    errors.push(`orphaned_documents: ${redactSensitiveText(err instanceof Error ? err.message : String(err))}`);
  }

  // 6. Clean incomplete .tmp artifacts from local private storage (if applicable)
  try {
    if (params.storageProvider.mode === 'local') {
      const targetDir =
        params.localStorageDir ||
        process.env.LOCAL_STORAGE_DIR ||
        path.join(process.cwd(), 'data', 'private-storage');
      cleanedTempStorageFiles = await cleanStaleTempFiles(
        path.resolve(targetDir),
        now.getTime() - TEMP_FILE_GRACE_MS
      );
    }
  } catch (err) {
    errors.push(`temp_files: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7. Release expired in-flight AI extraction quota reservations
  try {
    const staleReservations = await params.db
      .select({ id: aiExtractionReservations.id })
      .from(aiExtractionReservations)
      .where(
        and(
          eq(aiExtractionReservations.status, 'reserved'),
          lte(aiExtractionReservations.expiresAt, now)
        )
      )
      .limit(batchSize);

    if (staleReservations.length > 0) {
      const updated = await params.db
        .update(aiExtractionReservations)
        .set({ status: 'released', finalizedAt: now })
        .where(
          inArray(
            aiExtractionReservations.id,
            staleReservations.map((r) => r.id)
          )
        )
        .returning({ id: aiExtractionReservations.id });
      releasedExpiredReservations = updated.length;
    }
  } catch (err) {
    errors.push(`ai_extraction_reservations: ${err instanceof Error ? err.message : String(err)}`);
  }

  const summary: MaintenanceSummary = {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    batchSize,
    deletedSessions,
    expiredPendingInvitations,
    deletedTerminalInvitations,
    clearedExpiredVerificationTokens,
    clearedExpiredResetTokens,
    deletedExpiredRateBuckets,
    cleanedOrphanedDocuments,
    cleanedTempStorageFiles,
    releasedExpiredReservations,
    errors,
  };

  logEvent(errors.length > 0 ? 'warn' : 'info', 'scheduled_maintenance_completed', {
    ...summary,
  });

  return summary;
  } finally {
    if (lockClient) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [
          MAINTENANCE_ADVISORY_LOCK_ID,
        ]);
      } catch {
        // Ignore unlock error if connection already closed
      } finally {
        lockClient.release();
      }
    }
  }
}
