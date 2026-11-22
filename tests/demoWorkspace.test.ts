import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  createMinimalValidPng,
  startIntegratedTestServer,
  uniqueRunTag,
} from './_helpers.ts';

describe('Task 006: Temporary No-Login Demo Workspace & Security Isolation', () => {
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
    const srv = await startIntegratedTestServer({ demoMode: false });
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
});
