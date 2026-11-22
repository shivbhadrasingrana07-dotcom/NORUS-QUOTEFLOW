import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { loadWorkspace, saveWorkspace } from './server/db.ts';
import { extractQuotationWithGemini } from './server/geminiExtractor.ts';
import { recomputeQuotation } from './server/normalization.ts';
import { createSampleRfqAndQuotes } from './server/seedData.ts';
import {
  AuditLogEntry,
  AwardDecision,
  CatalogItem,
  Quotation,
  Rfq,
  Supplier,
} from './src/types.ts';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '15mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function addAudit(
  state: ReturnType<typeof loadWorkspace>,
  entry: Omit<AuditLogEntry, 'id' | 'createdAt' | 'actorName' | 'actorRole'>
) {
  state.auditLogs.unshift({
    id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    actorName: state.settings.activeUserName,
    actorRole: state.settings.activeUserRole,
    createdAt: new Date().toISOString(),
    ...entry,
  });
  if (state.auditLogs.length > 200) {
    state.auditLogs = state.auditLogs.slice(0, 200);
  }
}

// Get full workspace state
app.get('/api/workspace', (_req, res) => {
  const state = loadWorkspace();
  res.json(state);
});

// Update organization / role settings
app.patch('/api/settings', (req, res) => {
  const state = loadWorkspace();
  state.settings = {
    ...state.settings,
    ...req.body,
  };
  addAudit(state, {
    entityType: 'settings',
    entityId: state.settings.id,
    action: 'SETTINGS_UPDATED',
    detail: `Updated workspace settings (Active user: ${state.settings.activeUserName} · ${state.settings.activeUserRole}).`,
  });
  saveWorkspace(state);
  res.json(state.settings);
});

// Load fresh sample manufacturing RFQ sandbox
app.post('/api/rfqs/load-sample', (_req, res) => {
  const state = loadWorkspace();
  const suffix = String(Date.now()).slice(-4);
  const sample = createSampleRfqAndQuotes(suffix);
  state.rfqs.unshift(sample.rfq);
  state.quotations.unshift(...sample.quotes);
  addAudit(state, {
    entityType: 'rfq',
    entityId: sample.rfq.id,
    action: 'SAMPLE_RFQ_LOADED',
    detail: `Loaded sample RFQ ${sample.rfq.rfqNumber} with 3 multi-format supplier quotes.`,
  });
  saveWorkspace(state);
  res.json({ rfq: sample.rfq, quotes: sample.quotes });
});

// Create RFQ
app.post('/api/rfqs', (req, res) => {
  const state = loadWorkspace();
  if (state.settings.activeUserRole === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot create RFQs.' });
  }
  const { title, currency, incoterms, deliveryLocation, deadlineDate, items, invitedSupplierIds } =
    req.body as {
      title: string;
      currency?: 'INR' | 'USD' | 'GBP' | 'EUR';
      incoterms?: string;
      deliveryLocation?: string;
      deadlineDate?: string;
      items: Array<{
        skuCode?: string;
        description: string;
        quantity: number;
        uom: string;
        targetUnitPrice?: number | null;
      }>;
      invitedSupplierIds?: string[];
    };

  if (!title || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'RFQ title and at least one line item are required.' });
  }

  const rfqId = `rfq-${Date.now()}`;
  const nextNum = String(43 + state.rfqs.length).padStart(4, '0');
  const rfqNumber = `RFQ-2026-${nextNum}`;

  const newRfq: Rfq = {
    id: rfqId,
    rfqNumber,
    title: title.trim(),
    status: 'collecting',
    currency: currency || state.settings.defaultCurrency,
    incoterms: incoterms || 'FOR Destination',
    deliveryLocation: deliveryLocation || 'Main Manufacturing Plant',
    deadlineDate: deadlineDate || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    createdBy: state.settings.activeUserName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    invitedSupplierIds: invitedSupplierIds || [],
    items: items.map((it, idx) => {
      const matchedCatalog = state.items.find(
        (cat) =>
          (it.skuCode && cat.skuCode.toLowerCase() === it.skuCode.toLowerCase()) ||
          cat.normalizedName === it.description.toLowerCase().trim()
      );
      return {
        id: `${rfqId}-item-${idx + 1}`,
        rfqId,
        itemId: matchedCatalog?.id ?? null,
        lineNo: idx + 1,
        skuCode: it.skuCode || '',
        description: it.description.trim(),
        quantity: Number(it.quantity) || 1,
        uom: it.uom || 'pcs',
        targetUnitPrice:
          it.targetUnitPrice ?? matchedCatalog?.lastAwardedUnitPrice ?? null,
      };
    }),
  };

  state.rfqs.unshift(newRfq);
  addAudit(state, {
    entityType: 'rfq',
    entityId: newRfq.id,
    action: 'RFQ_CREATED',
    detail: `Created ${newRfq.rfqNumber} (${newRfq.title}) with ${newRfq.items.length} line items.`,
  });
  saveWorkspace(state);
  res.status(201).json(newRfq);
});

