import type {
  AiTokenUsageTelemetry,
  OrganizationPlanTier,
  OrganizationUsageSummary,
} from '../src/types.ts';

export const VALID_PLAN_TIERS = new Set<OrganizationPlanTier>([
  'legacy',
  'starter',
  'professional',
  'business',
]);

export const GIBIBYTE = 1024 * 1024 * 1024;
export const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000;

export interface PlanPolicyDefinition {
  tier: OrganizationPlanTier;
  label: string;
  monthlyExtractionLimit: number | null;
  storageLimitBytes: number | null;
  isUnvalidatedHypothesis: boolean;
  nonBlockingByDefault: boolean;
}

/**
 * NOTE: Starter / Professional / Business quotas below reflect internal
 * unvalidated commercial tier hypotheses from Task 015 and MUST NOT be
 * treated as validated pricing/unit-economics commitments.
 */
export const PLAN_POLICIES: Record<OrganizationPlanTier, PlanPolicyDefinition> = {
  legacy: {
    tier: 'legacy',
    label: 'Legacy (Grandfathered)',
    monthlyExtractionLimit: null,
    storageLimitBytes: null,
    isUnvalidatedHypothesis: false,
    nonBlockingByDefault: true,
  },
  starter: {
    tier: 'starter',
    label: 'Starter (Unvalidated Hypothesis)',
    monthlyExtractionLimit: 60,
    storageLimitBytes: 5 * GIBIBYTE,
    isUnvalidatedHypothesis: true,
    nonBlockingByDefault: false,
  },
  professional: {
    tier: 'professional',
    label: 'Professional (Unvalidated Hypothesis)',
    monthlyExtractionLimit: 250,
    storageLimitBytes: 25 * GIBIBYTE,
    isUnvalidatedHypothesis: true,
    nonBlockingByDefault: false,
  },
  business: {
    tier: 'business',
    label: 'Business (Unvalidated Hypothesis)',
    monthlyExtractionLimit: 800,
    storageLimitBytes: 100 * GIBIBYTE,
    isUnvalidatedHypothesis: true,
    nonBlockingByDefault: false,
  },
};

export type QuotaErrorCode =
  | 'MONTHLY_EXTRACTION_QUOTA_EXCEEDED'
  | 'STORAGE_QUOTA_EXCEEDED';

export interface QuotaErrorDetails {
  code: QuotaErrorCode;
  organizationId: string;
  planTier: OrganizationPlanTier;
  isUnvalidatedHypothesis: boolean;
  periodMonth: string;
  resetAt: string;
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  requestedBytes?: number;
}

export class QuotaExceededError extends Error {
  statusCode: number;
  code: QuotaErrorCode;
  details: QuotaErrorDetails;

  constructor(message: string, details: QuotaErrorDetails, statusCode = 429) {
    super(message);
    this.name = 'QuotaExceededError';
    this.statusCode = statusCode;
    this.code = details.code;
    this.details = details;
  }
}

export class IdempotencyConflictError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = 'IdempotencyConflictError';
    this.statusCode = statusCode;
  }
}

export function normalizePlanTier(raw: unknown): OrganizationPlanTier {
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase() as OrganizationPlanTier;
    if (VALID_PLAN_TIERS.has(lower)) {
      return lower;
    }
  }
  return 'legacy';
}

export function resolveDefaultNewOrgPlan(
  env: Record<string, string | undefined> = process.env
): OrganizationPlanTier {
  const configured = env.DEFAULT_NEW_ORG_PLAN?.trim().toLowerCase();
  if (configured && VALID_PLAN_TIERS.has(configured as OrganizationPlanTier)) {
    return configured as OrganizationPlanTier;
  }
  return 'starter';
}

export interface EffectiveOrganizationPolicy {
  tier: OrganizationPlanTier;
  label: string;
  monthlyExtractionLimit: number | null;
  storageLimitBytes: number | null;
  isMonthlyLimitOverride: boolean;
  isStorageLimitOverride: boolean;
  isUnvalidatedHypothesis: boolean;
}

