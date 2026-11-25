import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { Request } from 'express';
import { buildProductionCspPolicy, resolveTrustProxySetting } from '../server.ts';
import {
  DemoStoreError,
  DemoWorkspaceStore,
} from '../server/demoWorkspace.ts';
import {
  MigrationConflictError,
  migrateLegacyJsonToPostgres,
} from '../server/legacyMigration.ts';
import { runScheduledMaintenance } from '../server/maintenance.ts';
import { isGoogleAuthConfigured } from '../server/monitoring.ts';
import {
  LocalPrivateStorageProvider,
  S3CompatibleStorageProvider,
} from '../server/objectStorage.ts';
import { getClientIp } from '../server/rateLimiter.ts';
import { resolveCookieSameSite } from '../server/security.ts';
import {
  AwardValidationError,
  isExceedingL1Total,
  isLineQuantitySufficient,
  validateAwardSubmission,
} from '../src/lib/awardValidation.ts';
import { computeEvaluatedSavings, rankQuotations } from '../src/lib/ranking.ts';
import { buildPgSslConfig, type DrizzleDb } from '../src/db/index.ts';
import type { Quotation, QuotationLine, Rfq, WorkspaceState } from '../src/types.ts';
import { createMinimalValidPng, getSafeTestDbConfig } from './_helpers.ts';

const execFileAsync = promisify(execFile);

function makeSampleRfqAndQuotes(): {
  rfq: Rfq;
  q1: Quotation;
  q2: Quotation;
} {
  const rfq: Rfq = {
    id: 'rfq-u-1',
    rfqNumber: 'RFQ-UNIT-001',
    title: 'Unit Manifold & Seal RFQ',
    status: 'in_review',
    currency: 'INR',
    incoterms: 'FOR Pune',
    deliveryLocation: 'Pune',
    deadlineDate: '2026-12-31',
    createdBy: 'Unit Buyer',
    invitedSupplierIds: ['sup-1', 'sup-2'],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    items: [
      {
        id: 'item-1',
        rfqId: 'rfq-u-1',
        itemId: null,
        lineNo: 1,
        skuCode: 'MNF-1',
        description: 'Hydraulic Manifold',
        quantity: 10,
        uom: 'pcs',
        targetUnitPrice: 1000,
      },
      {
        id: 'item-2',
        rfqId: 'rfq-u-1',
        itemId: null,
        lineNo: 2,
        skuCode: 'SEL-2',
        description: 'FKM Seal Kit',
        quantity: 20,
        uom: 'pcs',
        targetUnitPrice: 200,
      },
    ],
  };

  const makeLine = (
    id: string,
    quotationId: string,
    rfqItemId: string,
    qty: number,
    unitRate: number,
    overrides: Partial<QuotationLine> = {}
  ): QuotationLine => ({
    id,
    quotationId,
    rfqItemId,
    vendorLineNo: 1,
    rawDescription: `Line ${id}`,
    quotedQty: qty,
    quotedUom: 'pcs',
    uomConversionFactor: 1,
    quotedUnitRate: unitRate,
    discountAmount: 0,
    taxRatePct: 18,
    taxCreditable: true,
    allocatedOverhead: 0,
    normalizedUnitBase: unitRate,
    normalizedUnitLanded: unitRate,
    normalizedUnitGross: unitRate * 1.18,
    lineTotalQuoted: qty * unitRate,
    expectedLineTotal: qty * unitRate,
    mathValid: true,
    mathErrorDetail: null,
    matchStatus: 'matched',
    confidenceScore: 0.96,
    humanEdited: false,
    verifiedField: true,
    sourceTrace: { sourceType: 'pdf', snippet: 'Mock trace' },
    ...overrides,
  });

  const q1: Quotation = {
    id: 'q-u-1',
    rfqId: rfq.id,
    supplierId: 'sup-1',
    documentId: 'doc-1',
    documentName: 'q1.pdf',
    documentKind: 'pdf',
    mimeType: 'application/pdf',
    parseStatus: 'verified',
    quoteReference: 'Q1-REF',
    quoteDate: '2026-03-02',
    validUntil: '2026-04-02',
    currency: 'INR',
    exchangeRateToRfq: 1,
    leadTimeDays: 7,
    paymentTerms: 'Net 30',
    freightCharges: 0,
    packingForwarding: 0,
    otherCharges: 0,
    globalDiscount: 0,
    taxIncludedInRates: false,
    missingFreightWarning: false,
    subtotalBase: 14000,
    totalTax: 2520,
    totalLandedCost: 14000,
    totalGrossPayable: 16520,
    completenessRatio: 1,
    isVerified: true,
    verifiedBy: 'Unit Buyer',
    verifiedAt: '2026-03-02T00:00:00.000Z',
    headerTraces: {},
    createdAt: '2026-03-02T00:00:00.000Z',
    lines: [
      makeLine('q1-l1', 'q-u-1', 'item-1', 10, 1000),
      makeLine('q1-l2', 'q-u-1', 'item-2', 20, 200),
    ],
  };

  const q2: Quotation = {
    id: 'q-u-2',
    rfqId: rfq.id,
    supplierId: 'sup-2',
    documentId: 'doc-2',
    documentName: 'q2.pdf',
    documentKind: 'pdf',
    mimeType: 'application/pdf',
    parseStatus: 'verified',
    quoteReference: 'Q2-REF',
    quoteDate: '2026-03-02',
    validUntil: '2026-04-02',
    currency: 'INR',
    exchangeRateToRfq: 1,
    leadTimeDays: 5,
    paymentTerms: 'Net 30',
    freightCharges: 0,
    packingForwarding: 0,
    otherCharges: 0,
    globalDiscount: 0,
    taxIncludedInRates: false,
    missingFreightWarning: false,
    subtotalBase: 16000,
    totalTax: 2880,
    totalLandedCost: 16000,
    totalGrossPayable: 18880,
    completenessRatio: 1,
    isVerified: true,
    verifiedBy: 'Unit Buyer',
    verifiedAt: '2026-03-02T00:00:00.000Z',
    headerTraces: {},
    createdAt: '2026-03-02T00:00:00.000Z',
    lines: [
      makeLine('q2-l1', 'q-u-2', 'item-1', 10, 1200),
      makeLine('q2-l2', 'q-u-2', 'item-2', 20, 200),
    ],
  };

  return { rfq, q1, q2 };
}