// Suppliers CRUD
app.post('/api/suppliers', (req, res) => {
  const state = loadWorkspace();
  if (state.settings.activeUserRole === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot modify suppliers.' });
  }
  const { name, taxId, city, contactName, email, phoneWhatsapp, defaultPaymentTerms, categories } =
    req.body;
  if (!name?.trim()) {
    return res.status(400).json({ error: 'Supplier name is required.' });
  }
  const duplicate = state.suppliers.find(
    (s) =>
      s.name.toLowerCase() === name.trim().toLowerCase() ||
      (taxId && s.taxId && s.taxId.toLowerCase() === taxId.trim().toLowerCase())
  );
  if (duplicate) {
    return res.status(409).json({
      error: `Duplicate supplier detected: "${duplicate.name}" matches this name or Tax ID/GSTIN.`,
    });
  }

  const supplier: Supplier = {
    id: `sup-${Date.now()}`,
    name: name.trim(),
    taxId: (taxId || '').trim(),
    city: (city || '').trim(),
    contactName: (contactName || '').trim(),
    email: (email || '').trim(),
    phoneWhatsapp: (phoneWhatsapp || '').trim(),
    defaultPaymentTerms: (defaultPaymentTerms || 'Net 30 Days').trim(),
    categories: Array.isArray(categories) ? categories : [],
    createdAt: new Date().toISOString(),
  };

  state.suppliers.unshift(supplier);
  addAudit(state, {
    entityType: 'supplier',
    entityId: supplier.id,
    action: 'SUPPLIER_CREATED',
    detail: `Added supplier ${supplier.name} (${supplier.taxId || 'No Tax ID'}).`,
  });
  saveWorkspace(state);
  res.status(201).json(supplier);
});

// Items CRUD
app.post('/api/items', (req, res) => {
  const state = loadWorkspace();
  const { skuCode, name, defaultUom, hsnSacCode } = req.body;
  if (!name?.trim()) {
    return res.status(400).json({ error: 'Item name is required.' });
  }
  const newItem: CatalogItem = {
    id: `item-${Date.now()}`,
    skuCode: (skuCode || '').trim(),
    name: name.trim(),
    normalizedName: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' '),
    defaultUom: (defaultUom || 'pcs').trim(),
    hsnSacCode: (hsnSacCode || '').trim(),
    lastAwardedUnitPrice: null,
    lastAwardedCurrency: null,
    lastAwardedAt: null,
    lastSupplierId: null,
    priceHistory: [],
  };
  state.items.unshift(newItem);
  saveWorkspace(state);
  res.status(201).json(newItem);
});