export function resolveEffectiveOrganizationPolicy(org: {
  planTier?: string | null;
  monthlyExtractionLimitOverride?: number | null;
  storageLimitBytesOverride?: number | null;
}): EffectiveOrganizationPolicy {
  const tier = normalizePlanTier(org.planTier);
  const base = PLAN_POLICIES[tier];

  const hasMonthlyOverride =
    typeof org.monthlyExtractionLimitOverride === 'number' &&
    Number.isFinite(org.monthlyExtractionLimitOverride) &&
    org.monthlyExtractionLimitOverride >= 0;

  const hasStorageOverride =
    typeof org.storageLimitBytesOverride === 'number' &&
    Number.isFinite(org.storageLimitBytesOverride) &&
    org.storageLimitBytesOverride >= 0;

  return {
    tier,
    label: base.label,
    monthlyExtractionLimit: hasMonthlyOverride
      ? Math.floor(org.monthlyExtractionLimitOverride!)
      : base.monthlyExtractionLimit,
    storageLimitBytes: hasStorageOverride
      ? Math.floor(org.storageLimitBytesOverride!)
      : base.storageLimitBytes,
    isMonthlyLimitOverride: hasMonthlyOverride,
    isStorageLimitOverride: hasStorageOverride,
    isUnvalidatedHypothesis: base.isUnvalidatedHypothesis,
  };
}

export function getUtcPeriodBounds(now: Date = new Date()): {
  periodMonth: string;
  periodStartIso: string;
  resetAtIso: string;
} {
  const year = now.getUTCFullYear();
  const monthIdx = now.getUTCMonth(); // 0..11
  const monthNum = monthIdx + 1;
  const periodMonth = `${year}-${String(monthNum).padStart(2, '0')}`;
  const periodStartIso = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0)).toISOString();
  const resetAtIso = new Date(Date.UTC(year, monthIdx + 1, 1, 0, 0, 0, 0)).toISOString();
  return { periodMonth, periodStartIso, resetAtIso };
}

export function validateOptionalIdempotencyKey(raw: unknown): {
  valid: boolean;
  key: string | null;
  error?: string;
} {
  if (raw === undefined || raw === null) {
    return { valid: true, key: null };
  }
  if (typeof raw !== 'string') {
    return { valid: false, key: null, error: 'Idempotency-Key must be a string.' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: true, key: null };
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(trimmed)) {
    return {
      valid: false,
      key: null,
      error:
        'Idempotency-Key must be 8–128 characters matching [A-Za-z0-9._-].',
    };
  }
  return { valid: true, key: trimmed };
}

export function evaluateExtractionQuota(params: {
  monthlyLimit: number | null;
  committedCount: number;
  activeReservedCount: number;
}): {
  allowed: boolean;
  usedAndReserved: number;
  remaining: number | null;
} {
  const usedAndReserved = Math.max(0, params.committedCount) + Math.max(0, params.activeReservedCount);
  if (params.monthlyLimit === null) {
    return { allowed: true, usedAndReserved, remaining: null };
  }
  const limit = Math.max(0, params.monthlyLimit);
  const remaining = Math.max(0, limit - usedAndReserved);
  return {
    allowed: usedAndReserved < limit,
    usedAndReserved,
    remaining,
  };
}

export function evaluateStorageQuota(params: {
  storageLimitBytes: number | null;
  storedBytes: number;
  activeReservedBytes: number;
  incomingBytes: number;
}): {
  allowed: boolean;
  projectedBytes: number;
  remainingBytes: number | null;
} {
  const used = Math.max(0, params.storedBytes) + Math.max(0, params.activeReservedBytes);
  const incoming = Math.max(0, params.incomingBytes);
  const projectedBytes = used + incoming;
  if (params.storageLimitBytes === null) {
    return { allowed: true, projectedBytes, remainingBytes: null };
  }
  const limit = Math.max(0, params.storageLimitBytes);
  const remainingBytes = Math.max(0, limit - used);
  return {
    allowed: projectedBytes <= limit,
    projectedBytes,
    remainingBytes,
  };
}

