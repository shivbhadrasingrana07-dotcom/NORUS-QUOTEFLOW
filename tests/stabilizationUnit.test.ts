import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { Request } from 'express';
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
import {
  AwardValidationError,
  validateAwardSubmission,
} from '../src/lib/awardValidation.ts';
import { rankQuotations } from '../src/lib/ranking.ts';
import type { DrizzleDb } from '../src/db/index.ts';
import type { Quotation, QuotationLine, Rfq, WorkspaceState } from '../src/types.ts';
import { createMinimalValidPng } from './_helpers.ts';

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
});
