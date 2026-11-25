import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyJsonToPostgres } from '../server/legacyMigration.ts';
import { LocalPrivateStorageProvider } from '../server/objectStorage.ts';
import type { WorkspaceState } from '../src/types.ts';
import {
  cleanupTestOrganizationsAndUsers,
  closeTestDbPool,
  createMinimalValidPng,
  getTestDbAndPool,
  isSafeTestDbConfigured,
  startIntegratedTestServer,
  TEST_DB_SKIP_REASON,
  TestCookieClient,
  uniqueRunTag,
} from './_helpers.ts';

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];
const tempDirs: string[] = [];

after(async () => {
  await cleanupTestOrganizationsAndUsers({
    orgIds: createdOrgIds,
    userIds: createdUserIds,
  });
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await closeTestDbPool();
});

test(
  'End-to-end PostgreSQL procurement workflow: auth, RFQ, duplicate GSTIN guard, file upload security, math gate, RBAC, price memory, deletion guard',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    const srv = await startIntegratedTestServer();
  const tag = uniqueRunTag();

  try {
    // 1. Health check
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { status: string; database: string; storageProvider: string };
    assert.equal(health.status, 'ok');
    assert.equal(health.database, 'postgresql');

    // 2. Demo switcher is permanently disabled (410)
    const demoRes = await fetch(`${srv.baseUrl}/api/demo/switch-persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeUserRole: 'admin' }),
    });
    assert.equal(demoRes.status, 410);

    // 3. Register organization owner
    const ownerClient = new TestCookieClient(srv.baseUrl);
    const regRes = await ownerClient.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `owner-${tag}@example.com`,
        password: 'StrongPassword#2026',
        fullName: 'Priya Sharma',
        title: 'Head of Procurement',
        organizationName: `Test Works ${tag}`,
      }),
    });
    assert.equal(regRes.status, 201);
    const regBody = (await regRes.json()) as {
      user: { id: string };
      activeOrganization: { id: string; role: string };
    };
    assert.equal(regBody.activeOrganization.role, 'owner');
    createdUserIds.push(regBody.user.id);
    createdOrgIds.push(regBody.activeOrganization.id);

    // 4. Create RFQ
    const rfqRes = await ownerClient.request('/api/rfqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'API Test Bracket Lot',
        currency: 'INR',
        items: [
          {
            skuCode: 'BRK-10',
            description: 'SS Bracket 10mm',
            quantity: 10,
            uom: 'pcs',
            targetUnitPrice: 250,
          },
        ],
      }),
    });
    assert.equal(rfqRes.status, 201);
    const createdRfq = (await rfqRes.json()) as {
      id: string;
      rfqNumber: string;
      items: { id: string }[];
    };
    assert.match(createdRfq.rfqNumber, /^RFQ-\d{4}-\d{4}$/);

    // 5. Supplier create + duplicate GSTIN check (409)
    const supRes = await ownerClient.request('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Precision Metals Ltd', taxId: '27PREC1234Z1' }),
    });
    assert.equal(supRes.status, 201);
    const createdSup = (await supRes.json()) as { id: string };

    const dupRes = await ownerClient.request('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Another Name', taxId: '27PREC1234Z1' }),
    });
    assert.equal(dupRes.status, 409);

    // 6. Reject spoofed PDF upload with 415
    const badForm = new FormData();
    badForm.append('supplierId', createdSup.id);
    badForm.append('file', new Blob(['<html>not-a-pdf</html>'], { type: 'application/pdf' }), 'spoof.pdf');
    const badUploadRes = await ownerClient.request(`/api/rfqs/${createdRfq.id}/quotes/extract`, {
      method: 'POST',
      body: badForm,
    });
    assert.equal(badUploadRes.status, 415);

    // 7. Upload real PNG with bad vendor math -> verify blocked 422 -> fix line -> verify succeeds 200
    // Also verify document stored in private storage & downloadable only via signed URL / org auth
    srv.setBadMathNext();
    const pngForm = new FormData();
    pngForm.append('supplierId', createdSup.id);
    pngForm.append('file', new Blob([new Uint8Array(createMinimalValidPng())], { type: 'image/png' }), 'quote.png');
    const extractRes = await ownerClient.request(`/api/rfqs/${createdRfq.id}/quotes/extract`, {
      method: 'POST',
      body: pngForm,
    });
    assert.equal(extractRes.status, 201);
    const quote = (await extractRes.json()) as {
      id: string;
      documentId: string | null;
      fileDataUrl?: string;
      lines: { id: string; mathValid: boolean }[];
    };
    assert.equal(quote.lines[0].mathValid, false);
    assert.ok(quote.documentId);
    assert.equal(quote.fileDataUrl, undefined);

    const signedUrlRes = await ownerClient.request(`/api/documents/${quote.documentId}/signed-url`);
    assert.equal(signedUrlRes.status, 200);
    const signedPayload = (await signedUrlRes.json()) as { url: string; mimeType: string };
    assert.equal(signedPayload.mimeType, 'image/png');

    const dlRes = await fetch(`${srv.baseUrl}${signedPayload.url}`);
    assert.equal(dlRes.status, 200);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    assert.deepEqual(dlBuf, createMinimalValidPng());

    const tamperedDl = await fetch(`${srv.baseUrl}${signedPayload.url}tampered`);
    assert.equal(tamperedDl.status, 403);

    const verifyBlocked = await ownerClient.request(`/api/quotations/${quote.id}/verify`, {
      method: 'POST',
    });
    assert.equal(verifyBlocked.status, 422);

    const patchLine = await ownerClient.request(
      `/api/quotations/${quote.id}/lines/${quote.lines[0].id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineTotalQuoted: 2000 }),
      }
    );
    assert.equal(patchLine.status, 200);

    const verifyOk = await ownerClient.request(`/api/quotations/${quote.id}/verify`, {
      method: 'POST',
    });
    assert.equal(verifyOk.status, 200);

    // 8. Invite Viewer + Buyer + Approver to enforce real server RBAC
    const inviteAndRegister = async (role: 'viewer' | 'buyer' | 'approver', suffix: string) => {
      const email = `${suffix}-${tag}@example.com`;
      const invRes = await ownerClient.request('/api/organizations/current/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      assert.equal(invRes.status, 201);
      const sent = srv.emailProvider.sent.find((m) => m.to === email);
      assert.ok(sent);
      const tokenMatch = sent.text.match(/\?invite=([^\s]+)/);
      assert.ok(tokenMatch);
      const inviteToken = decodeURIComponent(tokenMatch[1]);

      const client = new TestCookieClient(srv.baseUrl);
      const r = await client.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: 'StrongPassword#2026',
          fullName: `${suffix.toUpperCase()} User`,
          inviteToken,
        }),
      });
      assert.equal(r.status, 201);
      const rb = (await r.json()) as { user: { id: string }; activeOrganization: { role: string } };
      assert.equal(rb.activeOrganization.role, role);
      createdUserIds.push(rb.user.id);
      return client;
    };

    const viewerClient = await inviteAndRegister('viewer', 'viewer');
    const buyerClient = await inviteAndRegister('buyer', 'buyer');
    const approverClient = await inviteAndRegister('approver', 'approver');

    // Viewer cannot submit award (403)
    const viewerBlocked = await viewerClient.request(`/api/rfqs/${createdRfq.id}/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isSplitAward: false,
        allocations: [
          {
            rfqItemId: createdRfq.items[0].id,
            quotationId: quote.id,
            quotationLineId: quote.lines[0].id,
          },
        ],
      }),
    });
    assert.equal(viewerBlocked.status, 403);

    // Buyer submits award (201) -> Buyer blocked from approving (403)
    const awardRes = await buyerClient.request(`/api/rfqs/${createdRfq.id}/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isSplitAward: false,
        allocations: [
          {
            rfqItemId: createdRfq.items[0].id,
            quotationId: quote.id,
            quotationLineId: quote.lines[0].id,
          },
        ],
      }),
    });
    assert.equal(awardRes.status, 201);
    const createdAward = (await awardRes.json()) as { id: string; totalAwardedLanded: number };
    assert.equal(createdAward.totalAwardedLanded, 2100);

    const buyerApproveBlocked = await buyerClient.request(`/api/awards/${createdAward.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(buyerApproveBlocked.status, 403);

    // Approver approves award -> updates Item Price Memory -> blocks deleting approved quote (409)
    const approveRes = await approverClient.request(`/api/awards/${createdAward.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', approverNotes: 'Approved in test' }),
    });
    assert.equal(approveRes.status, 200);

    const deleteApprovedQuote = await ownerClient.request(`/api/quotations/${quote.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteApprovedQuote.status, 409);

    const wsRes = await ownerClient.request('/api/workspace');
    assert.equal(wsRes.status, 200);
    const ws = (await wsRes.json()) as WorkspaceState;
    const itemMemory = ws.items.find((it) => it.skuCode === 'BRK-10');
    assert.ok(itemMemory);
    assert.equal(itemMemory.lastAwardedUnitPrice, 210);
    assert.equal(itemMemory.priceHistory[0].rfqId, createdRfq.id);
    assert.ok(ws.auditLogs.some((a) => a.action === 'AWARD_APPROVED' && a.entityId === createdAward.id));
  } finally {
    await srv.close();
  }
});

test(
  'Legacy JSON migration extracts inline Base64 attachments into private object storage, preserves source JSON, creates backup, and is idempotent',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    const { db } = getTestDbAndPool();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-mig-test-'));
  tempDirs.push(dir);

  const tag = uniqueRunTag();
  const orgId = `org-mig-${tag}`;
  createdOrgIds.push(orgId);

  const pngBase64 = createMinimalValidPng().toString('base64');
  const legacyState: WorkspaceState = {
    settings: {
      id: orgId,
      name: `Legacy Mig Corp ${tag}`,
      countryCode: 'IN',
      defaultCurrency: 'INR',
      taxRegime: 'INDIA_GST',
      defaultTaxCreditable: true,
      uomAliases: { nos: 'pcs' },
      activeUserName: 'Legacy User',
      activeUserTitle: 'Buyer',
      activeUserRole: 'buyer',
    },
    suppliers: [
      {
        id: `sup-mig-${tag}`,
        name: 'Legacy Vendor Pvt Ltd',
        taxId: `27LEG${tag.slice(0, 6).toUpperCase()}Z1`,
        city: 'Pune',
        contactName: 'Rohan',
        email: 'rohan@legacy.test',
        phoneWhatsapp: '9999999999',
        defaultPaymentTerms: 'Net 30',
        categories: ['Hydraulics'],
        createdAt: new Date().toISOString(),
      },
    ],
    items: [],
    rfqs: [
      {
        id: `rfq-mig-${tag}`,
        rfqNumber: `RFQ-MIG-${tag.slice(0, 4)}`,
        title: 'Legacy Valve Lot',
        status: 'collecting',
        currency: 'INR',
        incoterms: 'FOR Destination',
        deliveryLocation: 'Pune',
        deadlineDate: '2026-12-31',
        createdBy: 'Legacy Buyer',
        invitedSupplierIds: [`sup-mig-${tag}`],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        items: [
          {
            id: `rfqi-mig-${tag}`,
            rfqId: `rfq-mig-${tag}`,
            itemId: null,
            lineNo: 1,
            skuCode: 'VAL-1',
            description: 'Check Valve',
            quantity: 5,
            uom: 'pcs',
            targetUnitPrice: 100,
          },
        ],
      },
    ],
    quotations: [
      {
        id: `qt-mig-${tag}`,
        rfqId: `rfq-mig-${tag}`,
        supplierId: `sup-mig-${tag}`,
        documentName: 'legacy-quote.png',
        documentKind: 'image',
        mimeType: 'image/png',
        fileDataUrl: `data:image/png;base64,${pngBase64}`,
        parseStatus: 'verified',
        quoteReference: 'LEG-01',
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
        subtotalBase: 500,
        totalTax: 90,
        totalLandedCost: 500,
        totalGrossPayable: 590,
        completenessRatio: 1,
        isVerified: true,
        verifiedBy: null,
        verifiedAt: null,
        headerTraces: {},
        createdAt: new Date().toISOString(),
        lines: [
          {
            id: `qtl-mig-${tag}`,
            quotationId: `qt-mig-${tag}`,
            rfqItemId: `rfqi-mig-${tag}`,
            vendorLineNo: 1,
            rawDescription: 'Check Valve',
            quotedQty: 5,
            quotedUom: 'pcs',
            uomConversionFactor: 1,
            quotedUnitRate: 100,
            discountAmount: 0,
            taxRatePct: 18,
            taxCreditable: true,
            allocatedOverhead: 0,
            normalizedUnitBase: 100,
            normalizedUnitLanded: 100,
            normalizedUnitGross: 118,
            lineTotalQuoted: 500,
            expectedLineTotal: 500,
            mathValid: true,
            mathErrorDetail: null,
            matchStatus: 'matched',
            confidenceScore: 0.99,
            humanEdited: false,
            verifiedField: true,
            sourceTrace: {
              sourceType: 'image',
              snippet: 'Check Valve 5 pcs @ 100',
            },
          },
        ],
      },
    ],
    awards: [],
    auditLogs: [],
  };

  const jsonPath = path.join(dir, 'legacy.json');
  const backupDir = path.join(dir, 'backups');
  const storageDir = path.join(dir, 'private-storage');
  const originalJson = JSON.stringify(legacyState, null, 2);
  fs.writeFileSync(jsonPath, originalJson, 'utf-8');

  const storageProvider = new LocalPrivateStorageProvider(storageDir);
  const report1 = await migrateLegacyJsonToPostgres({
    db,
    storageProvider,
    jsonPath,
    backupDir,
    dryRun: false,
    confirmed: true,
    organizationIdOverride: orgId,
  });

  assert.equal(report1.integrityVerified, true);
  assert.equal(report1.targetCountsAfter?.quotations, 1);
  assert.equal(report1.targetCountsAfter?.inlineDocumentsExtracted, 1);
  assert.ok(report1.backupPath && fs.existsSync(report1.backupPath));
  assert.equal(fs.readFileSync(jsonPath, 'utf-8'), originalJson);

  // Re-run migration: must be idempotent
  const report2 = await migrateLegacyJsonToPostgres({
    db,
    storageProvider,
    jsonPath,
    backupDir,
    dryRun: false,
    confirmed: true,
    organizationIdOverride: orgId,
  });
  assert.equal(report2.integrityVerified, true);
  assert.equal(report2.targetCountsAfter?.quotations, 1);
});

test(
  'Task 007.2 PG integrity: rejected award preservation, award withdrawal, pending/approved quote lock (409), header validation, and RFQ numbering >= 9000',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    const { db } = getTestDbAndPool();
    const { rfqs } = await import('../src/db/schema.ts');
    const srv = await startIntegratedTestServer();
    const tag = uniqueRunTag();

    try {
      const ownerClient = new TestCookieClient(srv.baseUrl);
      const regRes = await ownerClient.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `owner-0072-${tag}@example.com`,
          password: 'StrongPassword#2026',
          fullName: 'Task0072 Owner',
          organizationName: `Task0072 Org ${tag}`,
        }),
      });
      assert.equal(regRes.status, 201);
      const regBody = (await regRes.json()) as {
        user: { id: string };
        activeOrganization: { id: string };
      };
      createdUserIds.push(regBody.user.id);
      createdOrgIds.push(regBody.activeOrganization.id);

      const sup = (await (
        await ownerClient.request('/api/suppliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'PG Integrity Vendor', taxId: `27INT${tag.slice(0, 6).toUpperCase()}Z1` }),
        })
      ).json()) as { id: string };

      const rfqRes = await ownerClient.request('/api/rfqs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'PG Integrity Valve Lot',
          currency: 'INR',
          items: [{ skuCode: 'VLV-1', description: 'Check Valve', quantity: 10, uom: 'pcs' }],
        }),
      });
      assert.equal(rfqRes.status, 201);
      const rfq = (await rfqRes.json()) as {
        id: string;
        rfqNumber: string;
        items: Array<{ id: string }>;
      };

      // Verify sequential RFQ numbering continues cleanly past 9000
      const year = new Date().getFullYear();
      await db.insert(rfqs).values({
        id: `rfq-seed-9000-${tag}`,
        organizationId: regBody.activeOrganization.id,
        rfqNumber: `RFQ-${year}-9000`,
        title: 'Seed 9000 RFQ',
        status: 'draft',
        currency: 'INR',
        incoterms: 'FOR',
        deliveryLocation: 'Plant',
        deadlineDate: '2026-12-31',
        createdBy: 'Owner',
        invitedSupplierIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const nextRfq = (await (
        await ownerClient.request('/api/rfqs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Post-9000 RFQ',
            currency: 'INR',
            items: [{ description: 'Bolt', quantity: 5, uom: 'pcs' }],
          }),
        })
      ).json()) as { rfqNumber: string };
      assert.equal(nextRfq.rfqNumber, `RFQ-${year}-9001`);

      // Extract & verify quote
      const f = new FormData();
      f.append('supplierId', sup.id);
      f.append('rawEmailText', 'Check Valve 10 pcs @ 200');
      const q = (await (
        await ownerClient.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
          method: 'POST',
          body: f,
        })
      ).json()) as { id: string; lines: Array<{ id: string }> };

      // Empty quoteReference and fractional leadTimeDays return 400
      assert.equal(
        (
          await ownerClient.request(`/api/quotations/${q.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quoteReference: '   ' }),
          })
        ).status,
        400
      );
      assert.equal(
        (
          await ownerClient.request(`/api/quotations/${q.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leadTimeDays: 3.5 }),
          })
        ).status,
        400
      );

      assert.equal(
        (await ownerClient.request(`/api/quotations/${q.id}/verify`, { method: 'POST' })).status,
        200
      );

      const allocs = [{ rfqItemId: rfq.items[0].id, quotationId: q.id, quotationLineId: q.lines[0].id }];

      // Submit pending -> quote locked 409 -> withdraw 200 -> resubmit & reject -> delete blocked 409 -> edit/verify -> approve preserves rejected
      const pending1 = (await (
        await ownerClient.request(`/api/rfqs/${rfq.id}/award`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isSplitAward: false, allocations: allocs }),
        })
      ).json()) as { id: string };

      assert.equal(
        (
          await ownerClient.request(`/api/quotations/${q.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ freightCharges: 250 }),
          })
        ).status,
        409
      );

      assert.equal(
        (await ownerClient.request(`/api/awards/${pending1.id}/withdraw`, { method: 'POST' })).status,
        200
      );

      const pending2 = (await (
        await ownerClient.request(`/api/rfqs/${rfq.id}/award`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isSplitAward: false, allocations: allocs }),
        })
      ).json()) as { id: string };

      assert.equal(
        (
          await ownerClient.request(`/api/awards/${pending2.id}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'rejected', approverNotes: 'Reconfirm freight' }),
          })
        ).status,
        200
      );

      assert.equal(
        (await ownerClient.request(`/api/quotations/${q.id}`, { method: 'DELETE' })).status,
        409
      );

      assert.equal(
        (
          await ownerClient.request(`/api/quotations/${q.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ freightCharges: 50 }),
          })
        ).status,
        200
      );
      assert.equal(
        (await ownerClient.request(`/api/quotations/${q.id}/verify`, { method: 'POST' })).status,
        200
      );

      const pending3 = (await (
        await ownerClient.request(`/api/rfqs/${rfq.id}/award`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isSplitAward: false, allocations: allocs }),
        })
      ).json()) as { id: string };

      assert.equal(
        (
          await ownerClient.request(`/api/awards/${pending3.id}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'approved', approverNotes: 'Approved revised award' }),
          })
        ).status,
        200
      );

      const ws = (await (await ownerClient.request('/api/workspace')).json()) as WorkspaceState;
      const rfqAwards = ws.awards.filter((a) => a.rfqId === rfq.id);
      assert.equal(rfqAwards.some((a) => a.id === pending2.id && a.approvalStatus === 'rejected'), true);
      assert.equal(rfqAwards.some((a) => a.id === pending3.id && a.approvalStatus === 'approved'), true);
    } finally {
      await srv.close();
    }
  }
);

test(
  'Task 009 PG concurrency: serializes submitAward against quotation mutations, concurrent submitAward, and withdrawAward without TOCTOU corruption',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    const srv = await startIntegratedTestServer();
    const tag = uniqueRunTag();

    try {
      const ownerClient = new TestCookieClient(srv.baseUrl);
      const regRes = await ownerClient.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `conc-009-${tag}@example.com`,
          password: 'StrongPassword#2026',
          fullName: 'Task009 Concurrency Owner',
          organizationName: `Task009 Conc Org ${tag}`,
        }),
      });
      assert.equal(regRes.status, 201);
      const regBody = (await regRes.json()) as {
        user: { id: string };
        activeOrganization: { id: string };
      };
      createdUserIds.push(regBody.user.id);
      createdOrgIds.push(regBody.activeOrganization.id);

      const sup = (await (
        await ownerClient.request('/api/suppliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Concurrent Valve Co',
            taxId: `27CNC${tag.slice(0, 6).toUpperCase()}Z1`,
          }),
        })
      ).json()) as { id: string };

      const rfq = (await (
        await ownerClient.request('/api/rfqs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Concurrency Stress Valve',
            currency: 'INR',
            items: [{ skuCode: 'CNC-1', description: 'Solenoid Valve', quantity: 10, uom: 'pcs' }],
          }),
        })
      ).json()) as { id: string; items: Array<{ id: string }> };

      const form = new FormData();
      form.append('supplierId', sup.id);
      form.append('rawEmailText', 'Solenoid Valve 10 pcs @ 500');
      const quote = (await (
        await ownerClient.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
          method: 'POST',
          body: form,
        })
      ).json()) as { id: string; lines: Array<{ id: string }> };

      assert.equal(
        (await ownerClient.request(`/api/quotations/${quote.id}/verify`, { method: 'POST' })).status,
        200
      );

      const allocs = [
        { rfqItemId: rfq.items[0].id, quotationId: quote.id, quotationLineId: quote.lines[0].id },
      ];

      // 1. Race: submitAward vs updateQuotationHeader (repeated rounds)
      for (let round = 0; round < 3; round += 1) {
        const [awardRes, patchRes] = await Promise.all([
          ownerClient.request(`/api/rfqs/${rfq.id}/award`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isSplitAward: false, allocations: allocs }),
          }),
          ownerClient.request(`/api/quotations/${quote.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ freightCharges: 100 + round * 10 }),
          }),
        ]);

        const validOutcomeA = awardRes.status === 201 && patchRes.status === 409;
        const validOutcomeB = awardRes.status === 422 && patchRes.status === 200;
        assert.equal(
          validOutcomeA || validOutcomeB,
          true,
          `Unexpected header race outcome: award=${awardRes.status}, patch=${patchRes.status}`
        );

        const wsMid = (await (await ownerClient.request('/api/workspace')).json()) as WorkspaceState;
        const qMid = wsMid.quotations.find((q) => q.id === quote.id)!;
        const pendingMid = wsMid.awards.filter(
          (a) => a.rfqId === rfq.id && a.approvalStatus === 'pending'
        );

        if (validOutcomeA) {
          assert.equal(pendingMid.length, 1);
          assert.equal(qMid.isVerified, true);
          // Clean up pending award for next round
          const wRes = await ownerClient.request(`/api/awards/${pendingMid[0].id}/withdraw`, {
            method: 'POST',
          });
          assert.equal(wRes.status, 200);
        } else {
          assert.equal(pendingMid.length, 0);
          assert.equal(qMid.isVerified, false);
          assert.equal(
            (await ownerClient.request(`/api/quotations/${quote.id}/verify`, { method: 'POST' }))
              .status,
            200
          );
        }
      }

      // 2. Race: submitAward vs updateQuotationLine
      const [lineAwardRes, patchLineRes] = await Promise.all([
        ownerClient.request(`/api/rfqs/${rfq.id}/award`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isSplitAward: false, allocations: allocs }),
        }),
        ownerClient.request(`/api/quotations/${quote.id}/lines/${quote.lines[0].id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quotedUnitRate: 510, lineTotalQuoted: 5100 }),
        }),
      ]);
      const lineOutcomeA = lineAwardRes.status === 201 && patchLineRes.status === 409;
      const lineOutcomeB = lineAwardRes.status === 422 && patchLineRes.status === 200;
      assert.equal(
        lineOutcomeA || lineOutcomeB,
        true,
        `Unexpected line race outcome: award=${lineAwardRes.status}, patch=${patchLineRes.status}`
      );
      if (lineOutcomeA) {
        const aw = (await lineAwardRes.json()) as { id: string };
        await ownerClient.request(`/api/awards/${aw.id}/withdraw`, { method: 'POST' });
      } else {
        await ownerClient.request(`/api/quotations/${quote.id}/verify`, { method: 'POST' });
      }

      // 3. Race: verifyQuotation vs submitAward after un-verifying via header edit
      assert.equal(
        (
          await ownerClient.request(`/api/quotations/${quote.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ freightCharges: 222 }),
          })
        ).status,
        200
      );
      const [verifyRes, submitAfterUnverifyRes] = await Promise.all([
        ownerClient.request(`/api/quotations/${quote.id}/verify`, { method: 'POST' }),
        ownerClient.request(`/api/rfqs/${rfq.id}/award`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isSplitAward: false, allocations: allocs }),
        }),
      ]);
      assert.equal(verifyRes.status, 200);
      assert.equal(
        submitAfterUnverifyRes.status === 201 || submitAfterUnverifyRes.status === 422,
        true
      );
      if (submitAfterUnverifyRes.status === 201) {
        const aw = (await submitAfterUnverifyRes.json()) as { id: string };
        await ownerClient.request(`/api/awards/${aw.id}/withdraw`, { method: 'POST' });
      }

      // 4. Race: Two simultaneous submitAward calls -> strictly one 201 and one 409
      const [s1, s2] = await Promise.all([
        ownerClient.request(`/api/rfqs/${rfq.id}/award`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isSplitAward: false, allocations: allocs }),
        }),
        ownerClient.request(`/api/rfqs/${rfq.id}/award`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isSplitAward: false, allocations: allocs }),
        }),
      ]);
      const statuses = [s1.status, s2.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [201, 409]);

      const winnerPayload = (s1.status === 201 ? await s1.json() : await s2.json()) as {
        id: string;
      };

      // 5. Race: withdrawAward vs updateQuotationHeader
      const [withdrawRaceRes, headerAfterWithdrawRes] = await Promise.all([
        ownerClient.request(`/api/awards/${winnerPayload.id}/withdraw`, { method: 'POST' }),
        ownerClient.request(`/api/quotations/${quote.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ freightCharges: 333 }),
        }),
      ]);
      assert.equal(withdrawRaceRes.status, 200);
      assert.equal(
        headerAfterWithdrawRes.status === 200 || headerAfterWithdrawRes.status === 409,
        true
      );

      const wsFinal = (await (await ownerClient.request('/api/workspace')).json()) as WorkspaceState;
      const rfqFinal = wsFinal.rfqs.find((r) => r.id === rfq.id)!;
      assert.equal(rfqFinal.status, 'in_review');
      assert.equal(
        wsFinal.awards.filter((a) => a.rfqId === rfq.id && a.approvalStatus === 'pending').length,
        0
      );
    } finally {
      await srv.close();
    }
  }
);
