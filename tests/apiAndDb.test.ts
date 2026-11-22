import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { createApp } from '../server.ts';
import { loadWorkspace, mutateWorkspace } from '../server/db.ts';
import { WorkspaceState } from '../src/types.ts';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-quoteflow-test-'));
const testDbPath = path.join(tempDir, 'test-db.json');
process.env.QUOTEFLOW_DB_PATH = testDbPath;

after(() => {
  delete process.env.QUOTEFLOW_DB_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function startTestServer() {
  let rejectNextMath = false;
  const app = await createApp({
    enableVite: false,
    generateContentOverride: async (params) => {
      const textPart = params.contents.parts.find((p): p is { text: string } => 'text' in p)?.text || '';
      const idMatches = [...textPart.matchAll(/rfqItemId:\s*"([^"]+)"/g)].map((m) => m[1]);
      const lineTotal = rejectNextMath ? 999999 : 2000;
      rejectNextMath = false;
      return {
        text: JSON.stringify({
          quoteReference: 'MOCK-Q-88',
          currency: 'INR',
          leadTimeDays: 5,
          paymentTerms: 'Net 30',
          freightCharges: 100,
          packingForwarding: 0,
          otherCharges: 0,
          globalDiscount: 0,
          taxIncludedInRates: false,
          missingFreightWarning: false,
          lines: idMatches.map((id, idx) => ({
            vendorLineNo: idx + 1,
            rawDescription: `Mock Line ${idx + 1}`,
            matchedRfqItemId: id,
            matchStatus: 'matched',
            quotedQty: 10,
            quotedUom: 'pcs',
            uomConversionFactor: 1,
            quotedUnitRate: 200,
            discountAmount: 0,
            taxRatePct: 18,
            lineTotalQuoted: idx === 0 ? lineTotal : 2000,
            confidenceScore: 0.94,
            snippet: `Mock Line ${idx + 1} @ 200`,
          })),
        }),
      };
    },
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setBadMathNext: () => {
      rejectNextMath = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

test('Database layer initializes cleanly, serializes concurrent mutations, and preserves corrupt backups', async () => {
  const initial = loadWorkspace();
  assert.ok(initial.rfqs.length >= 1);
  assert.ok(fs.existsSync(testDbPath));

  // Concurrent mutations should not lose any updates
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      mutateWorkspace((state) => {
        state.suppliers.push({
          id: `sup-conc-${i}`,
          name: `Concurrent Supplier ${i}`,
          taxId: `27CONC000${i}Z1`,
          city: 'Pune',
          contactName: 'Test',
          email: `c${i}@example.com`,
          phoneWhatsapp: '9999999999',
          defaultPaymentTerms: 'Net 30',
          categories: ['Test'],
          createdAt: new Date().toISOString(),
        });
      })
    )
  );

  const afterConcurrent = loadWorkspace();
  for (let i = 0; i < 6; i += 1) {
    assert.ok(afterConcurrent.suppliers.some((s) => s.id === `sup-conc-${i}`));
  }

  // Corrupt DB test on separate file so testDbPath stays valid for HTTP tests
  const corruptPath = path.join(tempDir, 'corrupt-db.json');
  fs.writeFileSync(corruptPath, '{bad json', 'utf-8');
  process.env.QUOTEFLOW_DB_PATH = corruptPath;
  assert.throws(() => loadWorkspace(), /unreadable or corrupted/);
  const backupFiles = fs.readdirSync(tempDir).filter((f) => f.startsWith('corrupt-db.json.corrupt.'));
  assert.equal(backupFiles.length, 1);
  process.env.QUOTEFLOW_DB_PATH = testDbPath;
});

test('End-to-end API workflow: health, RFQ, supplier duplicate check, upload security, math gate, award RBAC, price memory, and deletion guard', async () => {
  const srv = await startTestServer();
  try {
    // 1. Health check
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { status: string; rfqs: number };
    assert.equal(health.status, 'ok');

    // 2. Create RFQ
    const rfqRes = await fetch(`${srv.baseUrl}/api/rfqs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'API Test Bracket Lot',
        currency: 'INR',
        items: [{ skuCode: 'BRK-10', description: 'SS Bracket 10mm', quantity: 10, uom: 'pcs', targetUnitPrice: 250 }],
      }),
    });
    assert.equal(rfqRes.status, 201);
    const createdRfq = (await rfqRes.json()) as { id: string; rfqNumber: string; items: { id: string }[] };
    assert.match(createdRfq.rfqNumber, /^RFQ-\d{4}-\d{4}$/);

    // 3. Supplier create + duplicate GSTIN check (409)
    const supRes = await fetch(`${srv.baseUrl}/api/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Precision Metals Ltd', taxId: '27PREC1234Z1' }),
    });
    assert.equal(supRes.status, 201);
    const createdSup = (await supRes.json()) as { id: string };

    const dupRes = await fetch(`${srv.baseUrl}/api/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Another Name', taxId: '27PREC1234Z1' }),
    });
    assert.equal(dupRes.status, 409);

    // 4. Reject spoofed PDF upload with 415
    const badForm = new FormData();
    badForm.append('supplierId', createdSup.id);
    badForm.append('file', new Blob(['<html>not-a-pdf</html>'], { type: 'application/pdf' }), 'spoof.pdf');
    const badUploadRes = await fetch(`${srv.baseUrl}/api/rfqs/${createdRfq.id}/quotes/extract`, {
      method: 'POST',
      body: badForm,
    });
    assert.equal(badUploadRes.status, 415);

    // 5. Extract quotation with bad vendor math -> verify blocked with 422 -> fix line -> verify succeeds 200
    srv.setBadMathNext();
    const textForm = new FormData();
    textForm.append('supplierId', createdSup.id);
    textForm.append('rawEmailText', 'SS Bracket 10 pcs @ 200 = 999999');
    const extractRes = await fetch(`${srv.baseUrl}/api/rfqs/${createdRfq.id}/quotes/extract`, {
      method: 'POST',
      body: textForm,
    });
    assert.equal(extractRes.status, 201);
    const quote = (await extractRes.json()) as { id: string; lines: { id: string; mathValid: boolean }[] };
    assert.equal(quote.lines[0].mathValid, false);

    const verifyBlocked = await fetch(`${srv.baseUrl}/api/quotations/${quote.id}/verify`, { method: 'POST' });
    assert.equal(verifyBlocked.status, 422);

    const patchLine = await fetch(`${srv.baseUrl}/api/quotations/${quote.id}/lines/${quote.lines[0].id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineTotalQuoted: 2000 }),
    });
    assert.equal(patchLine.status, 200);

    const verifyOk = await fetch(`${srv.baseUrl}/api/quotations/${quote.id}/verify`, { method: 'POST' });
    assert.equal(verifyOk.status, 200);

    // 6. RBAC: Viewer cannot mutate or submit award (403)
    const switchViewer = await fetch(`${srv.baseUrl}/api/demo/switch-persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeUserRole: 'viewer', activeUserName: 'Audit Viewer' }),
    });
    assert.equal(switchViewer.status, 200);

    const viewerBlocked = await fetch(`${srv.baseUrl}/api/rfqs/${createdRfq.id}/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isSplitAward: false,
        allocations: [{ rfqItemId: createdRfq.items[0].id, quotationId: quote.id, quotationLineId: quote.lines[0].id }],
      }),
    });
    assert.equal(viewerBlocked.status, 403);

    // 7. Switch back to Buyer -> submit award -> Buyer blocked from deciding (403)
    await fetch(`${srv.baseUrl}/api/demo/switch-persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeUserRole: 'buyer', activeUserName: 'Priya Sharma' }),
    });

    const awardRes = await fetch(`${srv.baseUrl}/api/rfqs/${createdRfq.id}/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isSplitAward: false,
        allocations: [{ rfqItemId: createdRfq.items[0].id, quotationId: quote.id, quotationLineId: quote.lines[0].id }],
      }),
    });
    assert.equal(awardRes.status, 201);
    const createdAward = (await awardRes.json()) as { id: string; totalAwardedLanded: number };
    assert.equal(createdAward.totalAwardedLanded, 2100); // 2000 base + 100 freight

    const buyerApproveBlocked = await fetch(`${srv.baseUrl}/api/awards/${createdAward.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(buyerApproveBlocked.status, 403);

    // 8. Switch to Approver -> approve award -> updates Item Price Memory & blocks deleting approved quote (409)
    await fetch(`${srv.baseUrl}/api/demo/switch-persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeUserRole: 'approver', activeUserName: 'Vikram Patel' }),
    });

    const approveRes = await fetch(`${srv.baseUrl}/api/awards/${createdAward.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', approverNotes: 'Approved in test' }),
    });
    assert.equal(approveRes.status, 200);

    const deleteApprovedQuote = await fetch(`${srv.baseUrl}/api/quotations/${quote.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteApprovedQuote.status, 409);

    const wsRes = await fetch(`${srv.baseUrl}/api/workspace`);
    const ws = (await wsRes.json()) as WorkspaceState;
    const itemMemory = ws.items.find((it) => it.skuCode === 'BRK-10');
    assert.ok(itemMemory);
    assert.equal(itemMemory.lastAwardedUnitPrice, 210); // 2100 / 10 pcs
    assert.equal(itemMemory.priceHistory[0].rfqId, createdRfq.id);
    assert.ok(ws.auditLogs.some((a) => a.action === 'AWARD_APPROVED' && a.entityId === createdAward.id));
  } finally {
    await srv.close();
  }
});
