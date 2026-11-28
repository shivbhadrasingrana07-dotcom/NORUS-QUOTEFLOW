import http from 'node:http';
import { AddressInfo } from 'node:net';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createApp } from '../server.ts';
import {
  ExtractionServiceError,
  extractQuotationWithTelemetry,
  normalizeGeminiUsageMetadata,
} from '../server/geminiExtractor.ts';
import { runScheduledMaintenance } from '../server/maintenance.ts';
import type { ObjectStorageProvider } from '../server/objectStorage.ts';
import { type PgDataStore, StoreError } from '../server/pgStore.ts';
import { MemoryRateLimitStore } from '../server/rateLimiter.ts';
import { createInitialWorkspaceState } from '../server/seedData.ts';
import {
  GIBIBYTE,
  IdempotencyConflictError,
  InMemoryUsageQuotaCoordinator,
  PLAN_POLICIES,
  QuotaExceededError,
  getUtcPeriodBounds,
  normalizePlanTier,
  resolveDefaultNewOrgPlan,
  resolveEffectiveOrganizationPolicy,
  validateOptionalIdempotencyKey,
} from '../server/usagePolicy.ts';
import {
  aiExtractionReservations,
  aiTokenUsageLogs,
  organizationMonthlyUsage,
  organizations,
} from '../src/db/schema.ts';
import type { AiTokenUsageTelemetry } from '../src/types.ts';
import {
  TEST_DB_SKIP_REASON,
  TestCookieClient,
  cleanupTestOrganizationsAndUsers,
  closeTestDbPool,
  createMinimalValidPng,
  getTestDbAndPool,
  isSafeTestDbConfigured,
  startIntegratedTestServer,
  uniqueRunTag,
  verifyRegisteredUserEmail,
} from './_helpers.ts';

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

after(async () => {
  await cleanupTestOrganizationsAndUsers({
    orgIds: createdOrgIds,
    userIds: createdUserIds,
  });
  await closeTestDbPool();
});

test('usagePolicy constants expose unvalidated tier hypotheses and safe legacy fallback', () => {
  assert.equal(PLAN_POLICIES.starter.monthlyExtractionLimit, 60);
  assert.equal(PLAN_POLICIES.starter.storageLimitBytes, 5 * GIBIBYTE);
  assert.equal(PLAN_POLICIES.starter.isUnvalidatedHypothesis, true);

  assert.equal(PLAN_POLICIES.professional.monthlyExtractionLimit, 250);
  assert.equal(PLAN_POLICIES.professional.storageLimitBytes, 25 * GIBIBYTE);

  assert.equal(PLAN_POLICIES.business.monthlyExtractionLimit, 800);
  assert.equal(PLAN_POLICIES.business.storageLimitBytes, 100 * GIBIBYTE);

  assert.equal(PLAN_POLICIES.legacy.monthlyExtractionLimit, null);
  assert.equal(PLAN_POLICIES.legacy.storageLimitBytes, null);
  assert.equal(PLAN_POLICIES.legacy.nonBlockingByDefault, true);
  assert.equal(PLAN_POLICIES.legacy.isUnvalidatedHypothesis, false);

  assert.equal(normalizePlanTier(undefined), 'legacy');
  assert.equal(normalizePlanTier('unknown-plan'), 'legacy');
  assert.equal(normalizePlanTier('STARTER'), 'starter');

  assert.equal(resolveDefaultNewOrgPlan({}), 'starter');
  assert.equal(resolveDefaultNewOrgPlan({ DEFAULT_NEW_ORG_PLAN: 'professional' }), 'professional');
  assert.equal(resolveDefaultNewOrgPlan({ DEFAULT_NEW_ORG_PLAN: 'invalid' }), 'starter');

  const overridePolicy = resolveEffectiveOrganizationPolicy({
    planTier: 'starter',
    monthlyExtractionLimitOverride: 15,
    storageLimitBytesOverride: 4096,
  });
  assert.equal(overridePolicy.monthlyExtractionLimit, 15);
  assert.equal(overridePolicy.storageLimitBytes, 4096);
  assert.equal(overridePolicy.isMonthlyLimitOverride, true);
  assert.equal(overridePolicy.isStorageLimitOverride, true);

  assert.equal(validateOptionalIdempotencyKey(undefined).valid, true);
  assert.equal(validateOptionalIdempotencyKey('short').valid, false);
  assert.equal(validateOptionalIdempotencyKey('req-key-2026-0001').valid, true);
});

test('InMemoryUsageQuotaCoordinator enforces Starter/Pro/Business limits, N vs N+1, legacy access, storage deletion, and UTC month rollover', () => {
  const coord = new InMemoryUsageQuotaCoordinator();
  const novEnd = new Date('2026-11-30T23:59:59.000Z');
  const decStart = new Date('2026-12-01T00:00:00.000Z');

  // 1. Starter plan exact boundary: 60 succeed, 61st fails
  coord.registerOrganization({ id: 'org-starter', planTier: 'starter' });
  for (let i = 1; i <= 60; i += 1) {
    const r = coord.reserve({
      organizationId: 'org-starter',
      rfqId: 'rfq-1',
      supplierId: 'sup-1',
      reservedBytes: 1024,
      now: novEnd,
    });
    assert.equal(r.kind, 'reserved');
    if (r.kind === 'reserved') {
      coord.commit({
        reservationId: r.reservationId,
        quotationId: `q-${i}`,
        documentId: `d-${i}`,
        storedBytes: 1024,
        now: novEnd,
      });
    }
  }
  assert.throws(
    () =>
      coord.reserve({
        organizationId: 'org-starter',
        rfqId: 'rfq-1',
        supplierId: 'sup-1',
        reservedBytes: 1024,
        now: novEnd,
      }),
    (err: unknown) =>
      err instanceof QuotaExceededError &&
      err.statusCode === 429 &&
      err.code === 'MONTHLY_EXTRACTION_QUOTA_EXCEEDED' &&
      err.details.limit === 60 &&
      err.details.used === 60 &&
      err.details.remaining === 0 &&
      err.details.resetAt === '2026-12-01T00:00:00.000Z'
  );

  // 2. UTC month rollover resets monthly count cleanly at 00:00:00Z Dec 1
  const decRes = coord.reserve({
    organizationId: 'org-starter',
    rfqId: 'rfq-1',
    supplierId: 'sup-1',
    reservedBytes: 1024,
    now: decStart,
  });
  assert.equal(decRes.kind, 'reserved');
  if (decRes.kind === 'reserved') {
    assert.equal(decRes.periodMonth, '2026-12');
    coord.commit({ reservationId: decRes.reservationId, quotationId: 'q-dec-1', now: decStart });
  }
  assert.equal(coord.getSummary('org-starter', decStart).extractions.remaining, 59);

  // 3. Storage limit enforcement & reclaim on document delete
  coord.registerOrganization({
    id: 'org-stor',
    planTier: 'starter',
    storageLimitBytesOverride: 3000,
  });
  const s1 = coord.reserve({
    organizationId: 'org-stor',
    rfqId: 'rfq-1',
    supplierId: 'sup-1',
    reservedBytes: 2000,
    now: decStart,
  });
  assert.equal(s1.kind, 'reserved');
  if (s1.kind === 'reserved') {
    coord.commit({
      reservationId: s1.reservationId,
      quotationId: 'q-s1',
      documentId: 'doc-s1',
      storedBytes: 2000,
      now: decStart,
    });
  }
  // 2000 + 1500 = 3500 > 3000 -> blocked
  assert.throws(
    () =>
      coord.reserve({
        organizationId: 'org-stor',
        rfqId: 'rfq-1',
        supplierId: 'sup-1',
        reservedBytes: 1500,
        now: decStart,
      }),
    (err: unknown) =>
      err instanceof QuotaExceededError &&
      err.code === 'STORAGE_QUOTA_EXCEEDED' &&
      err.details.used === 2000 &&
      err.details.limit === 3000 &&
      err.details.remaining === 1000
  );
  // Deleting doc-s1 reclaims 2000 bytes immediately
  coord.deleteStoredDocument('doc-s1');
  const s2 = coord.reserve({
    organizationId: 'org-stor',
    rfqId: 'rfq-1',
    supplierId: 'sup-1',
    reservedBytes: 1500,
    now: decStart,
  });
  assert.equal(s2.kind, 'reserved');

  // 4. Legacy organization remains non-blocking unless explicit override is applied
  coord.registerOrganization({ id: 'org-legacy', planTier: 'legacy' });
  const legRes = coord.reserve({
    organizationId: 'org-legacy',
    rfqId: 'rfq-1',
    supplierId: 'sup-1',
    reservedBytes: 200 * GIBIBYTE,
    now: decStart,
  });
  assert.equal(legRes.kind, 'reserved');
  assert.equal(coord.getSummary('org-legacy', decStart).extractions.limit, null);
});