// AI Quotation Extraction Endpoint (File upload OR pasted email text)
app.post('/api/rfqs/:rfqId/quotes/extract', upload.single('file'), async (req, res) => {
  try {
    const state = loadWorkspace();
    if (state.settings.activeUserRole === 'viewer') {
      return res.status(403).json({ error: 'Viewers cannot upload quotations.' });
    }
    const rfq = state.rfqs.find((r) => r.id === req.params.rfqId);
    if (!rfq) {
      return res.status(404).json({ error: 'RFQ not found.' });
    }
    const supplierId = req.body.supplierId;
    if (!supplierId || !state.suppliers.some((s) => s.id === supplierId)) {
      return res.status(400).json({ error: 'Valid supplierId is required.' });
    }

    const rawEmailText = typeof req.body.rawEmailText === 'string' ? req.body.rawEmailText.trim() : '';
    const file = req.file;

    if (!file && !rawEmailText) {
      return res.status(400).json({ error: 'Upload a quotation file (PDF, Excel, CSV, Image) or paste email text.' });
    }

    const extracted = await extractQuotationWithGemini({
      rfq,
      supplierId,
      settings: state.settings,
      documentName: file ? file.originalname : `Email_Quote_${Date.now().toString().slice(-4)}.txt`,
      mimeType: file ? file.mimetype : 'text/plain',
      fileBuffer: file?.buffer,
      rawEmailText: rawEmailText || undefined,
    });

    state.quotations.unshift(extracted);
    if (rfq.status === 'draft' || rfq.status === 'collecting') {
      rfq.status = 'in_review';
    }
    rfq.updatedAt = new Date().toISOString();

    const supName = state.suppliers.find((s) => s.id === supplierId)?.name || supplierId;
    addAudit(state, {
      entityType: 'quotation',
      entityId: extracted.id,
      action: 'QUOTATION_EXTRACTED',
      detail: `Extracted ${extracted.lines.length} lines from ${extracted.documentName} (${supName}) for ${rfq.rfqNumber}.`,
    });
    saveWorkspace(state);
    res.status(201).json(extracted);
  } catch (err) {
    console.error('Quotation extraction failed:', err);
    const message =
      err instanceof Error ? err.message : 'Failed to extract quotation with Gemini API.';
    res.status(500).json({ error: message });
  }
});

// Edit Quotation Header Commercial Terms
app.patch('/api/quotations/:quoteId', (req, res) => {
  const state = loadWorkspace();
  const qIndex = state.quotations.findIndex((q) => q.id === req.params.quoteId);
  if (qIndex === -1) return res.status(404).json({ error: 'Quotation not found.' });
  const quote = state.quotations[qIndex];
  const rfq = state.rfqs.find((r) => r.id === quote.rfqId);
  if (!rfq) return res.status(404).json({ error: 'Parent RFQ not found.' });

  const allowedFields = [
    'quoteReference',
    'leadTimeDays',
    'paymentTerms',
    'freightCharges',
    'packingForwarding',
    'otherCharges',
    'globalDiscount',
    'taxIncludedInRates',
    'missingFreightWarning',
    'exchangeRateToRfq',
    'validUntil',
  ] as const;

  const updated: Quotation = { ...quote, isVerified: false };
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      // @ts-expect-error dynamic field assignment on validated whitelist
      updated[field] = req.body[field];
    }
  }

  const recomputed = recomputeQuotation(updated, rfq);
  state.quotations[qIndex] = recomputed;
  addAudit(state, {
    entityType: 'quotation',
    entityId: quote.id,
    action: 'QUOTATION_HEADER_EDITED',
    detail: `Updated commercial terms on ${quote.quoteReference} (Freight: ${recomputed.freightCharges}, P&F: ${recomputed.packingForwarding}).`,
  });
  saveWorkspace(state);
  res.json(recomputed);
});

// Edit a specific Quotation Line Item
app.patch('/api/quotations/:quoteId/lines/:lineId', (req, res) => {
  const state = loadWorkspace();
  const qIndex = state.quotations.findIndex((q) => q.id === req.params.quoteId);
  if (qIndex === -1) return res.status(404).json({ error: 'Quotation not found.' });
  const quote = state.quotations[qIndex];
  const rfq = state.rfqs.find((r) => r.id === quote.rfqId);
  if (!rfq) return res.status(404).json({ error: 'Parent RFQ not found.' });

  const lineIndex = quote.lines.findIndex((l) => l.id === req.params.lineId);
  if (lineIndex === -1) return res.status(404).json({ error: 'Quotation line not found.' });

  const prevLine = quote.lines[lineIndex];
  const updatedLine = {
    ...prevLine,
    ...req.body,
    humanEdited: true,
    verifiedField: req.body.verifiedField ?? true,
  };

  const nextQuote: Quotation = {
    ...quote,
    isVerified: false,
    lines: quote.lines.map((l, idx) => (idx === lineIndex ? updatedLine : l)),
  };

  const recomputed = recomputeQuotation(nextQuote, rfq);
  state.quotations[qIndex] = recomputed;

  addAudit(state, {
    entityType: 'quotation_line',
    entityId: prevLine.id,
    action: 'LINE_HUMAN_OVERRIDE',
    detail: `Edited line "${prevLine.rawDescription}" on ${quote.quoteReference}: rate ${prevLine.quotedUnitRate} -> ${updatedLine.quotedUnitRate}, UOM factor ${prevLine.uomConversionFactor} -> ${updatedLine.uomConversionFactor}.`,
  });

  saveWorkspace(state);
  res.json(recomputed);
});

