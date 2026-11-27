import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import {
  ExtractionServiceError,
  extractQuotationWithTelemetry,
  normalizeGeminiUsageMetadata,
} from '../server/geminiExtractor.ts';
import { createInitialWorkspaceState } from '../server/seedData.ts';
import {
  GIBIBYTE,
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

      // Set strict storage + extraction overrides to test storage enforcement, delete reclaim, and parallel concurrency
      const pngBuf = createMinimalValidPng();
      const singlePngSize = pngBuf.byteLength;
      await db
        .update(organizations)
        .set({
          monthlyExtractionLimitOverride: 3, // already 1 used -> 2 slots left
          storageLimitBytesOverride: singlePngSize + 10, // room for 1 PNG, not 2
        })
        .where(eq(organizations.id, orgId));

      const uploadForm1 = new FormData();
      uploadForm1.set('supplierId', sup.id);
      uploadForm1.set('file', new Blob([new Uint8Array(pngBuf)], { type: 'image/png' }), 'quote1.png');
      const up1 = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        body: uploadForm1,
      });
      assert.equal(up1.status, 201);
      const qPng1 = (await up1.json()) as { id: string };

      const uploadForm2 = new FormData();
      uploadForm2.set('supplierId', sup.id);
      uploadForm2.set('file', new Blob([new Uint8Array(pngBuf)], { type: 'image/png' }), 'quote2.png');
      const up2 = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        body: uploadForm2,
      });
      assert.equal(up2.status, 429);
      const up2Body = (await up2.json()) as { code: string };
      assert.equal(up2Body.code, 'STORAGE_QUOTA_EXCEEDED');

      // Delete first PNG quotation -> storage reclaimed immediately -> next PNG succeeds (3rd extraction slot)
      const delRes = await client.request(`/api/quotations/${qPng1.id}`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);

      // Raise extraction override to 4 and allow storage for parallel concurrency test (2 slots left: used 2, limit 4)
      await db
        .update(organizations)
        .set({
          monthlyExtractionLimitOverride: 4,
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

      const periodMonth = getUtcPeriodBounds().periodMonth;
      const [monthlyDbRow] = await db
        .select()
        .from(organizationMonthlyUsage)
        .where(eq(organizationMonthlyUsage.organizationId, orgId));
      assert.equal(monthlyDbRow.periodMonth, periodMonth);
      assert.equal(monthlyDbRow.committedExtractions, 5);

      const tokRows = await db
        .select()
        .from(aiTokenUsageLogs)
        .where(eq(aiTokenUsageLogs.organizationId, orgId));
      assert.ok(tokRows.length >= 6);

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