test('InMemoryUsageQuotaCoordinator releases quota on failures, prevents concurrent oversubscription, and supports idempotent retries', async () => {
  const coord = new InMemoryUsageQuotaCoordinator();
  const now = new Date('2026-11-15T12:00:00.000Z');
  coord.registerOrganization({
    id: 'org-conc',
    planTier: 'starter',
    monthlyExtractionLimitOverride: 2,
  });

  // Failed extraction releases reservation and never consumes doc slot
  const failedRes = coord.reserve({
    organizationId: 'org-conc',
    rfqId: 'rfq-1',
    supplierId: 'sup-1',
    reservedBytes: 500,
    idempotencyKey: 'retry-after-fail-01',
    now,
  });
  assert.equal(failedRes.kind, 'reserved');
  if (failedRes.kind === 'reserved') {
    coord.release({
      reservationId: failedRes.reservationId,
      tokenUsage: {
        model: 'gemini-4-hydrogen',
        usageAvailable: false,
        promptTokenCount: null,
        candidatesTokenCount: null,
        totalTokenCount: null,
        thoughtsTokenCount: null,
      },
      now,
    });
  }
  assert.equal(coord.getSummary('org-conc', now).extractions.committed, 0);
  assert.equal(coord.getSummary('org-conc', now).extractions.activeReserved, 0);
  assert.equal(coord.getSummary('org-conc', now).tokens.unavailableEventsCount, 1);

  // Retrying with same Idempotency-Key after released failure succeeds once and idempotent replay returns same quotation
  const retryRes = coord.reserve({
    organizationId: 'org-conc',
    rfqId: 'rfq-1',
    supplierId: 'sup-1',
    reservedBytes: 500,
    idempotencyKey: 'retry-after-fail-01',
    now,
  });
  assert.equal(retryRes.kind, 'reserved');
  if (retryRes.kind === 'reserved') {
    coord.commit({
      reservationId: retryRes.reservationId,
      quotationId: 'q-retry-ok',
      now,
    });
  }
  const idempReplay = coord.reserve({
    organizationId: 'org-conc',
    rfqId: 'rfq-1',
    supplierId: 'sup-1',
    reservedBytes: 500,
    idempotencyKey: 'retry-after-fail-01',
    now,
  });
  assert.deepEqual(idempReplay, { kind: 'idempotent_hit', quotationId: 'q-retry-ok' });

  // Remaining quota is 1 -> launch 4 concurrent extractions; only 1 should succeed
  const results = await Promise.all(
    [1, 2, 3, 4].map(async (idx) => {
      try {
        const res = coord.reserve({
          organizationId: 'org-conc',
          rfqId: 'rfq-1',
          supplierId: `sup-${idx}`,
          reservedBytes: 100,
          now,
        });
        await new Promise((r) => setTimeout(r, 15));
        if (res.kind === 'reserved') {
          coord.commit({ reservationId: res.reservationId, quotationId: `q-c-${idx}`, now });
        }
        return 'ok';
      } catch (err) {
        if (err instanceof QuotaExceededError) return 'quota_429';
        throw err;
      }
    })
  );
  assert.equal(results.filter((r) => r === 'ok').length, 1);
  assert.equal(results.filter((r) => r === 'quota_429').length, 3);
  assert.equal(coord.getSummary('org-conc', now).extractions.committed, 2);
});