describe('Task 007 Stabilization Unit Suite', () => {
  it('Phase 2: rankQuotations & validateAwardSubmission enforce verification, math, coverage, freight exception, alternate spec, and non-L1 rules', () => {
    const { rfq, q1, q2 } = makeSampleRfqAndQuotes();

    // Missing freight on q1 disqualifies it from L1 until resolved
    const q1MissingFreight: Quotation = { ...q1, missingFreightWarning: true };
    const rankedWithFreightWarn = rankQuotations([q1MissingFreight, q2], 'landed');
    const q1Ranked = rankedWithFreightWarn.find((r) => r.quotation.id === q1.id)!;
    assert.equal(q1Ranked.eligibleForAwardRank, false);
    assert.ok(q1Ranked.ineligibilityReasons.some((r) => /freight/i.test(r)));

    // Unreviewed alternate_spec line disqualifies until verifiedField=true
    const q1AltUnreviewed: Quotation = {
      ...q1,
      lines: [
        { ...q1.lines[0], matchStatus: 'alternate_spec', verifiedField: false },
        q1.lines[1],
      ],
    };
    const altRanked = rankQuotations([q1AltUnreviewed, q2], 'landed').find(
      (r) => r.quotation.id === q1.id
    )!;
    assert.equal(altRanked.eligibleForAwardRank, false);
    assert.ok(altRanked.ineligibilityReasons.some((r) => /alternate/i.test(r)));

    const fullQ1Allocs = [
      { rfqItemId: 'item-1', quotationId: q1.id, quotationLineId: q1.lines[0].id },
      { rfqItemId: 'item-2', quotationId: q1.id, quotationLineId: q1.lines[1].id },
    ];

    // Existing approved award -> 409
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [q1, q2],
          isSplitAward: false,
          allocations: fullQ1Allocs,
          hasApprovedAward: true,
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 409
    );

    // Partial BOM coverage or duplicate item allocation -> 400
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [q1, q2],
          isSplitAward: false,
          allocations: [fullQ1Allocs[0]],
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 400
    );
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [q1, q2],
          isSplitAward: false,
          allocations: [fullQ1Allocs[0], fullQ1Allocs[0]],
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 400
    );

    // Unverified quotation -> 422
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [{ ...q1, isVerified: false }, q2],
          isSplitAward: false,
          allocations: fullQ1Allocs,
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 422
    );

    // Unconfirmed freight warning -> 422 unless explicitly accepted WITH written justification
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [q1MissingFreight, q2],
          isSplitAward: false,
          allocations: fullQ1Allocs,
          commercialExceptionAccepted: false,
          nonL1Justification: 'Supplier handles freight EXW.',
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 422
    );
    const freightAcceptedResult = validateAwardSubmission({
      rfq,
      rfqQuotes: [q1MissingFreight, q2],
      isSplitAward: false,
      allocations: fullQ1Allocs,
      commercialExceptionAccepted: true,
      nonL1Justification: 'Approved EXW freight addendum #44.',
    });
    assert.equal(freightAcceptedResult.requiresCommercialException, true);

    // Alternate specification line -> 422 unless accepted line IDs + justification provided
    const q1AltReviewed: Quotation = {
      ...q1,
      lines: [
        { ...q1.lines[0], matchStatus: 'alternate_spec', verifiedField: true },
        q1.lines[1],
      ],
    };
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [q1AltReviewed, q2],
          isSplitAward: false,
          allocations: fullQ1Allocs,
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 422
    );
    const altAcceptedResult = validateAwardSubmission({
      rfq,
      rfqQuotes: [q1AltReviewed, q2],
      isSplitAward: false,
      allocations: fullQ1Allocs,
      acceptedAlternateLineIds: [q1.lines[0].id],
      nonL1Justification: 'Engineering signed off alternate SS grade.',
    });
    assert.deepEqual(altAcceptedResult.alternateLineIds, [q1.lines[0].id]);

    // Non-L1 package award -> 400 without justification, passes with justification
    const q2Allocs = [
      { rfqItemId: 'item-1', quotationId: q2.id, quotationLineId: q2.lines[0].id },
      { rfqItemId: 'item-2', quotationId: q2.id, quotationLineId: q2.lines[1].id },
    ];
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [q1, q2],
          isSplitAward: false,
          allocations: q2Allocs,
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 400
    );
    const nonL1Ok = validateAwardSubmission({
      rfq,
      rfqQuotes: [q1, q2],
      isSplitAward: false,
      allocations: q2Allocs,
      nonL1Justification: 'Urgent 5-day delivery needed.',
    });
    assert.equal(nonL1Ok.isNonL1, true);
    assert.equal(nonL1Ok.totalAwardedLanded, 16000);
  });

  it('Phase 2: DemoWorkspaceStore clears verification on header edit and rejects unverified award submission', () => {
    const store = new DemoWorkspaceStore();
    const state = store.getWorkspace('unit-demo-sess');
    const q1 = state.quotations.find((q) => q.id === 'demo-rfq-2026-101-q1')!;
    assert.equal(q1.isVerified, true);

    // Header edit must reset verification
    const updated = store.updateQuotationHeader('unit-demo-sess', q1.id, {
      freightCharges: 4500,
    });
    assert.equal(updated.isVerified, false);
    assert.equal(updated.verifiedAt, null);

    // Submitting award referencing unverified q1 must fail with 422
    const rfq = state.rfqs.find((r) => r.id === 'demo-rfq-2026-101')!;
    assert.throws(
      () =>
        store.submitAward('unit-demo-sess', {
          rfqId: rfq.id,
          isSplitAward: false,
          allocations: rfq.items.map((it, idx) => ({
            rfqItemId: it.id,
            quotationId: q1.id,
            quotationLineId: q1.lines[idx].id,
          })),
        }),
      (err: unknown) => err instanceof DemoStoreError && err.statusCode === 422
    );
  });

  it('Phase 4: legacy migration requires confirmed: true and rolls back uploaded storage objects on cross-org conflict', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-mig-unit-'));
    try {
      const jsonPath = path.join(tmpDir, 'legacy.json');
      const backupDir = path.join(tmpDir, 'backups');
      const storageDir = path.join(tmpDir, 'storage');
      const pngB64 = createMinimalValidPng().toString('base64');

      const sampleLegacy: WorkspaceState = {
        settings: {
          id: 'org-unit-mig',
          name: 'Unit Legacy Org',
          countryCode: 'IN',
          defaultCurrency: 'INR',
          taxRegime: 'INDIA_GST',
          defaultTaxCreditable: true,
          uomAliases: {},
          activeUserName: 'Buyer',
          activeUserTitle: 'Buyer',
          activeUserRole: 'buyer',
        },
        suppliers: [
          {
            id: 'sup-conflict-1',
            name: 'Conflict Vendor',
            taxId: '27CONF1234Z1',
            city: 'Pune',
            contactName: 'C',
            email: 'c@test.local',
            phoneWhatsapp: '999',
            defaultPaymentTerms: 'Net 30',
            categories: [],
            createdAt: '2026-03-01T00:00:00.000Z',
          },
        ],
        items: [],
        rfqs: [],
        quotations: [
          {
            id: 'qt-conflict-1',
            rfqId: 'rfq-missing',
            supplierId: 'sup-conflict-1',
            documentName: 'quote.png',
            documentKind: 'image',
            mimeType: 'image/png',
            fileDataUrl: `data:image/png;base64,${pngB64}`,
            parseStatus: 'verified',
            quoteReference: 'C-1',
            quoteDate: '2026-03-01',
            validUntil: '2026-04-01',
            currency: 'INR',
            exchangeRateToRfq: 1,
            leadTimeDays: 5,
            paymentTerms: 'Net 30',
            freightCharges: 0,
            packingForwarding: 0,
            otherCharges: 0,
            globalDiscount: 0,
            taxIncludedInRates: false,
            missingFreightWarning: false,
            subtotalBase: 100,
            totalTax: 18,
            totalLandedCost: 100,
            totalGrossPayable: 118,
            completenessRatio: 1,
            isVerified: true,
            verifiedBy: null,
            verifiedAt: null,
            headerTraces: {},
            createdAt: '2026-03-01T00:00:00.000Z',
            lines: [],
          },
        ],
        awards: [],
        auditLogs: [],
      };
      fs.writeFileSync(jsonPath, JSON.stringify(sampleLegacy), 'utf-8');
      const storageProvider = new LocalPrivateStorageProvider(storageDir);

      // 1. Apply mode without confirmed: true must throw immediately
      await assert.rejects(
        () =>
          migrateLegacyJsonToPostgres({
            db: {} as DrizzleDb,
            storageProvider,
            jsonPath,
            backupDir,
            dryRun: false,
          }),
        /requires explicit confirmation/i
      );

      // 2. CLI without --confirm must refuse before DB connection
      await assert.rejects(
        () =>
          execFileAsync('npx', ['tsx', 'scripts/migrate-json-to-postgres.ts', '--apply'], {
            cwd: process.cwd(),
          }),
        (err: unknown) => {
          const e = err as { code?: number; stderr?: string };
          assert.notEqual(e.code, 0);
          assert.match(e.stderr || '', /--confirm/);
          return true;
        }
      );

      // 3. Cross-org ID conflict aborts transaction AND rolls back uploaded storage keys
      const deletedKeys: string[] = [];
      const trackingStorage = {
        mode: storageProvider.mode,
        putObject: storageProvider.putObject.bind(storageProvider),
        getObject: storageProvider.getObject.bind(storageProvider),
        createSignedDownloadUrl: storageProvider.createSignedDownloadUrl.bind(storageProvider),
        checkReadiness: storageProvider.checkReadiness.bind(storageProvider),
        async deleteObject(key: string) {
          deletedKeys.push(key);
          await storageProvider.deleteObject(key);
        },
      };

      let selectCallCount = 0;
      const mockTx = {
        select() {
          selectCallCount += 1;
          const currentCall = selectCallCount;
          return {
            from() {
              return {
                where() {
                  // First select checks suppliers -> return ID owned by a DIFFERENT org
                  if (currentCall === 1) {
                    return Promise.resolve([
                      { id: 'sup-conflict-1', organizationId: 'org-other-tenant' },
                    ]);
                  }
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
      const mockDb = {
        async transaction(fn: (tx: typeof mockTx) => Promise<void>) {
          await fn(mockTx);
        },
      } as unknown as DrizzleDb;

      await assert.rejects(
        () =>
          migrateLegacyJsonToPostgres({
            db: mockDb,
            storageProvider: trackingStorage,
            jsonPath,
            backupDir,
            dryRun: false,
            confirmed: true,
          }),
        (err: unknown) => {
          assert.ok(err instanceof MigrationConflictError);
          const annotated = err as MigrationConflictError & { rolledBackStorageKeys?: string[] };
          assert.equal(annotated.rolledBackStorageKeys?.length, 1);
          assert.equal(deletedKeys.length, 1);
          return true;
        }
      );

      // Uploaded storage file must have been deleted during rollback
      const filesAfterRollback = await storageProvider.getObject(deletedKeys[0]).catch(() => null);
      assert.equal(filesAfterRollback, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Phase 6: getClientIp, S3 timeout AbortController, isGoogleAuthConfigured, and maintenance advisory lock + orphan delete guard', async () => {
    // 1. getClientIp ignores spoofed raw X-Forwarded-For and relies on Express req.ip
    const fakeReq = {
      ip: '203.0.113.55',
      headers: { 'x-forwarded-for': '1.2.3.4' },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    assert.equal(getClientIp(fakeReq), '203.0.113.55');

    // 2. S3CompatibleStorageProvider aborts hanging fetch via AbortController
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as typeof fetch;

    try {
      const s3 = new S3CompatibleStorageProvider({
        endpoint: 'https://s3.ap-south-1.example.com',
        region: 'ap-south-1',
        bucket: 'test-bucket',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        requestTimeoutMs: 25,
      });
      await assert.rejects(
        () => s3.getObject('orgs/org-1/docs/doc-1/quote.pdf'),
        /timed out after 25ms/i
      );
    } finally {
      globalThis.fetch = origFetch;
    }

    // 3. isGoogleAuthConfigured checks real config presence/shape
    assert.equal(isGoogleAuthConfigured(), true);
    const tmpCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-gcfg-'));
    try {
      const badCfg = path.join(tmpCfgDir, 'bad.json');
      fs.writeFileSync(badCfg, JSON.stringify({ projectId: 'p1', apiKey: '' }), 'utf-8');
      assert.equal(isGoogleAuthConfigured(badCfg), false);
      assert.equal(isGoogleAuthConfigured(path.join(tmpCfgDir, 'missing.json')), false);
    } finally {
      fs.rmSync(tmpCfgDir, { recursive: true, force: true });
    }

    // 4. Maintenance skips cleanly when advisory lock is held by another worker
    let lockReleased = false;
    const lockedSummary = await runScheduledMaintenance({
      db: {} as DrizzleDb,
      storageProvider: new LocalPrivateStorageProvider(tmpCfgDir),
      lockPool: {
        async connect() {
          return {
            async query() {
              return { rows: [{ acquired: false }] };
            },
            release() {
              lockReleased = true;
            },
          };
        },
      },
    });
    assert.equal(lockedSummary.skippedBecauseLocked, true);
    assert.equal(lockReleased, true);

    // 5. Maintenance retains stored_documents row when deleteObject fails & unlocks in finally
    const { storedDocuments } = await import('../src/db/schema.ts');
    const queriesExecuted: string[] = [];
    let deleteAttemptedOnDb = false;

    const makeChain = (activeTable?: unknown) => {
      let currentTable = activeTable;
      const chain: Record<string, unknown> = {
        from(tbl: unknown) {
          currentTable = tbl;
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          if (currentTable === storedDocuments) {
            return Promise.resolve([
              {
                id: 'doc-orphan-fail',
                storageKey: 'orgs/org-1/docs/doc-orphan-fail/quote.pdf',
              },
            ]);
          }
          return Promise.resolve([]);
        },
        returning() {
          return Promise.resolve([]);
        },
      };
      return chain;
    };

    const mockMaintDb = {
      select() {
        return makeChain();
      },
      delete() {
        deleteAttemptedOnDb = true;
        return makeChain();
      },
      update() {
        return makeChain();
      },
    } as unknown as DrizzleDb;

    let unlockedClientReleased = false;
    const maintResult = await runScheduledMaintenance({
      db: mockMaintDb,
      localStorageDir: path.join(os.tmpdir(), 'norus-missing-tmp-dir'),
      lockPool: {
        async connect() {
          return {
            async query(text: string) {
              queriesExecuted.push(text);
              return { rows: [{ acquired: true }] };
            },
            release() {
              unlockedClientReleased = true;
            },
          };
        },
      },
      storageProvider: {
        mode: 'local',
        async checkReadiness() {
          return { ok: true };
        },
        async putObject() {},
        async getObject() {
          return { buffer: Buffer.alloc(0), contentType: 'application/pdf' };
        },
        async deleteObject() {
          throw new Error('Storage delete failed Bearer supersecret999');
        },
        async createSignedDownloadUrl() {
          return { url: '/x', expiresAt: new Date().toISOString() };
        },
      },
    });

    assert.equal(unlockedClientReleased, true);
    assert.ok(queriesExecuted.some((q) => q.includes('pg_try_advisory_lock')));
    assert.ok(queriesExecuted.some((q) => q.includes('pg_advisory_unlock')));
    assert.equal(deleteAttemptedOnDb, false);
    assert.equal(maintResult.cleanedOrphanedDocuments, 0);
    assert.equal(maintResult.errors.length, 1);
    assert.equal(maintResult.errors[0].includes('supersecret999'), false);
    assert.ok(maintResult.errors[0].includes('[REDACTED]'));
  });

  it('Task 007.2: enforces quotation quantity sufficiency, UOM epsilon, cent-level non-L1 checks, and pending-award 409', () => {
    const { rfq, q1, q2 } = makeSampleRfqAndQuotes();

    // 1. Short quoted quantity (5 vs 10 required) fails rankQuotations(rfq), savings, and validateAwardSubmission (422)
    const q1ShortQty: Quotation = {
      ...q1,
      totalLandedCost: 9000,
      lines: [
        { ...q1.lines[0], quotedQty: 5, lineTotalQuoted: 5000, expectedLineTotal: 5000 },
        q1.lines[1],
      ],
    };
    assert.equal(isLineQuantitySufficient(q1ShortQty.lines[0], rfq.items[0]).ok, false);
    const rankedWithShort = rankQuotations([q1ShortQty, q2], 'landed', rfq);
    const shortRank = rankedWithShort.find((r) => r.quotation.id === q1.id)!;
    assert.equal(shortRank.eligibleForAwardRank, false);
    assert.ok(shortRank.ineligibilityReasons.some((reason) => /insufficient quoted (qty|quantity)/i.test(reason)));
    assert.equal(rankedWithShort.find((r) => r.quotation.id === q2.id)?.rankLabel, 'L1');

    // Savings must exclude quantity-insufficient quotes even if their nominal unit rate looks cheaper
    assert.equal(computeEvaluatedSavings([rfq], [q1ShortQty]), 0);

    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [q1ShortQty, q2],
          isSplitAward: false,
          allocations: [
            { rfqItemId: 'item-1', quotationId: q1ShortQty.id, quotationLineId: q1ShortQty.lines[0].id },
            { rfqItemId: 'item-2', quotationId: q1ShortQty.id, quotationLineId: q1ShortQty.lines[1].id },
          ],
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 422
    );

    // 2. Pack-of-10 conversion (quotedQty=1, factor=10) & repeating-fraction tolerance (3.3333 * 3 = 9.9999) succeed
    const convertedOk = isLineQuantitySufficient(
      { ...q1.lines[0], quotedQty: 1, uomConversionFactor: 10 },
      rfq.items[0]
    );
    assert.equal(convertedOk.ok, true);
    const epsilonOk = isLineQuantitySufficient(
      { ...q1.lines[0], quotedQty: 3.3333, uomConversionFactor: 3 },
      rfq.items[0]
    );
    assert.equal(epsilonOk.ok, true);
    const belowEpsilon = isLineQuantitySufficient(
      { ...q1.lines[0], quotedQty: 3.33, uomConversionFactor: 3 },
      rfq.items[0]
    );
    assert.equal(belowEpsilon.ok, false);

    // 3. Cent-level L1 boundary: 14000.01, 14000.50, 14001.00 exceed 14000.00; 14000.004 does not
    assert.equal(isExceedingL1Total(14000.0, 14000.0), false);
    assert.equal(isExceedingL1Total(14000.004, 14000.0), false);
    assert.equal(isExceedingL1Total(14000.01, 14000.0), true);
    assert.equal(isExceedingL1Total(14000.5, 14000.0), true);
    assert.equal(isExceedingL1Total(14001.0, 14000.0), true);

    const qSlightlyAboveL1: Quotation = {
      ...q2,
      totalLandedCost: 14000.5,
      lines: [
        { ...q2.lines[0], normalizedUnitLanded: 1000.05 },
        q2.lines[1],
      ],
    };
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [q1, qSlightlyAboveL1],
          isSplitAward: false,
          allocations: [
            { rfqItemId: 'item-1', quotationId: qSlightlyAboveL1.id, quotationLineId: qSlightlyAboveL1.lines[0].id },
            { rfqItemId: 'item-2', quotationId: qSlightlyAboveL1.id, quotationLineId: qSlightlyAboveL1.lines[1].id },
          ],
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 400
    );

    // 4. Existing pending award blocks replacement with 409 until withdrawn
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq,
          rfqQuotes: [q1, q2],
          isSplitAward: false,
          allocations: [
            { rfqItemId: 'item-1', quotationId: q1.id, quotationLineId: q1.lines[0].id },
            { rfqItemId: 'item-2', quotationId: q1.id, quotationLineId: q1.lines[1].id },
          ],
          hasPendingAward: true,
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 409
    );
  });

  it('Task 007.2: enforces strict PostgreSQL TLS, CSP, cookie SameSite, trust proxy, and safe test DB guards', () => {
    // 1. PostgreSQL TLS configuration never weakens rejectUnauthorized by default
    assert.equal(buildPgSslConfig({ SQL_SSL: 'false', SQL_HOST: 'db.example.com' }), undefined);
    assert.deepEqual(buildPgSslConfig({ SQL_SSL: 'true', SQL_HOST: 'db.example.com' }), {
      rejectUnauthorized: true,
    });
    assert.equal(
      buildPgSslConfig({ SQL_SSL: 'true', SQL_HOST: '/app/cloudsql/proj:asia:db' }),
      undefined
    );
    const pemSsl = buildPgSslConfig({
      SQL_SSL: 'true',
      SQL_HOST: 'db.example.com',
      SQL_SSL_CA: '-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----',
    });
    assert.equal(pemSsl?.rejectUnauthorized, true);
    assert.ok(pemSsl?.ca?.includes('\nABC\n'));
    assert.throws(
      () =>
        buildPgSslConfig({
          SQL_SSL: 'true',
          SQL_HOST: 'db.example.com',
          SQL_SSL_CA: '/nonexistent/path/server-ca.pem',
        }),
      /SQL_SSL_CA/
    );

    // 2. Production CSP contains no '*' wildcard and no 'unsafe-eval', and includes valid S3 origin
    const csp = buildProductionCspPolicy({ S3_ENDPOINT: 'https://r2.example.com/bucket' });
    assert.equal(csp.includes('*'), false);
    assert.equal(csp.includes('unsafe-eval'), false);
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes('https://r2.example.com'));

    // 3. Cookie SameSite policy & trust proxy parsing
    assert.equal(resolveCookieSameSite(true, {}), 'None');
    assert.equal(resolveCookieSameSite(false, {}), 'Lax');
    assert.equal(resolveCookieSameSite(true, { COOKIE_SAMESITE: 'strict' }), 'Strict');
    assert.equal(resolveCookieSameSite(false, { COOKIE_SAMESITE: 'none' }), 'Lax');

    assert.equal(resolveTrustProxySetting({}), 1);
    assert.equal(resolveTrustProxySetting({ TRUST_PROXY_HOPS: '2' }), 2);
    assert.equal(resolveTrustProxySetting({ TRUST_PROXY_HOPS: 'false' }), false);
    assert.equal(resolveTrustProxySetting({ TRUST_PROXY_HOPS: '0' }), false);
    assert.throws(() => resolveTrustProxySetting({ TRUST_PROXY_HOPS: '-1' }), /TRUST_PROXY_HOPS/);

    // 4. Test DB config blocks Cloud SQL sockets, production/postgres DB names, and live SQL overlap, while allowing CI loopback *_test
    assert.equal(
      getSafeTestDbConfig({
        TEST_SQL_HOST: '/app/cloudsql/proj:reg:inst',
        TEST_SQL_USER: 'u',
        TEST_SQL_PASSWORD: 'p',
        TEST_SQL_DB_NAME: 'quoteflow_test',
      }),
      null
    );
    assert.equal(
      getSafeTestDbConfig({
        TEST_DATABASE_URL: 'postgres://u:p@/quoteflow_test?host=/cloudsql/proj:reg:inst',
      }),
      null
    );
    assert.equal(
      getSafeTestDbConfig({
        TEST_SQL_HOST: '127.0.0.1',
        TEST_SQL_USER: 'u',
        TEST_SQL_PASSWORD: 'p',
        TEST_SQL_DB_NAME: 'postgres',
      }),
      null
    );
    assert.equal(
      getSafeTestDbConfig({
        NODE_ENV: 'development',
        SQL_HOST: '10.0.0.5',
        SQL_DB_NAME: 'app_db',
        TEST_SQL_HOST: '10.0.0.5',
        TEST_SQL_USER: 'u',
        TEST_SQL_PASSWORD: 'p',
        TEST_SQL_DB_NAME: 'app_db',
      }),
      null
    );
    const ciCfg = getSafeTestDbConfig({
      NODE_ENV: 'test',
      SQL_HOST: '127.0.0.1',
      SQL_DB_NAME: 'quoteflow_test',
      TEST_SQL_HOST: '127.0.0.1',
      TEST_SQL_USER: 'postgres',
      TEST_SQL_PASSWORD: 'ci_test_password',
      TEST_SQL_DB_NAME: 'quoteflow_test',
    });
    assert.ok(ciCfg);
    assert.equal(ciCfg.database, 'quoteflow_test');
  });

  it('Task 007.2: DemoWorkspaceStore validates inputs, locks pending/approved quotes, supports withdrawAward, and preserves rejected history', () => {
    const store = new DemoWorkspaceStore();
    const sess = 'unit-task-007-2';
    const ws = store.getWorkspace(sess);
    const rfq = ws.rfqs.find((r) => r.id === 'demo-rfq-2026-101')!;
    const q1 = ws.quotations.find((q) => q.id === 'demo-rfq-2026-101-q1')!;

    // 1. Header & line validation checks
    assert.throws(
      () => store.updateQuotationHeader(sess, q1.id, { quoteReference: '   ' }),
      (e: unknown) => e instanceof DemoStoreError && e.statusCode === 400
    );
    assert.throws(
      () => store.updateQuotationHeader(sess, q1.id, { leadTimeDays: 4.5 }),
      (e: unknown) => e instanceof DemoStoreError && e.statusCode === 400
    );
    assert.throws(
      () => store.updateQuotationHeader(sess, q1.id, { leadTimeDays: true as unknown as number }),
      (e: unknown) => e instanceof DemoStoreError && e.statusCode === 400
    );
    assert.throws(
      () => store.updateQuotationLine(sess, q1.id, q1.lines[0].id, { matchStatus: 'bogus' as 'matched' }),
      (e: unknown) => e instanceof DemoStoreError && e.statusCode === 400
    );

    const altUpdated = store.updateQuotationLine(sess, q1.id, q1.lines[0].id, {
      matchStatus: 'alternate_spec',
    });
    assert.equal(altUpdated.isVerified, false);
    assert.equal(altUpdated.verifiedBy, null);
    assert.equal(altUpdated.lines[0].verifiedField, false);

    // Restore matched & re-verify q1
    store.updateQuotationLine(sess, q1.id, q1.lines[0].id, { matchStatus: 'matched' });
    store.verifyQuotation(sess, q1.id);

    const q1Allocs = rfq.items.map((it) => ({
      rfqItemId: it.id,
      quotationId: q1.id,
      quotationLineId: q1.lines.find((l) => l.rfqItemId === it.id)!.id,
    }));

    // 2. Submit pending award -> quote locked (409) & duplicate pending award blocked (409)
    const pending1 = store.submitAward(sess, {
      rfqId: rfq.id,
      isSplitAward: false,
      allocations: q1Allocs,
    });
    assert.throws(
      () => store.updateQuotationHeader(sess, q1.id, { freightCharges: 999 }),
      (e: unknown) => e instanceof DemoStoreError && e.statusCode === 409
    );
    assert.throws(
      () => store.deleteQuotation(sess, q1.id),
      (e: unknown) => e instanceof DemoStoreError && e.statusCode === 409
    );
    assert.throws(
      () =>
        store.submitAward(sess, {
          rfqId: rfq.id,
          isSplitAward: false,
          allocations: q1Allocs,
        }),
      (e: unknown) => e instanceof DemoStoreError && e.statusCode === 409
    );

    // 3. Withdraw pending award -> RFQ reverts to in_review & quote becomes editable again
    const withdrawn = store.withdrawAward(sess, pending1.id);
    assert.equal(withdrawn.withdrawnAwardId, pending1.id);
    assert.equal(withdrawn.rfq.status, 'in_review');
    store.updateQuotationHeader(sess, q1.id, { freightCharges: q1.freightCharges });
    store.verifyQuotation(sess, q1.id);

    // 4. Resubmit & reject -> historical rejected snapshot preserved, deletion still 409, quote editable & re-verifiable, revision + approval preserves both
    const pending2 = store.submitAward(sess, {
      rfqId: rfq.id,
      isSplitAward: false,
      allocations: q1Allocs,
    });
    const rejected = store.decideAward(sess, pending2.id, 'rejected', 'Revise payment terms');
    assert.equal(rejected.approvalStatus, 'rejected');

    assert.throws(
      () => store.deleteQuotation(sess, q1.id),
      (e: unknown) => e instanceof DemoStoreError && e.statusCode === 409
    );

    store.updateQuotationHeader(sess, q1.id, { paymentTerms: 'Net 45 Revised' });
    store.verifyQuotation(sess, q1.id);

    const pending3 = store.submitAward(sess, {
      rfqId: rfq.id,
      isSplitAward: false,
      allocations: q1Allocs,
    });
    const approved = store.decideAward(sess, pending3.id, 'approved', 'Approved after revision');
    assert.equal(approved.approvalStatus, 'approved');

    const finalWs = store.getWorkspace(sess);
    const rfqAwards = finalWs.awards.filter((a) => a.rfqId === rfq.id);
    assert.equal(rfqAwards.some((a) => a.id === rejected.id && a.approvalStatus === 'rejected'), true);
    assert.equal(rfqAwards.some((a) => a.id === approved.id && a.approvalStatus === 'approved'), true);
  });

  it('Task 008: scales quantity tolerance for micro-quantities while preserving 1e-4 UOM conversion precision at standard and large scales', () => {
    const { rfq, q1, q2 } = makeSampleRfqAndQuotes();
    const baseItem = rfq.items[0];
    const baseLine = q1.lines[0];

    // Standard >= 1 quantities retain 1e-4 absolute epsilon for UOM rounding (e.g. 3 * 0.3333 = 0.9999)
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 3.3333, uomConversionFactor: 3 }, { ...baseItem, quantity: 10 }).ok,
      true
    );
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 0.3333, uomConversionFactor: 3 }, { ...baseItem, quantity: 1 }).ok,
      true
    );
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 0.999, uomConversionFactor: 1 }, { ...baseItem, quantity: 1 }).ok,
      false
    );

    // Fractional < 1 micro-quantities scale proportionally so 10% and 99% shortfalls cannot pass
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 0.16667, uomConversionFactor: 3 }, { ...baseItem, quantity: 0.5 }).ok,
      true
    );
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 0.499, uomConversionFactor: 1 }, { ...baseItem, quantity: 0.5 }).ok,
      false
    );
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 0.001, uomConversionFactor: 1 }, { ...baseItem, quantity: 0.001 }).ok,
      true
    );
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 0.0009, uomConversionFactor: 1 }, { ...baseItem, quantity: 0.001 }).ok,
      false
    );
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 0.0001, uomConversionFactor: 1 }, { ...baseItem, quantity: 0.0001 }).ok,
      true
    );
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 0.000001, uomConversionFactor: 1 }, { ...baseItem, quantity: 0.0001 }).ok,
      false
    );
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 0.000099, uomConversionFactor: 1 }, { ...baseItem, quantity: 0.0001 }).ok,
      false
    );

    // Large quantities stay tight at 1e-4 absolute units
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 999_999.9999, uomConversionFactor: 1 }, { ...baseItem, quantity: 1_000_000 }).ok,
      true
    );
    assert.equal(
      isLineQuantitySufficient({ ...baseLine, quotedQty: 999_999.99, uomConversionFactor: 1 }, { ...baseItem, quantity: 1_000_000 }).ok,
      false
    );

    // Micro-quantity awardedQty mismatch (0.0001 vs 0.001) must fail with 400
    const microRfq: Rfq = {
      ...rfq,
      items: [{ ...rfq.items[0], quantity: 0.001 }, rfq.items[1]],
    };
    const microQ1: Quotation = {
      ...q1,
      totalLandedCost: 4001,
      lines: [
        { ...q1.lines[0], quotedQty: 0.001, lineTotalQuoted: 1, expectedLineTotal: 1 },
        q1.lines[1],
      ],
    };
    const microQ2: Quotation = {
      ...q2,
      totalLandedCost: 4001.2,
      lines: [
        { ...q2.lines[0], quotedQty: 0.001, lineTotalQuoted: 1.2, expectedLineTotal: 1.2 },
        q2.lines[1],
      ],
    };
    assert.throws(
      () =>
        validateAwardSubmission({
          rfq: microRfq,
          rfqQuotes: [microQ1, microQ2],
          isSplitAward: false,
          allocations: [
            { rfqItemId: 'item-1', quotationId: microQ1.id, quotationLineId: microQ1.lines[0].id, awardedQty: 0.0001 },
            { rfqItemId: 'item-2', quotationId: microQ1.id, quotationLineId: microQ1.lines[1].id, awardedQty: 20 },
          ],
        }),
      (err: unknown) => err instanceof AwardValidationError && err.statusCode === 400
    );
    const microAwardOk = validateAwardSubmission({
      rfq: microRfq,
      rfqQuotes: [microQ1, microQ2],
      isSplitAward: false,
      allocations: [
        { rfqItemId: 'item-1', quotationId: microQ1.id, quotationLineId: microQ1.lines[0].id, awardedQty: 0.001 },
        { rfqItemId: 'item-2', quotationId: microQ1.id, quotationLineId: microQ1.lines[1].id, awardedQty: 20 },
      ],
    });
    assert.equal(microAwardOk.allocations[0].awardedQty, 0.001);
  });
});
