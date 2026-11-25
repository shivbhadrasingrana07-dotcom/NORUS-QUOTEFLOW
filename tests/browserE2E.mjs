import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';

async function loadChromium() {
  try {
    const pw = await import('playwright');
    if (!pw?.chromium) {
      throw new Error('Playwright module loaded without chromium export.');
    }
    return pw.chromium;
  } catch (err) {
    console.error(
      'Playwright is required to run tests/browserE2E.mjs. Install Playwright + Chromium (e.g. `npm install --no-save playwright && npx playwright install chromium`).'
    );
    throw err;
  }
}

async function runBrowserE2E() {
  const chromium = await loadChromium();
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-e2e-downloads-'));
  const browser = await chromium.launch({ headless: true });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err instanceof Error ? err.message : String(err));
    });

    // 1. Open app root directly in DEMO_MODE without authentication prompts
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.getByText('Pre-PO Quotation Command Center').waitFor({ state: 'visible' });
    await page.getByText('DEMO ENVIRONMENT').waitFor({ state: 'visible' });

    // Confirm no login screen appears
    assert.equal(await page.getByText('Continue with Google').count(), 0);

    // 2. Open DEMO-RFQ-2026-101 into Comparison Matrix
    await page.getByText('DEMO-RFQ-2026-101').first().click();
    await page.getByText('Sample Batch — SS316L Process Valves & Flange Hardware (Demo)').waitFor({
      state: 'visible',
    });

    // Assert exclusion indicators and cost basis toggling in Comparison Matrix
    await page.getByText(/Freight To-Pay/i).first().waitFor({ state: 'visible' });
    await page.getByText(/Alt Spec Unreviewed/i).first().waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Base Ex-Tax' }).click();
    await page.getByRole('button', { name: 'Landed Cost' }).click();

    // 3. Review quote q2 (Vanguard) math mismatch -> fix -> verify
    await page.getByRole('button', { name: 'Extraction Review' }).click();
    await page.getByRole('button', { name: /Vanguard/i }).click();
    await page.getByText(/Arithmetic Verification Gate/i).waitFor({ state: 'visible' });

    const verifyBtn = page.getByRole('button', { name: 'Mark Quote Verified' });
    assert.equal(await verifyBtn.isDisabled(), true, 'Verify button must remain disabled during math mismatch');

    await page.getByRole('button', { name: 'Accept 9200' }).click();
    await verifyBtn.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const target = buttons.find((b) => b.textContent?.includes('Mark Quote Verified'));
      return Boolean(target && !target.hasAttribute('disabled'));
    });

    await verifyBtn.click();
    await page.getByRole('button', { name: /Verified — Open Matrix/i }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /Verified — Open Matrix/i }).click();

    // 4. Recommend L1 award -> submit -> verify quote immutability lock -> withdraw
    await page.getByRole('button', { name: 'Recommend Award' }).click();
    await page.getByRole('button', { name: 'Submit Award for Approval' }).click();
    await page.getByRole('button', { name: 'Withdraw Pending Recommendation' }).waitFor({ state: 'visible' });

    // Confirm quote referenced by pending award is locked in Extraction Review
    await page.getByRole('button', { name: 'Extraction Review' }).click();
    await page.getByRole('button', { name: /Northstar/i }).click();
    await page.getByText(/This quotation is locked because it is referenced by a pending or approved award decision/i).waitFor({
      state: 'visible',
    });

    // Return to Approval & Export and withdraw pending recommendation
    await page.getByRole('button', { name: 'Approval & Export' }).click();
    await page.getByRole('button', { name: 'Withdraw Pending Recommendation' }).click();
    await page.getByRole('button', { name: 'Submit Award for Approval' }).waitFor({ state: 'visible' });

    // 5. Resubmit -> Return for Revision (Reject) -> Revise & Resubmit -> Approve
    await page.getByRole('button', { name: 'Submit Award for Approval' }).click();
    await page
      .getByPlaceholder(/Optional approval instructions/i)
      .fill('Verify delivery terms before final PO release.');
    await page.getByRole('button', { name: 'Return for Revision' }).click();
    await page.getByText('REJECTED — HISTORICAL SNAPSHOT').waitFor({ state: 'visible' });

    await page.getByRole('button', { name: 'Revise & Resubmit Recommendation' }).click();
    await page.getByRole('button', { name: 'Submit Award for Approval' }).click();
    await page
      .getByPlaceholder(/Optional approval instructions/i)
      .fill('Approved via Playwright browser E2E.');
    await page.getByRole('button', { name: 'Approve Award & Update Price Memory' }).click();
    await page.getByText('APPROVED', { exact: true }).waitFor({ state: 'visible' });

    // 6. Export Comparative Statement PDF & Excel and validate downloaded files
    const [pdfDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download Landscape A4 CS PDF' }).click(),
    ]);
    const pdfPath = path.join(downloadDir, pdfDownload.suggestedFilename());
    await pdfDownload.saveAs(pdfPath);
    const pdfBytes = fs.readFileSync(pdfPath);
    assert.ok(pdfBytes.length > 500, 'Downloaded CS PDF must be non-empty');
    assert.equal(pdfBytes.subarray(0, 5).toString('ascii'), '%PDF-', 'CS PDF must have %PDF- signature');

    const [xlsxDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download Multi-Sheet CS Excel (with Formulas)' }).click(),
    ]);
    const xlsxPath = path.join(downloadDir, xlsxDownload.suggestedFilename());
    await xlsxDownload.saveAs(xlsxPath);
    const xlsxBytes = fs.readFileSync(xlsxPath);
    assert.ok(xlsxBytes.length > 500, 'Downloaded CS Excel must be non-empty');
    assert.equal(xlsxBytes.subarray(0, 2).toString('ascii'), 'PK', 'CS Excel must have PK ZIP signature');

    // Assert zero runtime browser errors or console errors
    assert.deepEqual(pageErrors, [], `Unexpected pageerror events: ${pageErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `Unexpected console.error messages: ${consoleErrors.join(' | ')}`);

    console.log('BROWSER_E2E_PASSED', {
      baseUrl: BASE_URL,
      pdfFilename: pdfDownload.suggestedFilename(),
      pdfBytes: pdfBytes.length,
      xlsxFilename: xlsxDownload.suggestedFilename(),
      xlsxBytes: xlsxBytes.length,
    });
  } finally {
    await browser.close();
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

runBrowserE2E().catch((err) => {
  console.error('BROWSER_E2E_FAILED:', err);
  process.exit(1);
});