test('extractQuotationWithTelemetry records real usageMetadata and safely flags missing metadata without inventing counts', async () => {
  const missingMeta = normalizeGeminiUsageMetadata(undefined);
  assert.equal(missingMeta.usageAvailable, false);
  assert.equal(missingMeta.promptTokenCount, null);
  assert.equal(missingMeta.candidatesTokenCount, null);
  assert.equal(missingMeta.totalTokenCount, null);

  const ws = createInitialWorkspaceState();
  const rfq = ws.rfqs[0];

  // 1. Real usageMetadata observed
  const okResult = await extractQuotationWithTelemetry({
    rfq,
    supplierId: ws.suppliers[0].id,
    settings: ws.settings,
    documentName: 'quote.txt',
    mimeType: 'text/plain',
    rawEmailText: 'Line 1 qty 10 rate 200',
    generateContentOverride: async () => ({
      text: JSON.stringify({
        quoteReference: 'TOK-1',
        currency: 'INR',
        taxIncludedInRates: false,
        missingFreightWarning: false,
        lines: [
          {
            vendorLineNo: 1,
            rawDescription: rfq.items[0].description,
            matchedRfqItemId: rfq.items[0].id,
            matchStatus: 'matched',
            quotedQty: rfq.items[0].quantity,
            quotedUom: rfq.items[0].uom,
            uomConversionFactor: 1,
            quotedUnitRate: 200,
            discountAmount: 0,
            taxRatePct: 18,
            lineTotalQuoted: rfq.items[0].quantity * 200,
            confidenceScore: 0.95,
            snippet: 'Item 1 @ 200',
          },
        ],
      }),
      usageMetadata: {
        promptTokenCount: 1420,
        candidatesTokenCount: 315,
        totalTokenCount: 1850,
        thoughtsTokenCount: 115,
      },
    }),
  });
  assert.equal(okResult.tokenUsage.usageAvailable, true);
  assert.equal(okResult.tokenUsage.promptTokenCount, 1420);
  assert.equal(okResult.tokenUsage.candidatesTokenCount, 315);
  assert.equal(okResult.tokenUsage.totalTokenCount, 1850);
  assert.equal(okResult.tokenUsage.thoughtsTokenCount, 115);

  // 2. Absent usageMetadata recorded transparently as unavailable
  const noMetaResult = await extractQuotationWithTelemetry({
    rfq,
    supplierId: ws.suppliers[0].id,
    settings: ws.settings,
    documentName: 'quote2.txt',
    mimeType: 'text/plain',
    rawEmailText: 'Line 1 qty 10 rate 210',
    generateContentOverride: async () => ({
      text: JSON.stringify({
        quoteReference: 'TOK-2',
        currency: 'INR',
        taxIncludedInRates: false,
        missingFreightWarning: false,
        lines: [],
      }),
    }),
  });
  assert.equal(noMetaResult.tokenUsage.usageAvailable, false);
  assert.equal(noMetaResult.tokenUsage.totalTokenCount, null);

  // 3. Malformed AI JSON still preserves observed tokenUsage on ExtractionServiceError
  await assert.rejects(
    () =>
      extractQuotationWithTelemetry({
        rfq,
        supplierId: ws.suppliers[0].id,
        settings: ws.settings,
        documentName: 'bad.txt',
        mimeType: 'text/plain',
        rawEmailText: 'broken quote',
        generateContentOverride: async () => ({
          text: '{bad json',
          usageMetadata: {
            promptTokenCount: 500,
            candidatesTokenCount: 12,
            totalTokenCount: 512,
          },
        }),
      }),
    (err: unknown) =>
      err instanceof ExtractionServiceError &&
      err.tokenUsage?.usageAvailable === true &&
      err.tokenUsage.totalTokenCount === 512
  );
});

