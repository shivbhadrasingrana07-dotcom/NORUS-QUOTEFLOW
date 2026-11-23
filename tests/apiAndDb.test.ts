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