export function formatBytesCompact(bytes: number): string {
  if (bytes >= GIBIBYTE) return `${(bytes / GIBIBYTE).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Deterministic in-memory quota & token usage coordinator mirroring PgDataStore
 * reservation/commit/release/idempotency/UTC-rollover semantics for offline testing.
 */
interface MemoryOrgState {
  id: string;
  planTier: OrganizationPlanTier;
  monthlyExtractionLimitOverride: number | null;
  storageLimitBytesOverride: number | null;
}

interface MemoryMonthlyRow {
  committedExtractions: number;
  totalPromptTokens: number;
  totalCandidatesTokens: number;
  totalTokens: number;
  unavailableEventsCount: number;
}

interface MemoryReservationRow {
  id: string;
  organizationId: string;
  periodMonth: string;
  rfqId: string;
  supplierId: string;
  idempotencyKey: string | null;
  reservedBytes: number;
  status: 'reserved' | 'committed' | 'released';
  quotationId: string | null;
  expiresAtMs: number;
}

export class InMemoryUsageQuotaCoordinator {
  private readonly orgs = new Map<string, MemoryOrgState>();
  private readonly monthly = new Map<string, MemoryMonthlyRow>();
  private readonly reservations = new Map<string, MemoryReservationRow>();
  private readonly storedDocBytesByDocId = new Map<string, { orgId: string; bytes: number }>();
  private readonly deletedQuotationIds = new Set<string>();
  public readonly tokenLogs: Array<
    AiTokenUsageTelemetry & {
      id: string;
      organizationId: string;
      reservationId: string | null;
      quotationId: string | null;
      documentId: string | null;
      outcome: 'succeeded' | 'failed';
      createdAt: string;
    }
  > = [];
  private seq = 0;

  registerOrganization(org: {
    id: string;
    planTier?: OrganizationPlanTier;
    monthlyExtractionLimitOverride?: number | null;
    storageLimitBytesOverride?: number | null;
  }) {
    this.orgs.set(org.id, {
      id: org.id,
      planTier: org.planTier ?? 'starter',
      monthlyExtractionLimitOverride: org.monthlyExtractionLimitOverride ?? null,
      storageLimitBytesOverride: org.storageLimitBytesOverride ?? null,
    });
  }

  private getMonthlyKey(orgId: string, periodMonth: string): string {
    return `${orgId}::${periodMonth}`;
  }

  private getOrCreateMonthly(orgId: string, periodMonth: string): MemoryMonthlyRow {
    const key = this.getMonthlyKey(orgId, periodMonth);
    let row = this.monthly.get(key);
    if (!row) {
      row = {
        committedExtractions: 0,
        totalPromptTokens: 0,
        totalCandidatesTokens: 0,
        totalTokens: 0,
        unavailableEventsCount: 0,
      };
      this.monthly.set(key, row);
    }
    return row;
  }

  private cleanupExpiredReservations(orgId: string, nowMs: number) {
    for (const r of this.reservations.values()) {
      if (r.organizationId === orgId && r.status === 'reserved' && r.expiresAtMs <= nowMs) {
        r.status = 'released';
      }
    }
  }

  reserve(params: {
    organizationId: string;
    rfqId: string;
    supplierId: string;
    reservedBytes: number;
    idempotencyKey?: string | null;
    now?: Date;
    ttlMs?: number;
  }):
    | { kind: 'reserved'; reservationId: string; periodMonth: string }
    | { kind: 'idempotent_hit'; quotationId: string }
    | { kind: 'in_flight_conflict' } {
    const org = this.orgs.get(params.organizationId);
    if (!org) throw new Error(`Unknown org ${params.organizationId}`);

    const now = params.now ?? new Date();
    const nowMs = now.getTime();
    const { periodMonth, resetAtIso } = getUtcPeriodBounds(now);
    this.cleanupExpiredReservations(org.id, nowMs);

    if (params.idempotencyKey) {
      for (const existing of this.reservations.values()) {
        if (
          existing.organizationId === org.id &&
          existing.idempotencyKey === params.idempotencyKey &&
          (existing.status === 'reserved' || existing.status === 'committed')
        ) {
          if (
            existing.rfqId !== params.rfqId ||
            existing.supplierId !== params.supplierId
          ) {
            throw new IdempotencyConflictError(
              'Idempotency-Key was already used for a different RFQ or supplier.'
            );
          }
          if (existing.status === 'committed' && existing.quotationId) {
            if (this.deletedQuotationIds.has(existing.quotationId)) {
              throw new IdempotencyConflictError(
                'The quotation created by this Idempotency-Key was deleted. Retry with a new Idempotency-Key.'
              );
            }
            return { kind: 'idempotent_hit', quotationId: existing.quotationId };
          }
          if (existing.status === 'reserved') {
            return { kind: 'in_flight_conflict' };
          }
        }
      }
    }

    const policy = resolveEffectiveOrganizationPolicy(org);
    const monthlyRow = this.getOrCreateMonthly(org.id, periodMonth);

    let activeReservedCount = 0;
    let activeReservedBytes = 0;
    for (const r of this.reservations.values()) {
      if (r.organizationId === org.id && r.status === 'reserved' && r.expiresAtMs > nowMs) {
        if (r.periodMonth === periodMonth) {
          activeReservedCount += 1;
        }
        activeReservedBytes += r.reservedBytes;
      }
    }

    let storedBytes = 0;
    for (const d of this.storedDocBytesByDocId.values()) {
      if (d.orgId === org.id) storedBytes += d.bytes;
    }

    const extractionEval = evaluateExtractionQuota({
      monthlyLimit: policy.monthlyExtractionLimit,
      committedCount: monthlyRow.committedExtractions,
      activeReservedCount,
    });
    if (!extractionEval.allowed && policy.monthlyExtractionLimit !== null) {
      throw new QuotaExceededError(
        `Monthly AI extraction limit (${policy.monthlyExtractionLimit} documents for ${periodMonth} UTC) reached on ${policy.label} plan.`,
        {
          code: 'MONTHLY_EXTRACTION_QUOTA_EXCEEDED',
          organizationId: org.id,
          planTier: policy.tier,
          isUnvalidatedHypothesis: policy.isUnvalidatedHypothesis,
          periodMonth,
          resetAt: resetAtIso,
          limit: policy.monthlyExtractionLimit,
          used: monthlyRow.committedExtractions,
          reserved: activeReservedCount,
          remaining: extractionEval.remaining ?? 0,
        }
      );
    }

    const storageEval = evaluateStorageQuota({
      storageLimitBytes: policy.storageLimitBytes,
      storedBytes,
      activeReservedBytes,
      incomingBytes: params.reservedBytes,
    });
    if (!storageEval.allowed && policy.storageLimitBytes !== null) {
      throw new QuotaExceededError(
        `Organization storage limit (${formatBytesCompact(policy.storageLimitBytes)}) exceeded.`,
        {
          code: 'STORAGE_QUOTA_EXCEEDED',
          organizationId: org.id,
          planTier: policy.tier,
          isUnvalidatedHypothesis: policy.isUnvalidatedHypothesis,
          periodMonth,
          resetAt: resetAtIso,
          limit: policy.storageLimitBytes,
          used: storedBytes,
          reserved: activeReservedBytes,
          remaining: storageEval.remainingBytes ?? 0,
          requestedBytes: params.reservedBytes,
        }
      );
    }

    this.seq += 1;
    const id = `res-${this.seq}`;
    this.reservations.set(id, {
      id,
      organizationId: org.id,
      periodMonth,
      rfqId: params.rfqId,
      supplierId: params.supplierId,
      idempotencyKey: params.idempotencyKey ?? null,
      reservedBytes: Math.max(0, params.reservedBytes),
      status: 'reserved',
      quotationId: null,
      expiresAtMs: nowMs + (params.ttlMs ?? DEFAULT_RESERVATION_TTL_MS),
    });

    return { kind: 'reserved', reservationId: id, periodMonth };
  }

  commit(params: {
    reservationId: string;
    quotationId: string;
    documentId?: string | null;
    storedBytes?: number;
    tokenUsage?: AiTokenUsageTelemetry | null;
    now?: Date;
  }) {
    const r = this.reservations.get(params.reservationId);
    if (!r || r.status !== 'reserved') {
      throw new Error(`Reservation ${params.reservationId} is not active.`);
    }
    const now = params.now ?? new Date();
    r.status = 'committed';
    r.quotationId = params.quotationId;

    if (params.documentId && (params.storedBytes ?? 0) > 0) {
      this.storedDocBytesByDocId.set(params.documentId, {
        orgId: r.organizationId,
        bytes: params.storedBytes!,
      });
    }

    const monthly = this.getOrCreateMonthly(r.organizationId, r.periodMonth);
    monthly.committedExtractions += 1;
    if (params.tokenUsage) {
      if (params.tokenUsage.usageAvailable) {
        monthly.totalPromptTokens += params.tokenUsage.promptTokenCount ?? 0;
        monthly.totalCandidatesTokens += params.tokenUsage.candidatesTokenCount ?? 0;
        monthly.totalTokens += params.tokenUsage.totalTokenCount ?? 0;
      } else {
        monthly.unavailableEventsCount += 1;
      }
      this.tokenLogs.push({
        ...params.tokenUsage,
        id: `tok-${this.tokenLogs.length + 1}`,
        organizationId: r.organizationId,
        reservationId: r.id,
        quotationId: params.quotationId,
        documentId: params.documentId ?? null,
        outcome: 'succeeded',
        createdAt: now.toISOString(),
      });
    }
  }

  release(params: {
    reservationId: string;
    tokenUsage?: AiTokenUsageTelemetry | null;
    now?: Date;
  }) {
    const r = this.reservations.get(params.reservationId);
    if (!r) return;
    if (r.status === 'reserved') {
      r.status = 'released';
    }
    const now = params.now ?? new Date();
    if (params.tokenUsage) {
      const monthly = this.getOrCreateMonthly(r.organizationId, r.periodMonth);
      if (!params.tokenUsage.usageAvailable) {
        monthly.unavailableEventsCount += 1;
      } else {
        monthly.totalPromptTokens += params.tokenUsage.promptTokenCount ?? 0;
        monthly.totalCandidatesTokens += params.tokenUsage.candidatesTokenCount ?? 0;
        monthly.totalTokens += params.tokenUsage.totalTokenCount ?? 0;
      }
      this.tokenLogs.push({
        ...params.tokenUsage,
        id: `tok-${this.tokenLogs.length + 1}`,
        organizationId: r.organizationId,
        reservationId: r.id,
        quotationId: null,
        documentId: null,
        outcome: 'failed',
        createdAt: now.toISOString(),
      });
    }
  }

  deleteStoredDocument(documentId: string, quotationId?: string) {
    this.storedDocBytesByDocId.delete(documentId);
    if (quotationId) {
      this.deletedQuotationIds.add(quotationId);
    }
  }

  markQuotationDeleted(quotationId: string) {
    this.deletedQuotationIds.add(quotationId);
  }

  getSummary(orgId: string, now: Date = new Date()): OrganizationUsageSummary {
    const org = this.orgs.get(orgId);
    if (!org) throw new Error(`Unknown org ${orgId}`);
    const nowMs = now.getTime();
    const { periodMonth, periodStartIso, resetAtIso } = getUtcPeriodBounds(now);
    const policy = resolveEffectiveOrganizationPolicy(org);
    const monthly = this.getOrCreateMonthly(org.id, periodMonth);

    let activeReservedCount = 0;
    let activeReservedBytes = 0;
    for (const r of this.reservations.values()) {
      if (r.organizationId === org.id && r.status === 'reserved' && r.expiresAtMs > nowMs) {
        if (r.periodMonth === periodMonth) activeReservedCount += 1;
        activeReservedBytes += r.reservedBytes;
      }
    }

    let storedBytes = 0;
    for (const d of this.storedDocBytesByDocId.values()) {
      if (d.orgId === org.id) storedBytes += d.bytes;
    }

    const extractionEval = evaluateExtractionQuota({
      monthlyLimit: policy.monthlyExtractionLimit,
      committedCount: monthly.committedExtractions,
      activeReservedCount,
    });
    const storageEval = evaluateStorageQuota({
      storageLimitBytes: policy.storageLimitBytes,
      storedBytes,
      activeReservedBytes,
      incomingBytes: 0,
    });

    return {
      organizationId: org.id,
      planTier: policy.tier,
      planLabel: policy.label,
      isUnvalidatedHypothesis: policy.isUnvalidatedHypothesis,
      periodMonth,
      periodStart: periodStartIso,
      resetAt: resetAtIso,
      extractions: {
        limit: policy.monthlyExtractionLimit,
        committed: monthly.committedExtractions,
        activeReserved: activeReservedCount,
        remaining: extractionEval.remaining,
        isCustomOverride: policy.isMonthlyLimitOverride,
      },
      storage: {
        limitBytes: policy.storageLimitBytes,
        usedBytes: storedBytes,
        activeReservedBytes,
        remainingBytes: storageEval.remainingBytes,
        isCustomOverride: policy.isStorageLimitOverride,
      },
      tokens: {
        periodMonth,
        promptTokens: monthly.totalPromptTokens,
        candidatesTokens: monthly.totalCandidatesTokens,
        totalTokens: monthly.totalTokens,
        unavailableEventsCount: monthly.unavailableEventsCount,
        costVerified: false,
      },
    };
  }
}