test('DEMO_MODE extraction remains isolated and unaffected by production quota enforcement', async () => {
  const srv = await startIntegratedTestServer({ demoMode: true });
  try {
    const demoRes = await fetch(`${srv.baseUrl}/api/demo-workspace`);
    assert.equal(demoRes.status, 200);
    const demoCookie = demoRes.headers.get('set-cookie')?.split(';')[0] || '';
    const demoBody = (await demoRes.json()) as {
      rfqs: Array<{ id: string }>;
      suppliers: Array<{ id: string }>;
    };

    const form = new FormData();
    form.set('supplierId', demoBody.suppliers[0].id);
    form.set('rawEmailText', 'Demo email quote SS304 flange rate 250');

    const extractRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/rfqs/${demoBody.rfqs[0].id}/quotes/extract`,
      {
        method: 'POST',
        headers: demoCookie ? { Cookie: demoCookie } : {},
        body: form,
      }
    );
    assert.equal(extractRes.status, 201);
  } finally {
    await srv.close();
  }
});

test('P1-1 unit: Idempotency-Key rejects RFQ/supplier mismatches and deleted quotations while preserving org isolation and released retries', () => {
  const coord = new InMemoryUsageQuotaCoordinator();
  const now = new Date('2026-11-20T10:00:00.000Z');
  coord.registerOrganization({ id: 'org-a', planTier: 'starter' });
  coord.registerOrganization({ id: 'org-b', planTier: 'starter' });

  // Released failure can be retried cleanly with same key
  const firstFail = coord.reserve({
    organizationId: 'org-a',
    rfqId: 'rfq-1',
    supplierId: 'sup-1',
    reservedBytes: 512,
    idempotencyKey: 'shared-key-0001',
    now,
  });
  assert.equal(firstFail.kind, 'reserved');
  if (firstFail.kind === 'reserved') {
    coord.release({ reservationId: firstFail.reservationId, now });
  }

  const retryOk = coord.reserve({
    organizationId: 'org-a',
    rfqId: 'rfq-1',
    supplierId: 'sup-1',
    reservedBytes: 512,
    idempotencyKey: 'shared-key-0001',
    now,
  });
  assert.equal(retryOk.kind, 'reserved');
  if (retryOk.kind === 'reserved') {
    coord.commit({
      reservationId: retryOk.reservationId,
      quotationId: 'q-a-1',
      documentId: 'doc-a-1',
      storedBytes: 512,
      now,
    });
  }

  // Legitimate replay: same org, same key, same RFQ & supplier
  assert.deepEqual(
    coord.reserve({
      organizationId: 'org-a',
      rfqId: 'rfq-1',
      supplierId: 'sup-1',
      reservedBytes: 512,
      idempotencyKey: 'shared-key-0001',
      now,
    }),
    { kind: 'idempotent_hit', quotationId: 'q-a-1' }
  );

  // Different RFQ -> 409 Conflict
  assert.throws(
    () =>
      coord.reserve({
        organizationId: 'org-a',
        rfqId: 'rfq-2',
        supplierId: 'sup-1',
        reservedBytes: 512,
        idempotencyKey: 'shared-key-0001',
        now,
      }),
    (err: unknown) => err instanceof IdempotencyConflictError && err.statusCode === 409
  );

  // Different supplier -> 409 Conflict
  assert.throws(
    () =>
      coord.reserve({
        organizationId: 'org-a',
        rfqId: 'rfq-1',
        supplierId: 'sup-2',
        reservedBytes: 512,
        idempotencyKey: 'shared-key-0001',
        now,
      }),
    (err: unknown) => err instanceof IdempotencyConflictError && err.statusCode === 409
  );

  // Another organization using the same key stays completely isolated
  const orgBRes = coord.reserve({
    organizationId: 'org-b',
    rfqId: 'rfq-b-1',
    supplierId: 'sup-b-1',
    reservedBytes: 256,
    idempotencyKey: 'shared-key-0001',
    now,
  });
  assert.equal(orgBRes.kind, 'reserved');

  // Deleting original quotation triggers deterministic 409 conflict on replay
  coord.deleteStoredDocument('doc-a-1', 'q-a-1');
  assert.throws(
    () =>
      coord.reserve({
        organizationId: 'org-a',
        rfqId: 'rfq-1',
        supplierId: 'sup-1',
        reservedBytes: 512,
        idempotencyKey: 'shared-key-0001',
        now,
      }),
    (err: unknown) => err instanceof IdempotencyConflictError && err.statusCode === 409
  );
});

test('P1-2 unit: maintenance expiry cleanup guards status="reserved" and cannot overwrite concurrently committed rows', async () => {
  const now = new Date('2026-11-27T12:00:00.000Z');
  const past = new Date('2026-11-27T11:00:00.000Z');
  const future = new Date('2026-11-27T13:00:00.000Z');

  type SimRow = { id: string; status: 'reserved' | 'committed' | 'released'; expiresAt: Date };
  const rows: SimRow[] = [
    { id: 'res-expired', status: 'reserved', expiresAt: past },
    { id: 'res-racing-commit', status: 'reserved', expiresAt: past },
    { id: 'res-active', status: 'reserved', expiresAt: future },
    { id: 'res-already-committed', status: 'committed', expiresAt: past },
  ];

  let simulateCommitBetweenSelectAndUpdate = true;
  let capturedWhereSqlChunks = '';

  const inspectSqlObject = (node: unknown): string => {
    if (!node || typeof node !== 'object') return String(node ?? '');
    const obj = node as { value?: unknown; name?: string; queryChunks?: unknown[] };
    if (typeof obj.name === 'string') return obj.name;
    if (Array.isArray(obj.value)) return obj.value.join('');
    if (Array.isArray(obj.queryChunks)) return obj.queryChunks.map(inspectSqlObject).join(' ');
    return '';
  };

  const mockDb = {
    select() {
      let tbl: unknown;
      const chain: Record<string, unknown> = {
        from(t: unknown) {
          tbl = t;
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          if (tbl === aiExtractionReservations) {
            return Promise.resolve(
              rows
                .filter((r) => r.status === 'reserved' && r.expiresAt <= now)
                .map((r) => ({ id: r.id }))
            );
          }
          return Promise.resolve([]);
        },
      };
      return chain;
    },
    delete() {
      const chain: Record<string, unknown> = {
        where() {
          return chain;
        },
        returning() {
          return Promise.resolve([]);
        },
      };
      return chain;
    },
    update(tbl: unknown) {
      let patch: Partial<SimRow> = {};
      const chain: Record<string, unknown> = {
        set(p: Partial<SimRow>) {
          patch = p;
          return chain;
        },
        where(cond: unknown) {
          if (tbl === aiExtractionReservations) {
            capturedWhereSqlChunks = inspectSqlObject(cond);
          }
          return chain;
        },
        returning() {
          if (tbl !== aiExtractionReservations) return Promise.resolve([]);
          if (simulateCommitBetweenSelectAndUpdate) {
            simulateCommitBetweenSelectAndUpdate = false;
            const raced = rows.find((r) => r.id === 'res-racing-commit');
            if (raced) raced.status = 'committed';
          }
          // Enforce the atomic SQL predicate status = 'reserved' AND expiresAt <= now
          assert.ok(capturedWhereSqlChunks.includes('status'));
          assert.ok(capturedWhereSqlChunks.includes('expires_at'));
          const updatedIds: Array<{ id: string }> = [];
          for (const r of rows) {
            if (
              (r.id === 'res-expired' || r.id === 'res-racing-commit') &&
              r.status === 'reserved' &&
              r.expiresAt <= now
            ) {
              r.status = patch.status ?? r.status;
              updatedIds.push({ id: r.id });
            }
          }
          return Promise.resolve(updatedIds);
        },
      };
      return chain;
    },
  };

  const mockStorage: ObjectStorageProvider = {
    mode: 'local',
    async putObject() {},
    async getObject() {
      return { buffer: Buffer.alloc(0), contentType: 'application/octet-stream' };
    },
    async deleteObject() {},
    async createSignedDownloadUrl() {
      return { url: '/x', expiresAt: now.toISOString() };
    },
    async checkReadiness() {
      return { ok: true };
    },
  };

  const firstRun = await runScheduledMaintenance({
    db: mockDb as never,
    storageProvider: mockStorage,
    lockPool: null,
    localStorageDir: '/tmp/norus-nonexistent-maint-dir',
    now,
  });
  assert.equal(firstRun.releasedExpiredReservations, 1);
  assert.equal(rows.find((r) => r.id === 'res-expired')?.status, 'released');
  assert.equal(rows.find((r) => r.id === 'res-racing-commit')?.status, 'committed');
  assert.equal(rows.find((r) => r.id === 'res-active')?.status, 'reserved');
  assert.equal(rows.find((r) => r.id === 'res-already-committed')?.status, 'committed');

  // Re-run is strictly idempotent
  const secondRun = await runScheduledMaintenance({
    db: mockDb as never,
    storageProvider: mockStorage,
    lockPool: null,
    localStorageDir: '/tmp/norus-nonexistent-maint-dir',
    now,
  });
  assert.equal(secondRun.releasedExpiredReservations, 0);
});

test('P2-1 route unit: POST /quotes/extract preserves observed Gemini tokenUsage across storage and DB failures without double-counting', async () => {
  const ws = createInitialWorkspaceState();
  const rfq = ws.rfqs[0];
  const supplier = ws.suppliers[0];

  let nextPutThrows = false;
  let nextSaveThrows = false;
  let nextGeminiBehavior: 'with_usage' | 'without_usage' | 'pre_response_fail' = 'with_usage';
  let seq = 0;

  const deletedKeys: string[] = [];
  const committedCalls: Array<{ reservationId: string | null | undefined; tokenUsage: AiTokenUsageTelemetry | null | undefined }> = [];
  const releasedCalls: Array<{ reservationId: string; tokenUsage: AiTokenUsageTelemetry | null | undefined }> = [];

  const mockStorage: ObjectStorageProvider = {
    mode: 'local',
    async putObject() {
      if (nextPutThrows) {
        nextPutThrows = false;
        throw new Error('Simulated S3 timeout');
      }
    },
    async getObject() {
      return { buffer: Buffer.alloc(0), contentType: 'application/octet-stream' };
    },
    async deleteObject(key: string) {
      deletedKeys.push(key);
    },
    async createSignedDownloadUrl() {
      return { url: '/signed', expiresAt: new Date().toISOString() };
    },
    async checkReadiness() {
      return { ok: true };
    },
  };

  const spyStore = {
    async getSessionContext(token: string) {
      if (token !== 'unit-session-token') return null;
      return {
        sessionId: 'sess-unit',
        csrfToken: 'unit-csrf-token',
        user: {
          id: 'user-unit',
          email: 'buyer@example.com',
          fullName: 'Unit Buyer',
          title: 'Buyer',
          emailVerified: true,
          hasPassword: true,
          hasGoogleLinked: false,
        },
        activeOrganization: {
          id: 'org-unit',
          slug: 'org-unit',
          name: 'Unit Org',
          countryCode: 'IN',
          defaultCurrency: 'INR' as const,
          taxRegime: 'INDIA_GST' as const,
          defaultTaxCreditable: true,
          role: 'buyer' as const,
          planTier: 'starter' as const,
        },
        organizations: [],
      };
    },
    async getExtractionContext() {
      return { rfq, settings: ws.settings, supplierName: supplier.name };
    },
    async reserveExtractionAndStorageQuota() {
      seq += 1;
      return { kind: 'reserved' as const, reservationId: `res-unit-${seq}`, periodMonth: '2026-11' };
    },
    async saveExtractedQuotation(params: {
      quotation: (typeof ws.quotations)[number];
      reservationId?: string | null;
      tokenUsage?: AiTokenUsageTelemetry | null;
    }) {
      if (nextSaveThrows) {
        nextSaveThrows = false;
        throw new StoreError(409, 'Simulated DB save failure');
      }
      committedCalls.push({ reservationId: params.reservationId, tokenUsage: params.tokenUsage });
      return params.quotation;
    },
    async releaseExtractionReservation(params: {
      reservationId: string;
      tokenUsage?: AiTokenUsageTelemetry | null;
    }) {
      releasedCalls.push({ reservationId: params.reservationId, tokenUsage: params.tokenUsage });
    },
  } as unknown as PgDataStore;

  const app = await createApp({
    enableVite: false,
    demoMode: false,
    db: {} as never,
    rateLimitStore: new MemoryRateLimitStore(),
    store: spyStore,
    storageProvider: mockStorage,
    generateContentOverride: async () => {
      if (nextGeminiBehavior === 'pre_response_fail') {
        throw new Error('Upstream Gemini socket reset');
      }
      const baseText = JSON.stringify({
        quoteReference: 'P2-1-TEST',
        currency: 'INR',
        taxIncludedInRates: false,
        missingFreightWarning: false,
        lines: [],
      });
      if (nextGeminiBehavior === 'without_usage') {
        return { text: baseText };
      }
      return {
        text: baseText,
        usageMetadata: {
          promptTokenCount: 310,
          candidatesTokenCount: 100,
          totalTokenCount: 410,
          thoughtsTokenCount: 0,
        },
      };
    },
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const postPngExtract = () => {
    const form = new FormData();
    form.set('supplierId', supplier.id);
    form.set(
      'file',
      new Blob([new Uint8Array(createMinimalValidPng())], { type: 'image/png' }),
      'quote.png'
    );
    return fetch(`${baseUrl}/api/rfqs/${rfq.id}/quotes/extract`, {
      method: 'POST',
      headers: {
        Cookie: 'nf_session=unit-session-token',
        'X-CSRF-Token': 'unit-csrf-token',
      },
      body: form,
    });
  };

  try {
    // 1. Gemini succeeds with usageMetadata, then object storage putObject fails
    nextGeminiBehavior = 'with_usage';
    nextPutThrows = true;
    const r1 = await postPngExtract();
    assert.equal(r1.status, 500);
    assert.equal(releasedCalls.length, 1);
    assert.equal(releasedCalls[0].tokenUsage?.usageAvailable, true);
    assert.equal(releasedCalls[0].tokenUsage?.promptTokenCount, 310);
    assert.equal(releasedCalls[0].tokenUsage?.candidatesTokenCount, 100);
    assert.equal(releasedCalls[0].tokenUsage?.totalTokenCount, 410);
    assert.equal(committedCalls.length, 0);

    // 2. Gemini succeeds with usageMetadata, then DB persistence fails (storage object rolled back + tokens preserved)
    nextGeminiBehavior = 'with_usage';
    nextSaveThrows = true;
    const r2 = await postPngExtract();
    assert.equal(r2.status, 409);
    assert.equal(deletedKeys.length, 1);
    assert.equal(releasedCalls.length, 2);
    assert.equal(releasedCalls[1].tokenUsage?.usageAvailable, true);
    assert.equal(releasedCalls[1].tokenUsage?.totalTokenCount, 410);
    assert.equal(committedCalls.length, 0);

    // 3. Gemini succeeds with missing usageMetadata, then storage fails
    nextGeminiBehavior = 'without_usage';
    nextPutThrows = true;
    const r3 = await postPngExtract();
    assert.equal(r3.status, 500);
    assert.equal(releasedCalls.length, 3);
    assert.equal(releasedCalls[2].tokenUsage?.usageAvailable, false);
    assert.equal(releasedCalls[2].tokenUsage?.totalTokenCount, null);

    // 4. Gemini fails before returning a response
    nextGeminiBehavior = 'pre_response_fail';
    const r4 = await postPngExtract();
    assert.equal(r4.status, 502);
    assert.equal(releasedCalls.length, 4);
    assert.equal(releasedCalls[3].tokenUsage?.usageAvailable, false);
    assert.equal(releasedCalls[3].tokenUsage?.totalTokenCount, null);

    // 5. Successful extraction records token telemetry once & never invokes release
    nextGeminiBehavior = 'with_usage';
    const r5 = await postPngExtract();
    assert.equal(r5.status, 201);
    assert.equal(committedCalls.length, 1);
    assert.equal(committedCalls[0].tokenUsage?.usageAvailable, true);
    assert.equal(committedCalls[0].tokenUsage?.totalTokenCount, 410);
    assert.equal(releasedCalls.length, 4);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('Task 019A route unit: missing or placeholder GEMINI_API_KEY returns 503 and releases quota reservation without fabricating tokens', async () => {
  const ws = createInitialWorkspaceState();
  const rfq = ws.rfqs[0];
  const supplier = ws.suppliers[0];

  let seq = 0;
  const releasedCalls: Array<{ reservationId: string; tokenUsage: AiTokenUsageTelemetry | null | undefined }> = [];

  const mockStorage: ObjectStorageProvider = {
    mode: 'local',
    async putObject() {},
    async getObject() {
      return { buffer: Buffer.alloc(0), contentType: 'application/octet-stream' };
    },
    async deleteObject() {},
    async createSignedDownloadUrl() {
      return { url: '/signed', expiresAt: new Date().toISOString() };
    },
    async checkReadiness() {
      return { ok: true };
    },
  };

  const spyStore = {
    async getSessionContext(token: string) {
      if (token !== 'unit-session-token') return null;
      return {
        sessionId: 'sess-unit-503',
        csrfToken: 'unit-csrf-token',
        user: {
          id: 'user-unit',
          email: 'buyer@example.com',
          fullName: 'Unit Buyer',
          title: 'Buyer',
          emailVerified: true,
          hasPassword: true,
          hasGoogleLinked: false,
        },
        activeOrganization: {
          id: 'org-unit',
          slug: 'org-unit',
          name: 'Unit Org',
          countryCode: 'IN',
          defaultCurrency: 'INR' as const,
          taxRegime: 'INDIA_GST' as const,
          defaultTaxCreditable: true,
          role: 'buyer' as const,
          planTier: 'starter' as const,
        },
        organizations: [],
      };
    },
    async getExtractionContext() {
      return { rfq, settings: ws.settings, supplierName: supplier.name };
    },
    async reserveExtractionAndStorageQuota() {
      seq += 1;
      return { kind: 'reserved' as const, reservationId: `res-503-${seq}`, periodMonth: '2026-11' };
    },
    async saveExtractedQuotation() {
      throw new Error('saveExtractedQuotation must not be called when GEMINI_API_KEY is missing/placeholder');
    },
    async releaseExtractionReservation(params: {
      reservationId: string;
      tokenUsage?: AiTokenUsageTelemetry | null;
    }) {
      releasedCalls.push({ reservationId: params.reservationId, tokenUsage: params.tokenUsage });
    },
  } as unknown as PgDataStore;

  const app = await createApp({
    enableVite: false,
    demoMode: false,
    db: {} as never,
    rateLimitStore: new MemoryRateLimitStore(),
    store: spyStore,
    storageProvider: mockStorage,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const postPngExtract = () => {
    const form = new FormData();
    form.set('supplierId', supplier.id);
    form.set(
      'file',
      new Blob([new Uint8Array(createMinimalValidPng())], { type: 'image/png' }),
      'quote.png'
    );
    return fetch(`${baseUrl}/api/rfqs/${rfq.id}/quotes/extract`, {
      method: 'POST',
      headers: {
        Cookie: 'nf_session=unit-session-token',
        'X-CSRF-Token': 'unit-csrf-token',
      },
      body: form,
    });
  };

  const prevGeminiKey = process.env.GEMINI_API_KEY;
  try {
    // 1. Missing GEMINI_API_KEY -> 503 & reservation released cleanly
    delete process.env.GEMINI_API_KEY;
    const rMissing = await postPngExtract();
    assert.equal(rMissing.status, 503);
    assert.equal(releasedCalls.length, 1);
    assert.equal(releasedCalls[0].tokenUsage?.usageAvailable, false);
    assert.equal(releasedCalls[0].tokenUsage?.totalTokenCount, null);

    // 2. Placeholder GEMINI_API_KEY -> 503 (never 502) & reservation released cleanly
    process.env.GEMINI_API_KEY = 'MY_GEMINI_API_KEY';
    const rPlaceholder = await postPngExtract();
    assert.equal(rPlaceholder.status, 503);
    assert.equal(releasedCalls.length, 2);
    assert.equal(releasedCalls[1].tokenUsage?.usageAvailable, false);
    assert.equal(releasedCalls[1].tokenUsage?.totalTokenCount, null);
  } finally {
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test(
  'PostgreSQL integration: quotas, concurrency race protection, idempotency retries, storage reclaim on delete, legacy safety, and token logs',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    let returnMalformedNext = false;
    let omitUsageMetadataNext = false;

    const srv = await startIntegratedTestServer({
      generateContentOverride: async (params) => {
        if (returnMalformedNext) {
          returnMalformedNext = false;
          return {
            text: '{not valid json',
            usageMetadata: {
              promptTokenCount: 210,
              candidatesTokenCount: 15,
              totalTokenCount: 225,
            },
          };
        }
        const textPart =
          params.contents.parts.find((p): p is { text: string } => 'text' in p)?.text || '';
        const idMatches = [...textPart.matchAll(/rfqItemId:\s*"([^"]+)"/g)].map((m) => m[1]);
        const payload = {
          text: JSON.stringify({
            quoteReference: `Q-${Date.now().toString().slice(-4)}`,
            currency: 'INR',
            leadTimeDays: 5,
            paymentTerms: 'Net 30',
            freightCharges: 0,
            packingForwarding: 0,
            otherCharges: 0,
            globalDiscount: 0,
            taxIncludedInRates: false,
            missingFreightWarning: false,
            lines: idMatches.map((id, idx) => ({
              vendorLineNo: idx + 1,
              rawDescription: `Line ${idx + 1}`,
              matchedRfqItemId: id,
              matchStatus: 'matched',
              quotedQty: 10,
              quotedUom: 'pcs',
              uomConversionFactor: 1,
              quotedUnitRate: 200,
              discountAmount: 0,
              taxRatePct: 18,
              lineTotalQuoted: 2000,
              confidenceScore: 0.94,
              snippet: `Line ${idx + 1} @ 200`,
            })),
          }),
        };
        if (omitUsageMetadataNext) {
          omitUsageMetadataNext = false;
          return payload;
        }
        return {
          ...payload,
          usageMetadata: {
            promptTokenCount: 300,
            candidatesTokenCount: 120,
            totalTokenCount: 420,
            thoughtsTokenCount: 0,
          },
        };
      },
    });

    const tag = uniqueRunTag();
    const { db } = getTestDbAndPool();

    try {
      const client = new TestCookieClient(srv.baseUrl);
      const regRes = await client.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `quota-${tag}@example.com`,
          password: 'StrongPassword#2026',
          fullName: 'Quota Tester',
          organizationName: `Quota Org ${tag}`,
        }),
      });
      assert.equal(regRes.status, 201);
      const regBody = (await regRes.json()) as {
        user: { id: string };
        activeOrganization: { id: string; planTier?: string };
      };
      const orgId = regBody.activeOrganization.id;
      createdOrgIds.push(orgId);
      createdUserIds.push(regBody.user.id);
      assert.equal(regBody.activeOrganization.planTier, 'starter');
      await verifyRegisteredUserEmail(srv.baseUrl, srv.emailProvider, `quota-${tag}@example.com`);

      // PATCH /api/settings ignores planTier & quota overrides
      const spoofRes = await client.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Quota Org ${tag} Updated`,
          planTier: 'business',
          monthlyExtractionLimitOverride: 999999,
        }),
      });
      assert.equal(spoofRes.status, 200);

      const usageInitRes = await client.request('/api/organization/usage');
      assert.equal(usageInitRes.status, 200);
      const usageInit = (await usageInitRes.json()) as {
        planTier: string;
        isUnvalidatedHypothesis: boolean;
        extractions: { limit: number; committed: number; remaining: number };
        tokens: { costVerified: boolean };
      };
      assert.equal(usageInit.planTier, 'starter');
      assert.equal(usageInit.isUnvalidatedHypothesis, true);
      assert.equal(usageInit.extractions.limit, 60);
      assert.equal(usageInit.extractions.committed, 0);
      assert.equal(usageInit.extractions.remaining, 60);
      assert.equal(usageInit.tokens.costVerified, false);

      // Create supplier + RFQ
      const supRes = await client.request('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Sup-${tag}`, taxId: `27TEST${tag.slice(0, 6).toUpperCase()}` }),
      });
      const sup = (await supRes.json()) as { id: string };

      const rfqRes = await client.request('/api/rfqs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Quota RFQ ${tag}`,
          items: [{ description: 'SS304 Bolt', quantity: 10, uom: 'pcs' }],
          invitedSupplierIds: [sup.id],
        }),
      });
      const rfq = (await rfqRes.json()) as { id: string };

      // Failed AI extraction releases reservation & logs failed token event
      returnMalformedNext = true;
      const failForm = new FormData();
      failForm.set('supplierId', sup.id);
      failForm.set('rawEmailText', 'Broken AI quote');
      const failRes = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        body: failForm,
      });
      assert.equal(failRes.status, 502);

      const afterFailUsage = (await (await client.request('/api/organization/usage')).json()) as {
        extractions: { committed: number; activeReserved: number };
        tokens: { totalTokens: number };
      };
      assert.equal(afterFailUsage.extractions.committed, 0);
      assert.equal(afterFailUsage.extractions.activeReserved, 0);
      assert.equal(afterFailUsage.tokens.totalTokens, 225);

      // Missing usageMetadata increments unavailableEventsCount cleanly
      omitUsageMetadataNext = true;
      const formNoMeta = new FormData();
      formNoMeta.set('supplierId', sup.id);
      formNoMeta.set('rawEmailText', 'Valid quote without usageMetadata');
      const noMetaRes = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idemp-${tag}-1` },
        body: formNoMeta,
      });
      assert.equal(noMetaRes.status, 201);
      const qNoMeta = (await noMetaRes.json()) as { id: string };

      // Replay with same Idempotency-Key returns 200 without consuming extra extraction
      const formReplay = new FormData();
      formReplay.set('supplierId', sup.id);
      formReplay.set('rawEmailText', 'Valid quote without usageMetadata');
      const replayRes = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idemp-${tag}-1` },
        body: formReplay,
      });
      assert.equal(replayRes.status, 200);
      const qReplay = (await replayRes.json()) as { id: string };
      assert.equal(qReplay.id, qNoMeta.id);

      const afterIdempUsage = (await (await client.request('/api/organization/usage')).json()) as {
        extractions: { committed: number };
        tokens: { unavailableEventsCount: number };
      };
      assert.equal(afterIdempUsage.extractions.committed, 1);
      assert.equal(afterIdempUsage.tokens.unavailableEventsCount, 1);

      const rfq2Res = await client.request('/api/rfqs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Quota RFQ 2 ${tag}`,
          items: [{ description: 'SS304 Nut', quantity: 5, uom: 'pcs' }],
          invitedSupplierIds: [sup.id],
        }),
      });
      const rfq2 = (await rfq2Res.json()) as { id: string };

      const sup2Res = await client.request('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Sup2-${tag}`, taxId: `27ALT${tag.slice(0, 6).toUpperCase()}` }),
      });
      const sup2 = (await sup2Res.json()) as { id: string };

      // P1-1: Reusing same Idempotency-Key for a different RFQ or different supplier returns 409 Conflict
      const diffRfqForm = new FormData();
      diffRfqForm.set('supplierId', sup.id);
      diffRfqForm.set('rawEmailText', 'Should not return rfq1 quotation');
      const diffRfqRes = await client.request(`/api/rfqs/${rfq2.id}/quotes/extract`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idemp-${tag}-1` },
        body: diffRfqForm,
      });
      assert.equal(diffRfqRes.status, 409);

      const diffSupForm = new FormData();
      diffSupForm.set('supplierId', sup2.id);
      diffSupForm.set('rawEmailText', 'Should not return sup1 quotation');
      const diffSupRes = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idemp-${tag}-1` },
        body: diffSupForm,
      });
      assert.equal(diffSupRes.status, 409);

      // P1-1: Another organization using the exact same Idempotency-Key succeeds independently with zero cross-tenant exposure
      const otherClient = new TestCookieClient(srv.baseUrl);
      const otherReg = await otherClient.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `quota-other-${tag}@example.com`,
          password: 'StrongPassword#2026',
          fullName: 'Other Org Tester',
          organizationName: `Other Quota Org ${tag}`,
        }),
      });
      assert.equal(otherReg.status, 201);
      const otherBody = (await otherReg.json()) as {
        user: { id: string };
        activeOrganization: { id: string };
      };
      createdOrgIds.push(otherBody.activeOrganization.id);
      createdUserIds.push(otherBody.user.id);
      await verifyRegisteredUserEmail(
        srv.baseUrl,
        srv.emailProvider,
        `quota-other-${tag}@example.com`
      );

      const otherSup = (await (
        await otherClient.request('/api/suppliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `OtherSup-${tag}` }),
        })
      ).json()) as { id: string };
      const otherRfq = (await (
        await otherClient.request('/api/rfqs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `Other RFQ ${tag}`,
            items: [{ description: 'Item', quantity: 2, uom: 'pcs' }],
            invitedSupplierIds: [otherSup.id],
          }),
        })
      ).json()) as { id: string };
      const otherForm = new FormData();
      otherForm.set('supplierId', otherSup.id);
      otherForm.set('rawEmailText', 'Other org quote with identical idempotency key');
      const otherExtract = await otherClient.request(`/api/rfqs/${otherRfq.id}/quotes/extract`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idemp-${tag}-1` },
        body: otherForm,
      });
      assert.equal(otherExtract.status, 201);

      // P2-2: Tight storage limit -> upload PNG #1 -> reject PNG #2 (429) -> DELETE PNG #1 -> upload PNG #2 WITHOUT raising limit
      const pngBuf = createMinimalValidPng();
      const singlePngSize = pngBuf.byteLength;
      await db
        .update(organizations)
        .set({
          monthlyExtractionLimitOverride: 10,
          storageLimitBytesOverride: singlePngSize + 10, // room for 1 PNG, not 2
        })
        .where(eq(organizations.id, orgId));

      const uploadForm1 = new FormData();
      uploadForm1.set('supplierId', sup.id);
      uploadForm1.set('file', new Blob([new Uint8Array(pngBuf)], { type: 'image/png' }), 'quote1.png');
      const up1 = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idemp-${tag}-png1` },
        body: uploadForm1,
      });
      assert.equal(up1.status, 201);
      const qPng1 = (await up1.json()) as { id: string };

      const usageAfterPng1 = (await (await client.request('/api/organization/usage')).json()) as {
        storage: { usedBytes: number; activeReservedBytes: number };
      };
      assert.equal(usageAfterPng1.storage.usedBytes, singlePngSize);
      assert.equal(usageAfterPng1.storage.activeReservedBytes, 0);

      const uploadForm2Blocked = new FormData();
      uploadForm2Blocked.set('supplierId', sup.id);
      uploadForm2Blocked.set('file', new Blob([new Uint8Array(pngBuf)], { type: 'image/png' }), 'quote2.png');
      const up2 = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        body: uploadForm2Blocked,
      });
      assert.equal(up2.status, 429);
      const up2Body = (await up2.json()) as { code: string };
      assert.equal(up2Body.code, 'STORAGE_QUOTA_EXCEEDED');

      // Delete first PNG quotation -> storage reclaimed immediately
      const delRes = await client.request(`/api/quotations/${qPng1.id}`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);

      // P1-1: Replaying the deleted quotation's Idempotency-Key returns deterministic 409 (never 500)
      const deletedReplayForm = new FormData();
      deletedReplayForm.set('supplierId', sup.id);
      deletedReplayForm.set('file', new Blob([new Uint8Array(pngBuf)], { type: 'image/png' }), 'quote1.png');
      const deletedReplayRes = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idemp-${tag}-png1` },
        body: deletedReplayForm,
      });
      assert.equal(deletedReplayRes.status, 409);

      const usageAfterDelete = (await (await client.request('/api/organization/usage')).json()) as {
        storage: { usedBytes: number; activeReservedBytes: number };
      };
      assert.equal(usageAfterDelete.storage.usedBytes, 0);
      assert.equal(usageAfterDelete.storage.activeReservedBytes, 0);

      // Upload second PNG WITHOUT increasing storageLimitBytesOverride -> succeeds
      const uploadForm2Ok = new FormData();
      uploadForm2Ok.set('supplierId', sup.id);
      uploadForm2Ok.set('file', new Blob([new Uint8Array(pngBuf)], { type: 'image/png' }), 'quote2.png');
      const up2Retry = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        body: uploadForm2Ok,
      });
      assert.equal(up2Retry.status, 201);

      const usageAfterPng2 = (await (await client.request('/api/organization/usage')).json()) as {
        storage: { usedBytes: number; activeReservedBytes: number };
      };
      assert.equal(usageAfterPng2.storage.usedBytes, singlePngSize);
      assert.equal(usageAfterPng2.storage.activeReservedBytes, 0);

      // Parallel concurrency test: currently committed = 3 (qNoMeta, qPng1, qPng2); set limit = 5 -> 2 slots left
      await db
        .update(organizations)
        .set({
          monthlyExtractionLimitOverride: 5,
          storageLimitBytesOverride: singlePngSize * 10,
        })
        .where(eq(organizations.id, orgId));

      const parallelStatuses = await Promise.all(
        [1, 2, 3, 4].map(async (idx) => {
          const f = new FormData();
          f.set('supplierId', sup.id);
          f.set('rawEmailText', `Concurrent email quote #${idx}`);
          const res = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
            method: 'POST',
            body: f,
          });
          return res.status;
        })
      );
      assert.equal(parallelStatuses.filter((s) => s === 201).length, 2);
      assert.equal(parallelStatuses.filter((s) => s === 429).length, 2);

      // P1-2 PG test: maintenance releases expired 'reserved' row and NEVER overwrites 'committed' row (even with past expiresAt)
      const pastExpiry = new Date(Date.now() - 60_000);
      const futureExpiry = new Date(Date.now() + 600_000);
      const expResId = `res-pg-exp-${tag}`;
      const actResId = `res-pg-act-${tag}`;
      const commPastResId = `res-pg-comm-${tag}`;
      const periodMonth = getUtcPeriodBounds().periodMonth;

      await db.insert(aiExtractionReservations).values([
        {
          id: expResId,
          organizationId: orgId,
          periodMonth,
          rfqId: rfq.id,
          supplierId: sup.id,
          idempotencyKey: null,
          reservedBytes: 123,
          status: 'reserved',
          expiresAt: pastExpiry,
        },
        {
          id: actResId,
          organizationId: orgId,
          periodMonth,
          rfqId: rfq.id,
          supplierId: sup.id,
          idempotencyKey: null,
          reservedBytes: 123,
          status: 'reserved',
          expiresAt: futureExpiry,
        },
        {
          id: commPastResId,
          organizationId: orgId,
          periodMonth,
          rfqId: rfq.id,
          supplierId: sup.id,
          idempotencyKey: null,
          reservedBytes: 123,
          status: 'committed',
          quotationId: qNoMeta.id,
          expiresAt: pastExpiry,
          finalizedAt: pastExpiry,
        },
      ]);

      const maint1 = await runScheduledMaintenance({
        db,
        storageProvider: srv.storageProvider,
        localStorageDir: srv.storageDir,
      });
      assert.ok((maint1.releasedExpiredReservations ?? 0) >= 1);

      const [expAfter] = await db
        .select()
        .from(aiExtractionReservations)
        .where(eq(aiExtractionReservations.id, expResId));
      const [actAfter] = await db
        .select()
        .from(aiExtractionReservations)
        .where(eq(aiExtractionReservations.id, actResId));
      const [commAfter] = await db
        .select()
        .from(aiExtractionReservations)
        .where(eq(aiExtractionReservations.id, commPastResId));
      assert.equal(expAfter?.status, 'released');
      assert.equal(actAfter?.status, 'reserved');
      assert.equal(commAfter?.status, 'committed');

      // Re-running maintenance is idempotent
      const maint2 = await runScheduledMaintenance({
        db,
        storageProvider: srv.storageProvider,
        localStorageDir: srv.storageDir,
      });
      assert.equal(maint2.releasedExpiredReservations, 0);

      // Clean up active synthetic test reservation before final assertion
      await db
        .update(aiExtractionReservations)
        .set({ status: 'released' })
        .where(eq(aiExtractionReservations.id, actResId));

      // Legacy plan org bypasses starter quota cleanly
      await db
        .update(organizations)
        .set({
          planTier: 'legacy',
          monthlyExtractionLimitOverride: null,
          storageLimitBytesOverride: null,
        })
        .where(eq(organizations.id, orgId));

      const legacyForm = new FormData();
      legacyForm.set('supplierId', sup.id);
      legacyForm.set('rawEmailText', 'Legacy non-blocking quote');
      const legacyRes = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        body: legacyForm,
      });
      assert.equal(legacyRes.status, 201);

      const [monthlyDbRow] = await db
        .select()
        .from(organizationMonthlyUsage)
        .where(eq(organizationMonthlyUsage.organizationId, orgId));
      assert.equal(monthlyDbRow.periodMonth, periodMonth);
      assert.equal(monthlyDbRow.committedExtractions, 6);

      const tokRows = await db
        .select()
        .from(aiTokenUsageLogs)
        .where(eq(aiTokenUsageLogs.organizationId, orgId));
      assert.ok(tokRows.length >= 7);

      const resRows = await db
        .select()
        .from(aiExtractionReservations)
        .where(eq(aiExtractionReservations.organizationId, orgId));
      assert.equal(resRows.filter((r) => r.status === 'reserved').length, 0);
    } finally {
      await srv.close();
    }
  }
);