// Verify Quotation (Gate: blocks if math_valid === false)
app.post('/api/quotations/:quoteId/verify', (req, res) => {
  const state = loadWorkspace();
  const qIndex = state.quotations.findIndex((q) => q.id === req.params.quoteId);
  if (qIndex === -1) return res.status(404).json({ error: 'Quotation not found.' });
  const quote = state.quotations[qIndex];
  const rfq = state.rfqs.find((r) => r.id === quote.rfqId);
  if (!rfq) return res.status(404).json({ error: 'Parent RFQ not found.' });

  const unresolvedMath = quote.lines.filter((l) => !l.mathValid);
  if (unresolvedMath.length > 0) {
    return res.status(422).json({
      error: `Cannot verify quotation: ${unresolvedMath.length} line item(s) still have unresolved arithmetic mismatches.`,
    });
  }

  const verifiedQuote = recomputeQuotation(
    {
      ...quote,
      isVerified: true,
      parseStatus: 'verified',
      verifiedBy: state.settings.activeUserName,
      verifiedAt: new Date().toISOString(),
      lines: quote.lines.map((l) => ({ ...l, verifiedField: true })),
    },
    rfq
  );

  state.quotations[qIndex] = verifiedQuote;
  addAudit(state, {
    entityType: 'quotation',
    entityId: verifiedQuote.id,
    action: 'QUOTATION_VERIFIED',
    detail: `Verified ${verifiedQuote.quoteReference} (${verifiedQuote.documentName}) for ${rfq.rfqNumber}.`,
  });
  saveWorkspace(state);
  res.json(verifiedQuote);
});

// Delete Quotation
app.delete('/api/quotations/:quoteId', (req, res) => {
  const state = loadWorkspace();
  const idx = state.quotations.findIndex((q) => q.id === req.params.quoteId);
  if (idx === -1) return res.status(404).json({ error: 'Quotation not found.' });
  const [removed] = state.quotations.splice(idx, 1);
  addAudit(state, {
    entityType: 'quotation',
    entityId: removed.id,
    action: 'QUOTATION_DELETED',
    detail: `Removed quotation ${removed.quoteReference} (${removed.documentName}).`,
  });
  saveWorkspace(state);
  res.json({ ok: true });
});

// Submit Award Recommendation
app.post('/api/rfqs/:rfqId/award', (req, res) => {
  const state = loadWorkspace();
  if (state.settings.activeUserRole === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot submit award recommendations.' });
  }
  const rfq = state.rfqs.find((r) => r.id === req.params.rfqId);
  if (!rfq) return res.status(404).json({ error: 'RFQ not found.' });

  const { isSplitAward, nonL1Justification, totalAwardedLanded, allocations, isNonL1 } = req.body;
  if (isNonL1 && (!nonL1Justification || !nonL1Justification.trim())) {
    return res.status(400).json({
      error: 'Justification is mandatory when awarding above the L1 lowest landed cost.',
    });
  }

  const award: AwardDecision = {
    id: `award-${Date.now()}`,
    rfqId: rfq.id,
    isSplitAward: Boolean(isSplitAward),
    recommendedBy: state.settings.activeUserName,
    approvedBy: null,
    approvalStatus: 'pending',
    nonL1Justification: nonL1Justification?.trim() || null,
    approverNotes: null,
    totalAwardedLanded: Number(totalAwardedLanded) || 0,
    allocations: allocations || [],
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };

  // Replace any prior pending award for this RFQ
  state.awards = state.awards.filter((a) => !(a.rfqId === rfq.id && a.approvalStatus === 'pending'));
  state.awards.unshift(award);
  rfq.status = 'pending_approval';
  rfq.updatedAt = new Date().toISOString();

  addAudit(state, {
    entityType: 'award',
    entityId: award.id,
    action: 'AWARD_RECOMMENDED',
    detail: `Submitted ${award.isSplitAward ? 'Split' : 'Full'} award recommendation for ${rfq.rfqNumber} (Landed total: ${award.totalAwardedLanded}).`,
  });

  saveWorkspace(state);
  res.status(201).json(award);
});

