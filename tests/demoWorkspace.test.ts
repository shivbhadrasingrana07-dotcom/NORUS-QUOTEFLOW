import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import * as XLSX from 'xlsx';
import { createApp, resolveDemoMode } from '../server.ts';
import { DevOutboxEmailProvider } from '../server/emailService.ts';
import { LocalPrivateStorageProvider } from '../server/objectStorage.ts';
import { type RateLimitStore } from '../server/rateLimiter.ts';
import {
  buildComparativeStatementPdfDoc,
  buildComparativeStatementWorkbook,
} from '../src/lib/exporters.ts';
import {
  type AuditLogEntry,
  type AwardDecision,
  type OrganizationSettings,
  type Quotation,
  type Rfq,
  type Supplier,
} from '../src/types.ts';
import {
  createMinimalValidPng,
  startIntegratedTestServer,
  uniqueRunTag,
} from './_helpers.ts';

describe('Task 006/007: Temporary No-Login Demo Workspace & Security Isolation', () => {
  const cleanups: Array<() => Promise<void>> = [];

  after(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('serves isolated synthetic demo workspace without login and leaks zero real tenant data', async () => {
    const srv = await startIntegratedTestServer({ demoMode: true });
    cleanups.push(() => srv.close());

    const meRes = await fetch(`${srv.baseUrl}/api/auth/me`);
    assert.equal(meRes.status, 200);
    const me = (await meRes.json()) as {
      authenticated: boolean;
      demoMode: boolean;
      user: unknown;
      activeOrganization: unknown;
    };
    assert.equal(me.authenticated, false);
    assert.equal(me.demoMode, true);
    assert.equal(me.user, null);
    assert.equal(me.activeOrganization, null);

    const demoRes = await fetch(`${srv.baseUrl}/api/demo-workspace`);
    assert.equal(demoRes.status, 200);
    const demoText = await demoRes.text();
    const demo = JSON.parse(demoText) as {
      demoMode: boolean;
      demoSessionId: string;
      activeOrganization: { id: string; name: string };
      suppliers: Array<{ id: string; name: string }>;
      rfqs: Array<{ id: string; rfqNumber: string }>;
    };

    assert.equal(demo.demoMode, true);
    assert.ok(demo.demoSessionId.length >= 8);
    assert.equal(demo.activeOrganization.id, 'demo-org-synthetic');
    assert.match(demo.activeOrganization.name, /Demo/i);
    assert.ok(demo.rfqs.some((r) => r.rfqNumber === 'DEMO-RFQ-2026-101'));
    assert.ok(demo.suppliers.some((s) => s.name === 'Northstar Precision CNC (Demo)'));

    // Assert zero leakage of migrated real Cloud SQL customer data
    const forbiddenRealData = [
      'org-kalyani-hydraulics',
      'Kalyani Fluid Systems',
      'Shree Ganesh',
      'Bharat Industrial',
      'Apex Industrial',
      'Priya Sharma',
      'Rakesh Verma',
      'RFQ-2026-104',
    ];
    for (const marker of forbiddenRealData) {
      assert.equal(
        demoText.includes(marker),
        false,
        `Demo payload must never contain real tenant marker "${marker}"`
      );
    }
  });

  it('keeps real authenticated APIs, RBAC, and disabled persona endpoints locked down in demo mode', async () => {
    const srv = await startIntegratedTestServer({ demoMode: true });
    cleanups.push(() => srv.close());

    const protectedGets = [
      '/api/workspace',
      '/api/organizations/current/members',
      '/api/organizations/current/invitations',
      '/api/documents/doc-any/signed-url',
      '/api/auth/sessions',
    ];
    for (const urlPath of protectedGets) {
      const res = await fetch(`${srv.baseUrl}${urlPath}`);
      assert.equal(res.status, 401, `GET ${urlPath} must return 401 when unauthenticated`);
    }

    const protectedMutations: Array<[string, string, unknown]> = [
      ['PATCH', '/api/settings', { name: 'Hijack' }],
      ['POST', '/api/rfqs', { title: 'Test', items: [{ description: 'Item', quantity: 1 }] }],
      ['POST', '/api/suppliers', { name: 'Rogue Supplier' }],
      ['POST', '/api/items', { name: 'Rogue Item' }],
      ['POST', '/api/organizations', { name: 'Rogue Org' }],
    ];
    for (const [method, urlPath, body] of protectedMutations) {
      const res = await fetch(`${srv.baseUrl}${urlPath}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 401, `${method} ${urlPath} must return 401 without session`);
    }

    const personaRes = await fetch(`${srv.baseUrl}/api/demo/switch-persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    });
    assert.equal(personaRes.status, 410);
  });

  it('supports full isolated demo workflow, signed demo previews, math gates, awards, and reset', async () => {
    const srv = await startIntegratedTestServer({ demoMode: true });
    cleanups.push(() => srv.close());

    const sessA = `test-demo-a-${uniqueRunTag()}`;
    const sessB = `test-demo-b-${uniqueRunTag()}`;

    const headersA = { 'X-Demo-Session': sessA };
    const headersB = { 'X-Demo-Session': sessB };

    // Initialize both isolated demo sessions
    const initA = await fetch(`${srv.baseUrl}/api/demo-workspace`, { headers: headersA });
    assert.equal(initA.status, 200);
    const initB = await fetch(`${srv.baseUrl}/api/demo-workspace`, { headers: headersB });
    assert.equal(initB.status, 200);

    // 1. Update demo settings in Session A -> Session B must remain isolated
    const patchSettingsRes = await fetch(`${srv.baseUrl}/api/demo-workspace/settings`, {
      method: 'PATCH',
      headers: { ...headersA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Custom Demo Sandbox A', defaultCurrency: 'USD' }),
    });
    assert.equal(patchSettingsRes.status, 200);

    const checkBSettings = await fetch(`${srv.baseUrl}/api/demo-workspace`, { headers: headersB });
    const stateB = (await checkBSettings.json()) as {
      settings: { name: string; defaultCurrency: string };
      suppliers: Array<{ name: string }>;
    };
    assert.equal(stateB.settings.name, 'Meridian Industrial Demo Works (Sample)');
    assert.equal(stateB.settings.defaultCurrency, 'INR');

    // 2. Create demo supplier & test duplicate guard (409)
    const createSupRes = await fetch(`${srv.baseUrl}/api/demo-workspace/suppliers`, {
      method: 'POST',
      headers: { ...headersA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Horizon Sample Alloys (Demo)',
        taxId: '27DEMO9999Z1Z9',
        city: 'Chennai',
        defaultPaymentTerms: 'Net 30 Days',
      }),
    });
    assert.equal(createSupRes.status, 201);
    const createdSup = (await createSupRes.json()) as { id: string; name: string };

    const dupSupRes = await fetch(`${srv.baseUrl}/api/demo-workspace/suppliers`, {
      method: 'POST',
      headers: { ...headersA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Horizon Sample Alloys (Demo)' }),
    });
    assert.equal(dupSupRes.status, 409);

    // 3. Create demo RFQ & load another synthetic sample
    const createRfqRes = await fetch(`${srv.baseUrl}/api/demo-workspace/rfqs`, {
      method: 'POST',
      headers: { ...headersA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Demo Custom Manifold Batch',
        currency: 'INR',
        invitedSupplierIds: [createdSup.id, 'sup-demo-1'],
        items: [
          {
            skuCode: 'DEMO-MNF-01',
            description: 'CNC Aluminum Manifold Block',
            quantity: 10,
            uom: 'pcs',
            targetUnitPrice: 220,
          },
        ],
      }),
    });
    assert.equal(createRfqRes.status, 201);
    const createdRfq = (await createRfqRes.json()) as { id: string; rfqNumber: string };
    assert.match(createdRfq.rfqNumber, /^DEMO-RFQ-2026-/);

    const loadSampleRes = await fetch(`${srv.baseUrl}/api/demo-workspace/rfqs/load-sample`, {
      method: 'POST',
      headers: headersA,
    });
    assert.equal(loadSampleRes.status, 201);

    // 4. Reject spoofed upload (.exe) with 415
    const badForm = new FormData();
    badForm.append('supplierId', createdSup.id);
    badForm.append(
      'file',
      new Blob([Buffer.from('MZ\x90\x00not-a-pdf')], { type: 'application/pdf' }),
      'malware.exe'
    );
    const badUploadRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/rfqs/${createdRfq.id}/quotes/extract`,
      { method: 'POST', headers: headersA, body: badForm }
    );
    assert.equal(badUploadRes.status, 415);

    // 5. Upload & extract valid PNG quote + verify signed URL & cross-session doc isolation
    const pngBytes = createMinimalValidPng();
    const goodForm = new FormData();
    goodForm.append('supplierId', createdSup.id);
    goodForm.append('file', new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }), 'demo-quote.png');
    const extractRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/rfqs/${createdRfq.id}/quotes/extract`,
      { method: 'POST', headers: headersA, body: goodForm }
    );
    assert.equal(extractRes.status, 201);
    const extractedQuote = (await extractRes.json()) as { id: string; documentId: string | null };
    assert.ok(extractedQuote.documentId);

    const signedUrlRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/documents/${extractedQuote.documentId}/signed-url`,
      { headers: headersA }
    );
    assert.equal(signedUrlRes.status, 200);
    const signedPayload = (await signedUrlRes.json()) as { url: string; mimeType: string };
    assert.equal(signedPayload.mimeType, 'image/png');

    const contentRes = await fetch(`${srv.baseUrl}${signedPayload.url}`);
    assert.equal(contentRes.status, 200);
    const fetchedBuf = Buffer.from(await contentRes.arrayBuffer());
    assert.equal(Buffer.compare(fetchedBuf, pngBytes), 0);

    // Tampered signature -> 403
    const tamperedUrl = signedPayload.url.replace(/sig=[^&]+/, 'sig=deadbeef');
    const tamperedRes = await fetch(`${srv.baseUrl}${tamperedUrl}`);
    assert.equal(tamperedRes.status, 403);

    // Session B cannot fetch signed URL for Session A's document -> 404
    const crossDocRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/documents/${extractedQuote.documentId}/signed-url`,
      { headers: headersB }
    );
    assert.equal(crossDocRes.status, 404);

    // 6. Demo math verification gate on DEMO-RFQ-2026-101 quote 2
    const failVerifyRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/quotations/demo-rfq-2026-101-q2/verify`,
      { method: 'POST', headers: headersA }
    );
    assert.equal(failVerifyRes.status, 422);

    const fixLineRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/quotations/demo-rfq-2026-101-q2/lines/demo-rfq-2026-101-q2-l3`,
      {
        method: 'PATCH',
        headers: { ...headersA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineTotalQuoted: 9200 }),
      }
    );
    assert.equal(fixLineRes.status, 200);

    const patchHeaderRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/quotations/demo-rfq-2026-101-q2`,
      {
        method: 'PATCH',
        headers: { ...headersA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ freightCharges: 12000 }),
      }
    );
    assert.equal(patchHeaderRes.status, 200);

    const passVerifyRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/quotations/demo-rfq-2026-101-q2/verify`,
      { method: 'POST', headers: headersA }
    );
    assert.equal(passVerifyRes.status, 200);

    // 7. Split/non-L1 award enforcement + approval + price memory update + deletion guard
    const stateARes = await fetch(`${srv.baseUrl}/api/demo-workspace`, { headers: headersA });
    const stateA = (await stateARes.json()) as {
      rfqs: Array<{ id: string; items: Array<{ id: string; quantity: number }> }>;
      quotations: Array<{
        id: string;
        rfqId: string;
        supplierId: string;
        lines: Array<{ id: string; rfqItemId: string | null }>;
      }>;
    };
    const rfq101 = stateA.rfqs.find((r) => r.id === 'demo-rfq-2026-101')!;
    const q1 = stateA.quotations.find((q) => q.id === 'demo-rfq-2026-101-q1')!;
    const q2 = stateA.quotations.find((q) => q.id === 'demo-rfq-2026-101-q2')!;

    // Use higher-priced q2 for first 3 items (non-L1) and q1 for gauge (which q2 didn't quote)
    const nonL1Allocs = [
      {
        rfqItemId: rfq101.items[0].id,
        quotationId: q2.id,
        quotationLineId: q2.lines[0].id,
        awardedQty: rfq101.items[0].quantity,
      },
      {
        rfqItemId: rfq101.items[1].id,
        quotationId: q2.id,
        quotationLineId: q2.lines[1].id,
        awardedQty: rfq101.items[1].quantity,
      },
      {
        rfqItemId: rfq101.items[2].id,
        quotationId: q2.id,
        quotationLineId: q2.lines[2].id,
        awardedQty: rfq101.items[2].quantity,
      },
      {
        rfqItemId: rfq101.items[3].id,
        quotationId: q1.id,
        quotationLineId: q1.lines[3].id,
        awardedQty: rfq101.items[3].quantity,
      },
    ];

    const rejectNonL1 = await fetch(
      `${srv.baseUrl}/api/demo-workspace/rfqs/demo-rfq-2026-101/award`,
      {
        method: 'POST',
        headers: { ...headersA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isSplitAward: true, allocations: nonL1Allocs }),
      }
    );
    assert.equal(rejectNonL1.status, 400);

    const submitAwardRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/rfqs/demo-rfq-2026-101/award`,
      {
        method: 'POST',
        headers: { ...headersA, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isSplitAward: true,
          nonL1Justification: 'Split faster 8-day valve delivery in demo scenario.',
          allocations: nonL1Allocs,
        }),
      }
    );
    assert.equal(submitAwardRes.status, 201);
    const createdAward = (await submitAwardRes.json()) as { id: string };

    const decideRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/awards/${createdAward.id}/decide`,
      {
        method: 'POST',
        headers: { ...headersA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', approverNotes: 'Approved in demo test' }),
      }
    );
    assert.equal(decideRes.status, 200);

    // Deleting quote referenced by approved award -> 409
    const delApprovedQuoteRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}`,
      { method: 'DELETE', headers: headersA }
    );
    assert.equal(delApprovedQuoteRes.status, 409);

    // 8. Reset demo session restores pristine synthetic state
    const resetRes = await fetch(`${srv.baseUrl}/api/demo-workspace/reset`, {
      method: 'POST',
      headers: headersA,
    });
    assert.equal(resetRes.status, 200);
    const resetBody = (await resetRes.json()) as {
      settings: { name: string };
      suppliers: Array<{ name: string }>;
      rfqs: Array<{ id: string; status: string }>;
    };
    assert.equal(resetBody.settings.name, 'Meridian Industrial Demo Works (Sample)');
    assert.equal(resetBody.suppliers.some((s) => s.name === 'Horizon Sample Alloys (Demo)'), false);
    assert.equal(resetBody.rfqs.find((r) => r.id === 'demo-rfq-2026-101')?.status, 'in_review');
  });

  it('restores normal authentication gate and disables /api/demo-workspace when demoMode is false', async () => {
    const srv = await startIntegratedTestServer({ demoMode: false, db: {} as never });
    cleanups.push(() => srv.close());

    const meRes = await fetch(`${srv.baseUrl}/api/auth/me`);
    assert.equal(meRes.status, 200);
    const me = (await meRes.json()) as { authenticated: boolean; demoMode: boolean };
    assert.equal(me.authenticated, false);
    assert.equal(me.demoMode, false);

    const demoGet = await fetch(`${srv.baseUrl}/api/demo-workspace`);
    assert.equal(demoGet.status, 410);

    const demoReset = await fetch(`${srv.baseUrl}/api/demo-workspace/reset`, { method: 'POST' });
    assert.equal(demoReset.status, 410);
  });

  it('Task 007: enforces safe DEMO_MODE defaults in dev/prod and fails closed if DEMO_MODE=true in production', async () => {
    // 1. Direct resolver matrix
    assert.equal(resolveDemoMode({ nodeEnv: 'development', envDemoMode: '' }), true);
    assert.equal(resolveDemoMode({ nodeEnv: 'development', envDemoMode: 'false' }), false);
    assert.equal(resolveDemoMode({ nodeEnv: 'test', envDemoMode: '' }), true);
    assert.equal(resolveDemoMode({ nodeEnv: 'production', envDemoMode: '' }), false);
    assert.equal(resolveDemoMode({ nodeEnv: 'production', envDemoMode: 'false' }), false);

    assert.throws(
      () => resolveDemoMode({ nodeEnv: 'production', envDemoMode: 'true' }),
      /DEMO_MODE=true is forbidden when NODE_ENV=production/
    );
    assert.throws(
      () => resolveDemoMode({ nodeEnv: 'production', demoModeOverride: true }),
      /Demo mode cannot be enabled when NODE_ENV=production/
    );
    assert.throws(
      () => resolveDemoMode({ nodeEnv: 'development', envDemoMode: 'maybe' }),
      /Invalid DEMO_MODE value/
    );

    // 2. Startup check under simulated NODE_ENV=production
    const prevNodeEnv = process.env.NODE_ENV;
    const prevDemoMode = process.env.DEMO_MODE;
    const prevSessionSecret = process.env.SESSION_SECRET;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-prod-check-'));
    try {
      process.env.NODE_ENV = 'production';
      process.env.SESSION_SECRET = '0123456789abcdef0123456789abcdef-prod-test';
      process.env.DEMO_MODE = 'true';

      await assert.rejects(
        () =>
          createApp({
            enableVite: false,
            storageProvider: new LocalPrivateStorageProvider(tmpDir),
            emailProvider: new DevOutboxEmailProvider(),
          }),
        /DEMO_MODE=true is forbidden when NODE_ENV=production/
      );

      // Unset DEMO_MODE in production -> defaults cleanly to OFF (false) and disables demo routes
      delete process.env.DEMO_MODE;
      const prodApp = await createApp({
        enableVite: false,
        storageProvider: new LocalPrivateStorageProvider(tmpDir),
        emailProvider: new DevOutboxEmailProvider(),
      });
      assert.equal(typeof prodApp, 'function');
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevDemoMode === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prevDemoMode;
      if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSessionSecret;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Task 007: isolates demo rate limiters completely from PostgreSQL/primary RateLimitStore and rejects unknown session signed-url lookups', async () => {
    let primaryStoreHits = 0;
    const throwingPgStore: RateLimitStore = {
      async consume() {
        primaryStoreHits += 1;
        throw new Error('Primary PostgresRateLimitStore must NEVER be invoked for /api/demo-workspace* routes');
      },
    };

    const srv = await startIntegratedTestServer({
      demoMode: true,
      rateLimitStore: throwingPgStore,
      demoMutationLimitMax: 3,
      demoExtractLimitMax: 2,
    });
    cleanups.push(() => srv.close());

    const sessId = `test-iso-${uniqueRunTag()}`;
    const headers = { 'X-Demo-Session': sessId, 'Content-Type': 'application/json' };

    // Unknown/missing session signed-url lookup must fail cleanly (404) without touching PG or allocating a session
    const missingSessRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/documents/demo-rfq-2026-101-doc-1/signed-url`
    );
    assert.equal(missingSessRes.status, 404);

    const unknownSessRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/documents/demo-rfq-2026-101-doc-1/signed-url`,
      { headers: { 'X-Demo-Session': 'does-not-exist-anywhere' } }
    );
    assert.equal(unknownSessRes.status, 404);

    // 3 mutations succeed cleanly using MemoryRateLimitStore, 4th trips demo 429; zero hits to primary PG store
    for (let i = 0; i < 3; i += 1) {
      const r = await fetch(`${srv.baseUrl}/api/demo-workspace/settings`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: `Isolated Demo ${i}` }),
      });
      assert.equal(r.status, 200);
    }
    const overLimitRes = await fetch(`${srv.baseUrl}/api/demo-workspace/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Should Trigger Demo Limit' }),
    });
    assert.equal(overLimitRes.status, 429);
    assert.equal(primaryStoreHits, 0);
  });

  it('Task 007: serves genuine synthetic PDF and Excel binary previews for preloaded & load-sample quotes, enforces validation, and builds complete exports', async () => {
    const srv = await startIntegratedTestServer({ demoMode: true });
    cleanups.push(() => srv.close());

    const sessId = `test-bins-${uniqueRunTag()}`;
    const headers = { 'X-Demo-Session': sessId };

    // Initial workspace must have non-null documentIds on PDF and XLSX sample quotes
    const wsRes = await fetch(`${srv.baseUrl}/api/demo-workspace`, { headers });
    assert.equal(wsRes.status, 200);
    const ws = (await wsRes.json()) as {
      settings: OrganizationSettings;
      suppliers: Supplier[];
      rfqs: Rfq[];
      quotations: Quotation[];
      awards: AwardDecision[];
      auditLogs: AuditLogEntry[];
    };

    const q1 = ws.quotations.find((q) => q.id === 'demo-rfq-2026-101-q1')!;
    const q2 = ws.quotations.find((q) => q.id === 'demo-rfq-2026-101-q2')!;
    const aq1 = ws.quotations.find((q) => q.id === 'demo-rfq-100-q1')!;
    const aq2 = ws.quotations.find((q) => q.id === 'demo-rfq-100-q2')!;

    assert.ok(q1.documentId, 'Preloaded q1 PDF must have documentId');
    assert.ok(q2.documentId, 'Preloaded q2 XLSX must have documentId');
    assert.ok(aq1.documentId, 'Historical awarded q1 PDF must have documentId');
    assert.ok(aq2.documentId, 'Historical awarded q2 PDF must have documentId');

    // Verify q1 signed URL serves valid %PDF- binary
    const q1SignedRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/documents/${q1.documentId}/signed-url`,
      { headers }
    );
    assert.equal(q1SignedRes.status, 200);
    const q1Signed = (await q1SignedRes.json()) as { url: string; mimeType: string };
    assert.equal(q1Signed.mimeType, 'application/pdf');
    const q1Bytes = Buffer.from(await (await fetch(`${srv.baseUrl}${q1Signed.url}`)).arrayBuffer());
    assert.equal(q1Bytes.subarray(0, 5).toString('ascii'), '%PDF-');

    // Verify q2 signed URL serves genuine parseable XLSX workbook matching Demo_Offer sheet
    const q2SignedRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/documents/${q2.documentId}/signed-url`,
      { headers }
    );
    assert.equal(q2SignedRes.status, 200);
    const q2Signed = (await q2SignedRes.json()) as { url: string; mimeType: string };
    assert.equal(
      q2Signed.mimeType,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    const q2Bytes = Buffer.from(await (await fetch(`${srv.baseUrl}${q2Signed.url}`)).arrayBuffer());
    assert.equal(q2Bytes.subarray(0, 2).toString('ascii'), 'PK');
    const parsedBook = XLSX.read(q2Bytes, { type: 'buffer' });
    assert.ok(parsedBook.SheetNames.includes('Demo_Offer'));
    const sheetRows = XLSX.utils.sheet_to_json<string[]>(parsedBook.Sheets['Demo_Offer'], {
      header: 1,
    });
    assert.equal(sheetRows[1][1], 'Ball Valve DN50 SS316L Flanged');
    assert.equal(String(sheetRows[3][5]), '10400.00');

    // Verify UOM pack-of-20 normalization on q1 line 2 (20 packs * 20 pcs = 400 pcs, 980/pack = 49/pc base + pro-rata overhead)
    assert.equal(q1.lines[1].uomConversionFactor, 20);
    assert.equal((q1.lines[1].quotedQty || 0) * q1.lines[1].uomConversionFactor, 400);
    assert.equal(q1.lines[1].normalizedUnitBase, 49);
    assert.ok(
      q1.lines[1].normalizedUnitLanded !== null &&
        q1.lines[1].normalizedUnitLanded >= 48 &&
        q1.lines[1].normalizedUnitLanded <= 55
    );

    // Load-sample also attaches genuine PDF & XLSX signed previews
    const sampleRes = await fetch(`${srv.baseUrl}/api/demo-workspace/rfqs/load-sample`, {
      method: 'POST',
      headers,
    });
    assert.equal(sampleRes.status, 201);
    const samplePayload = (await sampleRes.json()) as {
      rfq: Rfq;
      quotes: Quotation[];
    };
    assert.equal(samplePayload.quotes.length, 3);
    assert.ok(samplePayload.quotes[0].documentId);
    assert.ok(samplePayload.quotes[1].documentId);

    const samplePdfSigned = (await (
      await fetch(
        `${srv.baseUrl}/api/demo-workspace/documents/${samplePayload.quotes[0].documentId}/signed-url`,
        { headers }
      )
    ).json()) as { url: string };
    const samplePdfBytes = Buffer.from(
      await (await fetch(`${srv.baseUrl}${samplePdfSigned.url}`)).arrayBuffer()
    );
    assert.equal(samplePdfBytes.subarray(0, 5).toString('ascii'), '%PDF-');

    // Strict numeric validation rejects negative/NaN amounts with 400
    const badLineRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/quotations/demo-rfq-2026-101-q2/lines/demo-rfq-2026-101-q2-l1`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotedUnitRate: -150 }),
      }
    );
    assert.equal(badLineRes.status, 400);

    // Export Comparative Statement Excel & PDF with awarded historical RFQ (ensures Approval tab award param parity)
    const awardedRfq = ws.rfqs.find((r) => r.id === 'demo-rfq-2026-100')!;
    const awardedQuotes = ws.quotations.filter((q) => q.rfqId === awardedRfq.id);
    const existingAward = ws.awards.find((a) => a.rfqId === awardedRfq.id);
    assert.ok(existingAward);

    const wb = buildComparativeStatementWorkbook({
      rfq: awardedRfq,
      quotes: awardedQuotes,
      suppliers: ws.suppliers,
      settings: ws.settings,
      auditLogs: ws.auditLogs,
      award: existingAward,
    });
    assert.deepEqual(wb.SheetNames, ['Summary', 'Line_Matrix', 'Exceptions', 'Audit_Log']);
    const matrixRows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Line_Matrix'], {
      header: 1,
    });
    assert.ok(matrixRows.some((r) => r.includes('AWARD ALLOCATION')));

    const pdfDoc = buildComparativeStatementPdfDoc({
      rfq: awardedRfq,
      quotes: awardedQuotes,
      suppliers: ws.suppliers,
      settings: ws.settings,
      basis: 'landed',
      award: existingAward,
    });
    const pdfBytes = Buffer.from(pdfDoc.output('arraybuffer'));
    assert.equal(pdfBytes.subarray(0, 5).toString('ascii'), '%PDF-');
  });

  it('Task 007: demo quotation extraction ignores GEMINI_API_KEY and stays 100% offline', async () => {
    const prevGeminiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSyFakeKeyThatMustNeverTriggerExternalCall';

    const tempDemoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-demo-offline-'));

    // Ensure generateContentOverride is undefined (production/runtime path)
    const app = await createApp({
      enableVite: false,
      demoMode: true,
      db: {} as never,
      storageProvider: new LocalPrivateStorageProvider(tempDemoDir),
      emailProvider: new DevOutboxEmailProvider(),
    });
    const server = (await import('node:http')).default.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const form = new FormData();
      form.append('supplierId', 'sup-demo-1');
      form.append('rawEmailText', 'Ball Valve DN50: 40 pcs @ INR 4200 = 168000');

      const res = await fetch(`${baseUrl}/api/demo-workspace/rfqs/demo-rfq-2026-101/quotes/extract`, {
        method: 'POST',
        headers: { 'X-Demo-Session': `offline-check-${uniqueRunTag()}` },
        body: form,
      });
      assert.equal(res.status, 201);
      const quote = (await res.json()) as {
        quoteReference: string;
        lines: Array<{ rawDescription: string }>;
      };
      assert.match(quote.quoteReference, /^DEMO-EXT-/);
      assert.ok(quote.lines.some((l) => l.rawDescription.includes('(Demo Parsed)')));
    } finally {
      if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGeminiKey;
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
      fs.rmSync(tempDemoDir, { recursive: true, force: true });
    }
  });

  it('Task 007.2: enforces award withdrawal, pending/rejected quote immutability, historical rejection preservation, and quantity shortfall 422 over HTTP', async () => {
    const srv = await startIntegratedTestServer({ demoMode: true });
    cleanups.push(() => srv.close());

    const sessId = `test-0072-http-${uniqueRunTag()}`;
    const headers = { 'X-Demo-Session': sessId, 'Content-Type': 'application/json' };

    const wsRes = await fetch(`${srv.baseUrl}/api/demo-workspace`, { headers: { 'X-Demo-Session': sessId } });
    assert.equal(wsRes.status, 200);
    const ws = (await wsRes.json()) as {
      rfqs: Rfq[];
      quotations: Quotation[];
    };
    const rfq = ws.rfqs.find((r) => r.id === 'demo-rfq-2026-101')!;
    const q1 = ws.quotations.find((q) => q.id === 'demo-rfq-2026-101-q1')!;
    const q1Allocs = rfq.items.map((it) => ({
      rfqItemId: it.id,
      quotationId: q1.id,
      quotationLineId: q1.lines.find((l) => l.rfqItemId === it.id)!.id,
    }));

    // 1. Short-quantity quote cannot be awarded (422)
    const shortLinePatch = await fetch(
      `${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}/lines/${q1.lines[0].id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ quotedQty: 5, lineTotalQuoted: 5 * (q1.lines[0].quotedUnitRate || 0) }),
      }
    );
    assert.equal(shortLinePatch.status, 200);
    assert.equal(
      (
        await fetch(`${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}/verify`, {
          method: 'POST',
          headers: { 'X-Demo-Session': sessId },
        })
      ).status,
      200
    );
    const shortAwardRes = await fetch(`${srv.baseUrl}/api/demo-workspace/rfqs/${rfq.id}/award`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ isSplitAward: false, allocations: q1Allocs }),
    });
    assert.equal(shortAwardRes.status, 422);

    // Restore full quantity and verify
    await fetch(
      `${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}/lines/${q1.lines[0].id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          quotedQty: q1.lines[0].quotedQty,
          lineTotalQuoted: q1.lines[0].lineTotalQuoted,
        }),
      }
    );
    assert.equal(
      (
        await fetch(`${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}/verify`, {
          method: 'POST',
          headers: { 'X-Demo-Session': sessId },
        })
      ).status,
      200
    );

    // 2. Submit pending award -> editing/deleting quote blocked (409) -> withdraw (200) -> unblocked
    const pendingRes = await fetch(`${srv.baseUrl}/api/demo-workspace/rfqs/${rfq.id}/award`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ isSplitAward: false, allocations: q1Allocs }),
    });
    assert.equal(pendingRes.status, 201);
    const pendingAward = (await pendingRes.json()) as { id: string };

    assert.equal(
      (
        await fetch(`${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ freightCharges: 100 }),
        })
      ).status,
      409
    );
    assert.equal(
      (
        await fetch(`${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}`, {
          method: 'DELETE',
          headers: { 'X-Demo-Session': sessId },
        })
      ).status,
      409
    );

    const withdrawRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/awards/${pendingAward.id}/withdraw`,
      { method: 'POST', headers: { 'X-Demo-Session': sessId } }
    );
    assert.equal(withdrawRes.status, 200);
    const withdrawBody = (await withdrawRes.json()) as { withdrawnAwardId: string; rfq: Rfq };
    assert.equal(withdrawBody.withdrawnAwardId, pendingAward.id);
    assert.equal(withdrawBody.rfq.status, 'in_review');

    // 3. Resubmit -> reject -> historical snapshot blocks quote DELETE (409) -> resubmit revised & approve
    const pending2 = (await (
      await fetch(`${srv.baseUrl}/api/demo-workspace/rfqs/${rfq.id}/award`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ isSplitAward: false, allocations: q1Allocs }),
      })
    ).json()) as { id: string };

    const rejectRes = await fetch(`${srv.baseUrl}/api/demo-workspace/awards/${pending2.id}/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'rejected', approverNotes: 'Update terms first' }),
    });
    assert.equal(rejectRes.status, 200);

    // Deleting quote referenced by historical rejected award -> 409
    assert.equal(
      (
        await fetch(`${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}`, {
          method: 'DELETE',
          headers: { 'X-Demo-Session': sessId },
        })
      ).status,
      409
    );

    // Revise & re-verify quote -> resubmit -> approve
    assert.equal(
      (
        await fetch(`${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ paymentTerms: 'Net 45 Revised' }),
        })
      ).status,
      200
    );
    assert.equal(
      (
        await fetch(`${srv.baseUrl}/api/demo-workspace/quotations/${q1.id}/verify`, {
          method: 'POST',
          headers: { 'X-Demo-Session': sessId },
        })
      ).status,
      200
    );

    const pending3 = (await (
      await fetch(`${srv.baseUrl}/api/demo-workspace/rfqs/${rfq.id}/award`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ isSplitAward: false, allocations: q1Allocs }),
      })
    ).json()) as { id: string };
    assert.equal(
      (
        await fetch(`${srv.baseUrl}/api/demo-workspace/awards/${pending3.id}/decide`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ decision: 'approved', approverNotes: 'Final PO approved' }),
        })
      ).status,
      200
    );

    const wsAfter = (await (
      await fetch(`${srv.baseUrl}/api/demo-workspace`, { headers: { 'X-Demo-Session': sessId } })
    ).json()) as { awards: AwardDecision[] };
    const rfqAwards = wsAfter.awards.filter((a) => a.rfqId === rfq.id);
    assert.equal(rfqAwards.some((a) => a.id === pending2.id && a.approvalStatus === 'rejected'), true);
    assert.equal(rfqAwards.some((a) => a.id === pending3.id && a.approvalStatus === 'approved'), true);
  });
});
