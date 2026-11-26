import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComparativeStatementPdfDoc,
  buildComparativeStatementWorkbook,
} from '../src/lib/exporters.ts';
import { computeEvaluatedSavings, rankQuotations } from '../src/lib/ranking.ts';
import type { WorkspaceState } from '../src/types.ts';
import {
  cleanupTestOrganizationsAndUsers,
  closeTestDbPool,
  createMinimalValidPng,
  isSafeTestDbConfigured,
  startIntegratedTestServer,
  TEST_DB_SKIP_REASON,
  TestCookieClient,
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

test(
  'Complete 20-step multi-tenant B2B procurement workflow + cross-tenant isolation',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
  const tag = uniqueRunTag();
  let extractScenario: 'l1_good' | 'l2_badmath' | 'l3_partial' = 'l1_good';

  const srv = await startIntegratedTestServer({
    firebaseVerifier: async (idToken) => {
      if (idToken === 'valid-approver-google-token') {
        return {
          uid: `g-approver-${tag}`,
          email: `approver-${tag}@example.com`,
          name: 'Vikram Approver',
          email_verified: true,
        };
      }
      throw new Error('Invalid Firebase ID token');
    },
    generateContentOverride: async (params) => {
      const textPart =
        params.contents.parts.find((p): p is { text: string } => 'text' in p)?.text || '';
      const idMatches = [...textPart.matchAll(/rfqItemId:\s*"([^"]+)"/g)].map((m) => m[1]);
      const item1 = idMatches[0];
      const item2 = idMatches[1];

      if (extractScenario === 'l1_good') {
        return {
          text: JSON.stringify({
            quoteReference: 'SUP1-Q-101',
            currency: 'INR',
            leadTimeDays: 5,
            paymentTerms: 'Net 30',
            freightCharges: 200,
            packingForwarding: 100,
            otherCharges: 0,
            globalDiscount: 0,
            taxIncludedInRates: false,
            missingFreightWarning: false,
            lines: [
              {
                vendorLineNo: 1,
                rawDescription: 'Hydraulic Manifold Block',
                matchedRfqItemId: item1,
                matchStatus: 'matched',
                quotedQty: 10,
                quotedUom: 'pcs',
                uomConversionFactor: 1,
                quotedUnitRate: 1000,
                discountAmount: 0,
                taxRatePct: 18,
                lineTotalQuoted: 10000,
                confidenceScore: 0.96,
                snippet: '10 pcs @ 1000 = 10000',
              },
              {
                vendorLineNo: 2,
                rawDescription: 'High-Pressure Seal Kit',
                matchedRfqItemId: item2,
                matchStatus: 'matched',
                quotedQty: 20,
                quotedUom: 'pcs',
                uomConversionFactor: 1,
                quotedUnitRate: 250,
                discountAmount: 0,
                taxRatePct: 18,
                lineTotalQuoted: 5000,
                confidenceScore: 0.95,
                snippet: '20 pcs @ 250 = 5000',
              },
            ],
          }),
        };
      }

      if (extractScenario === 'l2_badmath') {
        return {
          text: JSON.stringify({
            quoteReference: 'SUP2-Q-202',
            currency: 'INR',
            leadTimeDays: 7,
            paymentTerms: 'Net 45',
            freightCharges: 500,
            packingForwarding: 0,
            otherCharges: 0,
            globalDiscount: 0,
            taxIncludedInRates: false,
            missingFreightWarning: false,
            lines: [
              {
                vendorLineNo: 1,
                rawDescription: 'Hydraulic Manifold Block',
                matchedRfqItemId: item1,
                matchStatus: 'matched',
                quotedQty: 10,
                quotedUom: 'pcs',
                uomConversionFactor: 1,
                quotedUnitRate: 1200,
                discountAmount: 0,
                taxRatePct: 18,
                // Deliberate printed vendor math error: 10 * 1200 = 12000, printed 19999
                lineTotalQuoted: 19999,
                confidenceScore: 0.89,
                snippet: '10 pcs @ 1200 = 19999',
              },
              {
                vendorLineNo: 2,
                rawDescription: 'High-Pressure Seal Kit',
                matchedRfqItemId: item2,
                matchStatus: 'matched',
                quotedQty: 20,
                quotedUom: 'pcs',
                uomConversionFactor: 1,
                quotedUnitRate: 240,
                discountAmount: 0,
                taxRatePct: 18,
                lineTotalQuoted: 4800,
                confidenceScore: 0.93,
                snippet: '20 pcs @ 240 = 4800',
              },
            ],
          }),
        };
      }

      return {
        text: JSON.stringify({
          quoteReference: 'SUP3-PARTIAL',
          currency: 'INR',
          leadTimeDays: 3,
          paymentTerms: 'Advance',
          freightCharges: 0,
          packingForwarding: 0,
          otherCharges: 0,
          globalDiscount: 0,
          taxIncludedInRates: false,
          missingFreightWarning: true,
          lines: [
            {
              vendorLineNo: 1,
              rawDescription: 'Hydraulic Manifold Block Only',
              matchedRfqItemId: item1,
              matchStatus: 'matched',
              quotedQty: 10,
              quotedUom: 'pcs',
              uomConversionFactor: 1,
              quotedUnitRate: 900,
              discountAmount: 0,
              taxRatePct: 18,
              lineTotalQuoted: 9000,
              confidenceScore: 0.91,
              snippet: '10 pcs @ 900 = 9000',
            },
          ],
        }),
      };
    },
  });

  try {
    // Step 1: Unauthenticated access & disabled demo persona switcher rejected
    const unauthRes = await fetch(`${srv.baseUrl}/api/workspace`);
    assert.equal(unauthRes.status, 401);
    const demoSwitchRes = await fetch(`${srv.baseUrl}/api/demo/switch-persona`, { method: 'POST' });
    assert.equal(demoSwitchRes.status, 410);

    // Step 2: Organization Owner registers & verifies email
    const ownerEmail = `owner-${tag}@example.com`;
    const ownerPassword = 'FounderPass#2026!';
    const ownerClient = new TestCookieClient(srv.baseUrl);
    const regOwnerRes = await ownerClient.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: ownerEmail,
        password: ownerPassword,
        fullName: 'Aarav Deshmukh',
        title: 'Director of Procurement',
        organizationName: `Deshmukh Hydraulics ${tag}`,
      }),
    });
    assert.equal(regOwnerRes.status, 201);
    const ownerAuth = (await regOwnerRes.json()) as {
      user: { id: string; emailVerified: boolean };
      activeOrganization: { id: string; role: string };
    };
    const orgAId = ownerAuth.activeOrganization.id;
    createdUserIds.push(ownerAuth.user.id);
    createdOrgIds.push(orgAId);

    const ownerVerifyMail = srv.emailProvider.sent.find((m) => m.to === ownerEmail);
    assert.ok(ownerVerifyMail);
    const ownerVerifyToken = decodeURIComponent(ownerVerifyMail.text.match(/\?verify=([^\s]+)/)![1]);
    const verifyEmailRes = await fetch(`${srv.baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ownerVerifyToken }),
    });
    assert.equal(verifyEmailRes.status, 200);

    // Step 3: Owner invites Buyer, Approver (who signs in via Google), and Viewer
    const inviteUser = async (email: string, role: 'buyer' | 'approver' | 'viewer') => {
      const invRes = await ownerClient.request('/api/organizations/current/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      assert.equal(invRes.status, 201);
      const sent = srv.emailProvider.sent.find((m) => m.to === email);
      assert.ok(sent);
      return decodeURIComponent(sent.text.match(/\?invite=([^\s]+)/)![1]);
    };

    const buyerEmail = `buyer-${tag}@example.com`;
    const buyerInviteToken = await inviteUser(buyerEmail, 'buyer');
    const approverEmail = `approver-${tag}@example.com`;
    const approverInviteToken = await inviteUser(approverEmail, 'approver');
    const viewerEmail = `viewer-${tag}@example.com`;
    const viewerInviteToken = await inviteUser(viewerEmail, 'viewer');

    // Step 4: Buyer registers with invite, Approver joins with verified Google token, Viewer registers with invite
    const buyerClient = new TestCookieClient(srv.baseUrl);
    const regBuyer = await buyerClient.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: buyerEmail,
        password: 'BuyerPass#2026!',
        fullName: 'Meera Nair',
        inviteToken: buyerInviteToken,
      }),
    });
    assert.equal(regBuyer.status, 201);
    const buyerAuth = (await regBuyer.json()) as {
      user: { id: string };
      activeOrganization: { id: string; role: string };
    };
    assert.equal(buyerAuth.activeOrganization.role, 'buyer');
    createdUserIds.push(buyerAuth.user.id);

    const approverClient = new TestCookieClient(srv.baseUrl);
    const googleApprover = await approverClient.request('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken: 'valid-approver-google-token',
        inviteToken: approverInviteToken,
      }),
    });
    assert.equal(googleApprover.status, 200);
    const approverAuth = (await googleApprover.json()) as {
      user: { id: string; hasGoogleLinked: boolean };
      activeOrganization: { id: string; role: string };
    };
    assert.equal(approverAuth.user.hasGoogleLinked, true);
    assert.equal(approverAuth.activeOrganization.role, 'approver');
    createdUserIds.push(approverAuth.user.id);

    const viewerClient = new TestCookieClient(srv.baseUrl);
    const regViewer = await viewerClient.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: viewerEmail,
        password: 'ViewerPass#2026!',
        fullName: 'Rohan Auditor',
        inviteToken: viewerInviteToken,
      }),
    });
    assert.equal(regViewer.status, 201);
    const viewerAuth = (await regViewer.json()) as { user: { id: string } };
    createdUserIds.push(viewerAuth.user.id);

    // Step 5: Owner checks members list
    const membersRes = await ownerClient.request('/api/organizations/current/members');
    assert.equal(membersRes.status, 200);
    const membersBody = (await membersRes.json()) as { members: Array<{ userId: string }> };
    assert.equal(membersBody.members.length, 4);

    // Step 6: Buyer creates catalog items + 3 suppliers (and duplicate GSTIN guard returns 409)
    const createCatalog = await buyerClient.request('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skuCode: 'HMB-100',
        name: 'Hydraulic Manifold Block',
        defaultUom: 'pcs',
        hsnSacCode: '8481',
      }),
    });
    assert.equal(createCatalog.status, 201);

    const createSup = async (name: string, gstin: string) => {
      const res = await buyerClient.request('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, taxId: gstin, city: 'Pune' }),
      });
      assert.equal(res.status, 201);
      return (await res.json()) as { id: string; name: string };
    };

    const sup1 = await createSup('Kaveri CNC Works', `27KAV${tag.slice(0, 6).toUpperCase()}Z1`);
    const sup2 = await createSup('Deccan Fluid Seals', `27DEC${tag.slice(0, 6).toUpperCase()}Z2`);
    const sup3 = await createSup('Express FastQuotes', `27EXP${tag.slice(0, 6).toUpperCase()}Z3`);

    const dupGstinRes = await buyerClient.request('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Duplicate Tax Entity', taxId: `27KAV${tag.slice(0, 6).toUpperCase()}Z1` }),
    });
    assert.equal(dupGstinRes.status, 409);

    // Step 7: Buyer creates multi-line RFQ linked to catalog + invited suppliers
    const rfqRes = await buyerClient.request('/api/rfqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Q4 Hydraulic Manifold & Seal Assembly',
        currency: 'INR',
        incoterms: 'FOR Pune Plant',
        invitedSupplierIds: [sup1.id, sup2.id, sup3.id],
        items: [
          {
            skuCode: 'HMB-100',
            description: 'Hydraulic Manifold Block',
            quantity: 10,
            uom: 'pcs',
            targetUnitPrice: 1100,
          },
          {
            skuCode: 'HPS-200',
            description: 'High-Pressure Seal Kit',
            quantity: 20,
            uom: 'pcs',
            targetUnitPrice: 260,
          },
        ],
      }),
    });
    assert.equal(rfqRes.status, 201);
    const rfq = (await rfqRes.json()) as {
      id: string;
      rfqNumber: string;
      items: Array<{ id: string; skuCode: string }>;
    };
    assert.equal(rfq.items.length, 2);

    // Step 8: Spoofed upload rejected with 415
    const spoofForm = new FormData();
    spoofForm.append('supplierId', sup1.id);
    spoofForm.append('file', new Blob(['<script>evil</script>'], { type: 'application/pdf' }), 'fake.pdf');
    const spoofRes = await buyerClient.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
      method: 'POST',
      body: spoofForm,
    });
    assert.equal(spoofRes.status, 415);

    // Step 9: Extract 3 quotations (L1 PNG upload, L2 bad math upload, L3 partial email text)
    const uploadQuote = async (
      supplierId: string,
      scenario: 'l1_good' | 'l2_badmath' | 'l3_partial',
      useFile: boolean
    ) => {
      extractScenario = scenario;
      const f = new FormData();
      f.append('supplierId', supplierId);
      if (useFile) {
        f.append(
          'file',
          new Blob([new Uint8Array(createMinimalValidPng())], { type: 'image/png' }),
          `${scenario}.png`
        );
      } else {
        f.append('rawEmailText', 'Hydraulic Manifold Block 10 pcs @ 900 INR/pc');
      }
      const res = await buyerClient.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        body: f,
      });
      assert.equal(res.status, 201);
      return (await res.json()) as {
        id: string;
        documentId: string | null;
        totalLandedCost: number;
        completenessRatio: number;
        lines: Array<{ id: string; rfqItemId: string | null; mathValid: boolean }>;
      };
    };

    const q1 = await uploadQuote(sup1.id, 'l1_good', true);
    const q2 = await uploadQuote(sup2.id, 'l2_badmath', true);
    const q3 = await uploadQuote(sup3.id, 'l3_partial', false);
    assert.equal(q2.lines[0].mathValid, false);
    assert.equal(q3.completenessRatio, 0.5);

    // Step 10: Signed URL access & tampering verification
    const signedRes = await viewerClient.request(`/api/documents/${q1.documentId}/signed-url`);
    assert.equal(signedRes.status, 200);
    const signed = (await signedRes.json()) as { url: string };
    const dlRes = await fetch(`${srv.baseUrl}${signed.url}`);
    assert.equal(dlRes.status, 200);
    assert.deepEqual(Buffer.from(await dlRes.arrayBuffer()), createMinimalValidPng());
    const badSigRes = await fetch(`${srv.baseUrl}${signed.url}0`);
    assert.equal(badSigRes.status, 403);

    // Step 11: Math verification gate blocks q2 (422) until buyer corrects printed total
    const q2VerifyBlocked = await buyerClient.request(`/api/quotations/${q2.id}/verify`, {
      method: 'POST',
    });
    assert.equal(q2VerifyBlocked.status, 422);

    const fixQ2Line = await buyerClient.request(`/api/quotations/${q2.id}/lines/${q2.lines[0].id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineTotalQuoted: 12000 }),
    });
    assert.equal(fixQ2Line.status, 200);

    // Step 12: Verify q1 & q2 (q3 stays incomplete)
    assert.equal(
      (await buyerClient.request(`/api/quotations/${q1.id}/verify`, { method: 'POST' })).status,
      200
    );
    assert.equal(
      (await buyerClient.request(`/api/quotations/${q2.id}/verify`, { method: 'POST' })).status,
      200
    );

    // Step 13: Deterministic ranking & savings check via workspace load
    const ws1Res = await buyerClient.request('/api/workspace');
    assert.equal(ws1Res.status, 200);
    const ws1 = (await ws1Res.json()) as WorkspaceState;
    const rfqQuotes = ws1.quotations.filter((q) => q.rfqId === rfq.id);
    const ranked = rankQuotations(rfqQuotes, 'landed');
    assert.equal(ranked[0].quotation.id, q1.id);
    assert.equal(ranked[0].rankLabel, 'L1');
    assert.equal(ranked[1].quotation.id, q2.id);
    assert.equal(ranked[1].rankLabel, 'L2');
    assert.equal(ranked[2].quotation.id, q3.id);
    assert.equal(ranked[2].eligibleForAwardRank, false);
    assert.ok(computeEvaluatedSavings([ws1.rfqs[0]], rfqQuotes) > 0);

    // Step 14: Viewer blocked from recommending award (403); Buyer submits split award (item1 -> q1, item2 -> q2)
    const splitAllocations = [
      {
        rfqItemId: rfq.items[0].id,
        quotationId: q1.id,
        quotationLineId: q1.lines.find((l) => l.rfqItemId === rfq.items[0].id)!.id,
      },
      {
        rfqItemId: rfq.items[1].id,
        quotationId: q2.id,
        quotationLineId: q2.lines.find((l) => l.rfqItemId === rfq.items[1].id)!.id,
      },
    ];

    const viewerAwardBlocked = await viewerClient.request(`/api/rfqs/${rfq.id}/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isSplitAward: true, allocations: splitAllocations }),
    });
    assert.equal(viewerAwardBlocked.status, 403);

    const submitAwardRes = await buyerClient.request(`/api/rfqs/${rfq.id}/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isSplitAward: true,
        nonL1Justification: 'Split between Kaveri (manifold L1) and Deccan (seal kit lower rate)',
        allocations: splitAllocations,
      }),
    });
    assert.equal(submitAwardRes.status, 201);
    const submittedAward = (await submitAwardRes.json()) as { id: string };

    // Step 15: Buyer cannot self-approve award (403); Approver approves award (200)
    const buyerApproveBlocked = await buyerClient.request(
      `/api/awards/${submittedAward.id}/decide`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      }
    );
    assert.equal(buyerApproveBlocked.status, 403);

    const approveRes = await approverClient.request(`/api/awards/${submittedAward.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', approverNotes: 'Approved split award' }),
    });
    assert.equal(approveRes.status, 200);

    // Step 16: Approved quote cannot be deleted (409); Item price memory updated
    const delApproved = await ownerClient.request(`/api/quotations/${q1.id}`, {
      method: 'DELETE',
    });
    assert.equal(delApproved.status, 409);

    const wsAfterRes = await ownerClient.request('/api/workspace');
    const wsAfter = (await wsAfterRes.json()) as WorkspaceState;
    const hmbItem = wsAfter.items.find((it) => it.skuCode === 'HMB-100');
    assert.ok(hmbItem);
    assert.ok((hmbItem.lastAwardedUnitPrice ?? 0) > 0);
    assert.ok(hmbItem.priceHistory.some((ph) => ph.rfqId === rfq.id));

    // Step 17: Comparative Statement Excel & PDF exports build cleanly with expected sheets/bytes
    const awardRecord = wsAfter.awards.find((a) => a.id === submittedAward.id);
    const wb = buildComparativeStatementWorkbook({
      rfq: wsAfter.rfqs.find((r) => r.id === rfq.id)!,
      quotes: wsAfter.quotations.filter((q) => q.rfqId === rfq.id),
      suppliers: wsAfter.suppliers,
      settings: wsAfter.settings,
      auditLogs: wsAfter.auditLogs,
      award: awardRecord,
    });
    assert.deepEqual(wb.sheetNames, ['Summary', 'Line_Matrix', 'Exceptions', 'Audit_Log']);
    const xlsxBuf = Buffer.from(await wb.toUint8Array());
    assert.ok(xlsxBuf.byteLength > 1000);

    const pdfDoc = buildComparativeStatementPdfDoc({
      rfq: wsAfter.rfqs.find((r) => r.id === rfq.id)!,
      quotes: wsAfter.quotations.filter((q) => q.rfqId === rfq.id),
      suppliers: wsAfter.suppliers,
      settings: wsAfter.settings,
      basis: 'landed',
      award: awardRecord,
    });
    const pdfBytes = pdfDoc.output('arraybuffer');
    assert.ok(pdfBytes.byteLength > 1000);

    // Step 18: Cross-tenant isolation verification against an independent second organization
    const outsiderClient = new TestCookieClient(srv.baseUrl);
    const regOutsider = await outsiderClient.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `outsider-${tag}@example.com`,
        password: 'OutsiderPass#2026!',
        fullName: 'Outsider Owner',
        organizationName: `Outsider Works ${tag}`,
      }),
    });
    assert.equal(regOutsider.status, 201);
    const outBody = (await regOutsider.json()) as {
      user: { id: string };
      activeOrganization: { id: string };
    };
    createdUserIds.push(outBody.user.id);
    createdOrgIds.push(outBody.activeOrganization.id);

    const outWs = (await (await outsiderClient.request('/api/workspace')).json()) as WorkspaceState;
    assert.equal(outWs.rfqs.some((r) => r.id === rfq.id), false);
    assert.equal(
      (await outsiderClient.request(`/api/documents/${q1.documentId}/signed-url`)).status,
      404
    );
    assert.equal(
      (
        await outsiderClient.request('/api/organizations/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organizationId: orgAId }),
        })
      ).status,
      403
    );

    // Step 19: Organization creation & switching for Owner within own memberships
    const secondOrgRes = await ownerClient.request('/api/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Deshmukh Exports ${tag}`, defaultCurrency: 'USD', taxRegime: 'US_TAX' }),
    });
    assert.equal(secondOrgRes.status, 201);
    const secondOrg = ((await secondOrgRes.json()) as { organization: { id: string } }).organization;
    createdOrgIds.push(secondOrg.id);

    assert.equal(
      (
        await ownerClient.request('/api/organizations/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organizationId: orgAId }),
        })
      ).status,
      200
    );

    // Step 20: Password reset invalidates Owner's active sessions and rejects token reuse
    const forgotRes = await fetch(`${srv.baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail }),
    });
    assert.equal(forgotRes.status, 200);
    const resetMail = srv.emailProvider.sent.find(
      (m) => m.to === ownerEmail && m.subject.includes('Password Reset')
    );
    assert.ok(resetMail);
    const resetToken = decodeURIComponent(resetMail.text.match(/\?reset=([^\s]+)/)![1]);

    const doReset = await fetch(`${srv.baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: 'FounderNewPass#2026!' }),
    });
    assert.equal(doReset.status, 200);

    // Existing owner session is revoked
    const staleOwnerWs = await ownerClient.request('/api/workspace');
    assert.equal(staleOwnerWs.status, 401);

    // Reusing reset token is rejected
    const reuseReset = await fetch(`${srv.baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: 'AnotherPassword#2026!' }),
    });
    assert.equal(reuseReset.status, 400);
  } finally {
    await srv.close();
  }
});