// Approve or Reject Award (updates Historical Price Memory on Approval)
app.post('/api/awards/:awardId/decide', (req, res) => {
  const state = loadWorkspace();
  if (state.settings.activeUserRole !== 'approver' && state.settings.activeUserRole !== 'admin') {
    return res.status(403).json({
      error: 'Only Approver (MD) or Admin roles can approve or reject awards. Switch role in Settings or header.',
    });
  }

  const award = state.awards.find((a) => a.id === req.params.awardId);
  if (!award) return res.status(404).json({ error: 'Award decision not found.' });
  const rfq = state.rfqs.find((r) => r.id === award.rfqId);
  if (!rfq) return res.status(404).json({ error: 'Parent RFQ not found.' });

  const { decision, approverNotes } = req.body as {
    decision: 'approved' | 'rejected';
    approverNotes?: string;
  };

  award.approvalStatus = decision;
  award.approvedBy = state.settings.activeUserName;
  award.approverNotes = approverNotes?.trim() || null;
  award.decidedAt = new Date().toISOString();

  if (decision === 'approved') {
    rfq.status = 'awarded';
    // Update Item Master Historical Price Memory
    for (const alloc of award.allocations) {
      const rfqItem = rfq.items.find((it) => it.id === alloc.rfqItemId);
      if (!rfqItem) continue;
      const supplier = state.suppliers.find((s) => s.id === alloc.supplierId);
      let catalogItem = state.items.find(
        (ci) =>
          ci.id === rfqItem.itemId ||
          (rfqItem.skuCode && ci.skuCode.toLowerCase() === rfqItem.skuCode.toLowerCase()) ||
          ci.normalizedName === rfqItem.description.toLowerCase().trim()
      );
      if (!catalogItem) {
        catalogItem = {
          id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          skuCode: rfqItem.skuCode || `SKU-${rfqItem.lineNo}`,
          name: rfqItem.description,
          normalizedName: rfqItem.description.toLowerCase().trim(),
          defaultUom: rfqItem.uom,
          hsnSacCode: '',
          lastAwardedUnitPrice: null,
          lastAwardedCurrency: null,
          lastAwardedAt: null,
          lastSupplierId: null,
          priceHistory: [],
        };
        state.items.unshift(catalogItem);
        rfqItem.itemId = catalogItem.id;
      }

      catalogItem.lastAwardedUnitPrice = alloc.awardedUnitLanded;
      catalogItem.lastAwardedCurrency = rfq.currency;
      catalogItem.lastAwardedAt = award.decidedAt;
      catalogItem.lastSupplierId = alloc.supplierId;
      catalogItem.priceHistory.unshift({
        rfqId: rfq.id,
        rfqNumber: rfq.rfqNumber,
        supplierId: alloc.supplierId,
        supplierName: supplier?.name || 'Supplier',
        unitLandedPrice: alloc.awardedUnitLanded,
        currency: rfq.currency,
        awardedAt: award.decidedAt,
      });
    }
  } else {
    rfq.status = 'in_review';
  }
  rfq.updatedAt = new Date().toISOString();

  addAudit(state, {
    entityType: 'award',
    entityId: award.id,
    action: decision === 'approved' ? 'AWARD_APPROVED' : 'AWARD_REJECTED',
    detail: `${decision === 'approved' ? 'Approved' : 'Returned for revision'} award for ${rfq.rfqNumber}. ${approverNotes || ''}`.trim(),
  });

  saveWorkspace(state);
  res.json({ award, rfq });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NORUS QUOTEFLOW server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
