import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { pathToFileURL } from 'url';
import { createServer as createViteServer } from 'vite';
import { loadWorkspace, mutateWorkspace } from './server/db.ts';
import { validateUploadedFile } from './server/fileSecurity.ts';
import {
  ExtractionServiceError,
  extractQuotationWithGemini,
  GenerateContentFn,
} from './server/geminiExtractor.ts';
import { recomputeQuotation } from './server/normalization.ts';
import { createSampleRfqAndQuotes } from './server/seedData.ts';
import { rankQuotations } from './src/lib/ranking.ts';
import {
  AuditLogEntry,
  AwardAllocation,
  AwardDecision,
  CatalogItem,
  Quotation,
  Rfq,
  Supplier,
  UserRole,
} from './src/types.ts';

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
  if (state.auditLogs.length > 300) {
    state.auditLogs = state.auditLogs.slice(0, 300);
  }
}

function nextSequentialRfqNumber(rfqs: Rfq[]): string {
  const year = new Date().getFullYear();
  let maxSeq = 42;
  for (const r of rfqs) {
    const m = r.rfqNumber.match(/^RFQ-\d{4}-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxSeq && n < 9000) {
        maxSeq = n;
      }
    }
  }
  return `RFQ-${year}-${String(maxSeq + 1).padStart(4, '0')}`;
}

function isNonNegativeFinite(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

function isPositiveFinite(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0;
}

const VALID_ROLES = new Set<UserRole>(['admin', 'buyer', 'approver', 'viewer']);
const VALID_CURRENCIES = new Set(['INR', 'USD', 'GBP', 'EUR']);
const VALID_TAX_REGIMES = new Set(['INDIA_GST', 'UK_VAT', 'US_TAX', 'NONE']);

export interface AppOptions {
  enableVite?: boolean;
  generateContentOverride?: GenerateContentFn;
}

export async function createApp(options: AppOptions = {}) {
  const { enableVite = false, generateContentOverride } = options;
  const app = express();

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  app.get('/api/health', (_req, res) => {
    try {
      const state = loadWorkspace();
      res.json({
        status: 'ok',
        rfqs: state.rfqs.length,
        quotations: state.quotations.length,
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        error: err instanceof Error ? err.message : 'Database unavailable',
      });
    }
  });

  app.get('/api/workspace', (_req, res, next) => {
    try {
      const state = loadWorkspace();
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  // Explicit Demo Sandbox Persona Switcher (NOT production authentication)
  app.post('/api/demo/switch-persona', async (req, res, next) => {
    try {
      const { activeUserRole, activeUserName, activeUserTitle } = req.body || {};
      if (!VALID_ROLES.has(activeUserRole)) {
        return res.status(400).json({ error: 'Invalid role specified.' });
      }
      const updated = await mutateWorkspace((state) => {
        state.settings.activeUserRole = activeUserRole;
        if (typeof activeUserName === 'string' && activeUserName.trim()) {
          state.settings.activeUserName = activeUserName.trim().slice(0, 80);
        }
        if (typeof activeUserTitle === 'string' && activeUserTitle.trim()) {
          state.settings.activeUserTitle = activeUserTitle.trim().slice(0, 80);
        }
        addAudit(state, {
          entityType: 'settings',
          entityId: state.settings.id,
          action: 'DEMO_PERSONA_SWITCHED',
          detail: `Switched demo workspace persona to ${state.settings.activeUserName} (${state.settings.activeUserRole}).`,
        });
        return state.settings;
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // Update organization settings (blocked for viewer)
  app.patch('/api/settings', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return { status: 403 as const, body: { error: 'Viewers cannot modify organization settings.' } };
        }
        const { name, defaultCurrency, taxRegime, defaultTaxCreditable, activeUserRole } =
          req.body || {};

        if (name !== undefined) {
          if (typeof name !== 'string' || !name.trim()) {
            return { status: 400 as const, body: { error: 'Organization name cannot be empty.' } };
          }
          state.settings.name = name.trim().slice(0, 120);
        }
        if (defaultCurrency !== undefined) {
          if (!VALID_CURRENCIES.has(defaultCurrency)) {
            return { status: 400 as const, body: { error: 'Unsupported currency.' } };
          }
          state.settings.defaultCurrency = defaultCurrency;
        }
        if (taxRegime !== undefined) {
          if (!VALID_TAX_REGIMES.has(taxRegime)) {
            return { status: 400 as const, body: { error: 'Unsupported tax regime.' } };
          }
          state.settings.taxRegime = taxRegime;
        }
        if (typeof defaultTaxCreditable === 'boolean') {
          state.settings.defaultTaxCreditable = defaultTaxCreditable;
        }
        if (activeUserRole !== undefined) {
          if (!VALID_ROLES.has(activeUserRole)) {
            return { status: 400 as const, body: { error: 'Invalid role.' } };
          }
          state.settings.activeUserRole = activeUserRole;
        }

        addAudit(state, {
          entityType: 'settings',
          entityId: state.settings.id,
          action: 'SETTINGS_UPDATED',
          detail: `Updated workspace settings (${state.settings.name} · ${state.settings.defaultCurrency} · ${state.settings.taxRegime}).`,
        });
        return { status: 200 as const, body: state.settings };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Load fresh sample manufacturing RFQ sandbox
  app.post('/api/rfqs/load-sample', async (_req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return { status: 403 as const, body: { error: 'Viewers cannot load sample RFQs.' } };
        }
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
        return { status: 201 as const, body: { rfq: sample.rfq, quotes: sample.quotes } };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Create RFQ
  app.post('/api/rfqs', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return { status: 403 as const, body: { error: 'Viewers cannot create RFQs.' } };
        }
        const { title, currency, incoterms, deliveryLocation, deadlineDate, items, invitedSupplierIds } =
          req.body || {};

        if (typeof title !== 'string' || !title.trim() || !Array.isArray(items) || items.length === 0) {
          return {
            status: 400 as const,
            body: { error: 'RFQ title and at least one line item are required.' },
          };
        }

        const safeCurrency = VALID_CURRENCIES.has(currency)
          ? currency
          : state.settings.defaultCurrency;

        for (const it of items) {
          if (!it || typeof it.description !== 'string' || !it.description.trim()) {
            return { status: 400 as const, body: { error: 'Every RFQ item needs a description.' } };
          }
          const q = Number(it.quantity);
          if (!Number.isFinite(q) || q <= 0) {
            return {
              status: 400 as const,
              body: { error: `Item "${it.description}" must have quantity > 0.` },
            };
          }
          if (it.targetUnitPrice !== null && it.targetUnitPrice !== undefined && it.targetUnitPrice !== '') {
            const tp = Number(it.targetUnitPrice);
            if (!Number.isFinite(tp) || tp < 0) {
              return { status: 400 as const, body: { error: 'Target unit price cannot be negative.' } };
            }
          }
        }

        const validSupplierSet = new Set(state.suppliers.map((s) => s.id));
        const safeSuppliers = Array.isArray(invitedSupplierIds)
          ? invitedSupplierIds.filter((id: unknown): id is string => typeof id === 'string' && validSupplierSet.has(id))
          : [];

        const rfqId = `rfq-${Date.now()}`;
        const rfqNumber = nextSequentialRfqNumber(state.rfqs);

        const newRfq: Rfq = {
          id: rfqId,
          rfqNumber,
          title: title.trim().slice(0, 200),
          status: 'collecting',
          currency: safeCurrency,
          incoterms: typeof incoterms === 'string' && incoterms.trim() ? incoterms.trim() : 'FOR Destination',
          deliveryLocation:
            typeof deliveryLocation === 'string' && deliveryLocation.trim()
              ? deliveryLocation.trim()
              : 'Main Manufacturing Plant',
          deadlineDate:
            typeof deadlineDate === 'string' && deadlineDate.trim()
              ? deadlineDate.trim()
              : new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          createdBy: state.settings.activeUserName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          invitedSupplierIds: safeSuppliers,
          items: items.map((it, idx: number) => {
            const sku = typeof it.skuCode === 'string' ? it.skuCode.trim() : '';
            const desc = String(it.description).trim();
            const matchedCatalog = state.items.find(
              (cat) =>
                (sku && cat.skuCode.toLowerCase() === sku.toLowerCase()) ||
                cat.normalizedName === desc.toLowerCase()
            );
            return {
              id: `${rfqId}-item-${idx + 1}`,
              rfqId,
              itemId: matchedCatalog?.id ?? null,
              lineNo: idx + 1,
              skuCode: sku,
              description: desc,
              quantity: Number(it.quantity),
              uom: typeof it.uom === 'string' && it.uom.trim() ? it.uom.trim() : 'pcs',
              targetUnitPrice:
                it.targetUnitPrice !== null && it.targetUnitPrice !== undefined && it.targetUnitPrice !== ''
                  ? Number(it.targetUnitPrice)
                  : matchedCatalog?.lastAwardedUnitPrice ?? null,
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
        return { status: 201 as const, body: newRfq };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Suppliers CRUD
  app.post('/api/suppliers', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return { status: 403 as const, body: { error: 'Viewers cannot modify suppliers.' } };
        }
        const { name, taxId, city, contactName, email, phoneWhatsapp, defaultPaymentTerms, categories } =
          req.body || {};
        if (typeof name !== 'string' || !name.trim()) {
          return { status: 400 as const, body: { error: 'Supplier name is required.' } };
        }
        const trimmedName = name.trim();
        const trimmedTaxId = typeof taxId === 'string' ? taxId.trim() : '';
        const duplicate = state.suppliers.find(
          (s) =>
            s.name.toLowerCase() === trimmedName.toLowerCase() ||
            (trimmedTaxId && s.taxId && s.taxId.toLowerCase() === trimmedTaxId.toLowerCase())
        );
        if (duplicate) {
          return {
            status: 409 as const,
            body: {
              error: `Duplicate supplier detected: "${duplicate.name}" matches this name or Tax ID/GSTIN.`,
            },
          };
        }

        const supplier: Supplier = {
          id: `sup-${Date.now()}`,
          name: trimmedName,
          taxId: trimmedTaxId,
          city: typeof city === 'string' ? city.trim() : '',
          contactName: typeof contactName === 'string' ? contactName.trim() : '',
          email: typeof email === 'string' ? email.trim() : '',
          phoneWhatsapp: typeof phoneWhatsapp === 'string' ? phoneWhatsapp.trim() : '',
          defaultPaymentTerms:
            typeof defaultPaymentTerms === 'string' && defaultPaymentTerms.trim()
              ? defaultPaymentTerms.trim()
              : 'Net 30 Days',
          categories: Array.isArray(categories)
            ? categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            : [],
          createdAt: new Date().toISOString(),
        };

        state.suppliers.unshift(supplier);
        addAudit(state, {
          entityType: 'supplier',
          entityId: supplier.id,
          action: 'SUPPLIER_CREATED',
          detail: `Added supplier ${supplier.name} (${supplier.taxId || 'No Tax ID'}).`,
        });
        return { status: 201 as const, body: supplier };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Items CRUD
  app.post('/api/items', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return { status: 403 as const, body: { error: 'Viewers cannot modify item catalog.' } };
        }
        const { skuCode, name, defaultUom, hsnSacCode } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) {
          return { status: 400 as const, body: { error: 'Item name is required.' } };
        }
        const newItem: CatalogItem = {
          id: `item-${Date.now()}`,
          skuCode: typeof skuCode === 'string' ? skuCode.trim() : '',
          name: name.trim(),
          normalizedName: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
          defaultUom: typeof defaultUom === 'string' && defaultUom.trim() ? defaultUom.trim() : 'pcs',
          hsnSacCode: typeof hsnSacCode === 'string' ? hsnSacCode.trim() : '',
          lastAwardedUnitPrice: null,
          lastAwardedCurrency: null,
          lastAwardedAt: null,
          lastSupplierId: null,
          priceHistory: [],
        };
        state.items.unshift(newItem);
        return { status: 201 as const, body: newItem };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // AI Quotation Extraction Endpoint
  app.post('/api/rfqs/:rfqId/quotes/extract', upload.single('file'), async (req, res, next) => {
    try {
      const snapshot = loadWorkspace();
      if (snapshot.settings.activeUserRole === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot upload quotations.' });
      }
      const rfq = snapshot.rfqs.find((r) => r.id === req.params.rfqId);
      if (!rfq) {
        return res.status(404).json({ error: 'RFQ not found.' });
      }
      const supplierId = req.body?.supplierId;
      if (typeof supplierId !== 'string' || !snapshot.suppliers.some((s) => s.id === supplierId)) {
        return res.status(400).json({ error: 'Valid supplierId is required.' });
      }

      const rawEmailText = typeof req.body?.rawEmailText === 'string' ? req.body.rawEmailText.trim() : '';
      const file = req.file;

      if (!file && !rawEmailText) {
        return res.status(400).json({
          error: 'Upload a quotation file (PDF, Excel, CSV, Image) or paste email text.',
        });
      }

      let safeName = `Email_Quote_${Date.now().toString().slice(-4)}.txt`;
      let safeMime = 'text/plain';
      if (file) {
        const validation = validateUploadedFile(file.buffer, file.originalname, file.mimetype);
        if (!validation.ok) {
          return res.status(validation.status).json({ error: validation.error });
        }
        safeName = validation.safeFilename;
        safeMime = validation.detectedMime;
      }

      const extracted = await extractQuotationWithGemini({
        rfq,
        supplierId,
        settings: snapshot.settings,
        documentName: safeName,
        mimeType: safeMime,
        fileBuffer: file?.buffer,
        rawEmailText: rawEmailText || undefined,
        generateContentOverride,
      });

      const saved = await mutateWorkspace((state) => {
        const targetRfq = state.rfqs.find((r) => r.id === req.params.rfqId);
        if (!targetRfq) {
          throw new ExtractionServiceError('RFQ was removed while extracting.', 404);
        }
        state.quotations.unshift(extracted);
        if (targetRfq.status === 'draft' || targetRfq.status === 'collecting') {
          targetRfq.status = 'in_review';
        }
        targetRfq.updatedAt = new Date().toISOString();

        const supName = state.suppliers.find((s) => s.id === supplierId)?.name || supplierId;
        addAudit(state, {
          entityType: 'quotation',
          entityId: extracted.id,
          action: 'QUOTATION_EXTRACTED',
          detail: `Extracted ${extracted.lines.length} lines from ${extracted.documentName} (${supName}) for ${targetRfq.rfqNumber}.`,
        });
        return extracted;
      });

      res.status(201).json(saved);
    } catch (err) {
      if (err instanceof ExtractionServiceError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  });

  // Edit Quotation Header Commercial Terms
  app.patch('/api/quotations/:quoteId', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return { status: 403 as const, body: { error: 'Viewers cannot edit quotations.' } };
        }
        const qIndex = state.quotations.findIndex((q) => q.id === req.params.quoteId);
        if (qIndex === -1) return { status: 404 as const, body: { error: 'Quotation not found.' } };
        const quote = state.quotations[qIndex];
        const rfq = state.rfqs.find((r) => r.id === quote.rfqId);
        if (!rfq) return { status: 404 as const, body: { error: 'Parent RFQ not found.' } };

        const body = req.body || {};
        for (const numField of ['freightCharges', 'packingForwarding', 'otherCharges', 'globalDiscount'] as const) {
          if (body[numField] !== undefined && !isNonNegativeFinite(body[numField])) {
            return { status: 400 as const, body: { error: `${numField} must be a non-negative finite number.` } };
          }
        }
        if (body.exchangeRateToRfq !== undefined && !isPositiveFinite(body.exchangeRateToRfq)) {
          return { status: 400 as const, body: { error: 'exchangeRateToRfq must be greater than 0.' } };
        }
        if (
          body.leadTimeDays !== undefined &&
          body.leadTimeDays !== null &&
          (!Number.isFinite(body.leadTimeDays) || body.leadTimeDays < 0)
        ) {
          return { status: 400 as const, body: { error: 'leadTimeDays cannot be negative.' } };
        }

        const updated: Quotation = { ...quote, isVerified: false };
        if (body.quoteReference !== undefined) updated.quoteReference = String(body.quoteReference).trim();
        if (body.leadTimeDays !== undefined) updated.leadTimeDays = body.leadTimeDays;
        if (body.paymentTerms !== undefined) updated.paymentTerms = body.paymentTerms;
        if (body.freightCharges !== undefined) updated.freightCharges = body.freightCharges;
        if (body.packingForwarding !== undefined) updated.packingForwarding = body.packingForwarding;
        if (body.otherCharges !== undefined) updated.otherCharges = body.otherCharges;
        if (body.globalDiscount !== undefined) updated.globalDiscount = body.globalDiscount;
        if (body.taxIncludedInRates !== undefined) updated.taxIncludedInRates = Boolean(body.taxIncludedInRates);
        if (body.missingFreightWarning !== undefined) updated.missingFreightWarning = Boolean(body.missingFreightWarning);
        if (body.exchangeRateToRfq !== undefined) updated.exchangeRateToRfq = body.exchangeRateToRfq;
        if (body.validUntil !== undefined) updated.validUntil = body.validUntil;

        const recomputed = recomputeQuotation(updated, rfq);
        state.quotations[qIndex] = recomputed;
        addAudit(state, {
          entityType: 'quotation',
          entityId: quote.id,
          action: 'QUOTATION_HEADER_EDITED',
          detail: `Updated commercial terms on ${quote.quoteReference} (Freight: ${recomputed.freightCharges}, P&F: ${recomputed.packingForwarding}, FX: ${recomputed.exchangeRateToRfq}).`,
        });
        return { status: 200 as const, body: recomputed };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Edit a specific Quotation Line Item
  app.patch('/api/quotations/:quoteId/lines/:lineId', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return { status: 403 as const, body: { error: 'Viewers cannot edit quotation lines.' } };
        }
        const qIndex = state.quotations.findIndex((q) => q.id === req.params.quoteId);
        if (qIndex === -1) return { status: 404 as const, body: { error: 'Quotation not found.' } };
        const quote = state.quotations[qIndex];
        const rfq = state.rfqs.find((r) => r.id === quote.rfqId);
        if (!rfq) return { status: 404 as const, body: { error: 'Parent RFQ not found.' } };

        const lineIndex = quote.lines.findIndex((l) => l.id === req.params.lineId);
        if (lineIndex === -1) return { status: 404 as const, body: { error: 'Quotation line not found.' } };

        const body = req.body || {};
        if (body.rfqItemId !== undefined && body.rfqItemId !== null) {
          if (!rfq.items.some((it) => it.id === body.rfqItemId)) {
            return { status: 400 as const, body: { error: 'rfqItemId does not belong to this RFQ.' } };
          }
        }
        if (body.quotedQty !== undefined && body.quotedQty !== null && !isPositiveFinite(body.quotedQty)) {
          return { status: 400 as const, body: { error: 'quotedQty must be greater than 0.' } };
        }
        if (body.quotedUnitRate !== undefined && body.quotedUnitRate !== null && !isNonNegativeFinite(body.quotedUnitRate)) {
          return { status: 400 as const, body: { error: 'quotedUnitRate cannot be negative.' } };
        }
        if (body.uomConversionFactor !== undefined && !isPositiveFinite(body.uomConversionFactor)) {
          return { status: 400 as const, body: { error: 'uomConversionFactor must be greater than 0.' } };
        }
        if (body.taxRatePct !== undefined && (!isNonNegativeFinite(body.taxRatePct) || body.taxRatePct > 100)) {
          return { status: 400 as const, body: { error: 'taxRatePct must be between 0 and 100.' } };
        }
        if (body.discountAmount !== undefined && !isNonNegativeFinite(body.discountAmount)) {
          return { status: 400 as const, body: { error: 'discountAmount cannot be negative.' } };
        }
        if (body.lineTotalQuoted !== undefined && body.lineTotalQuoted !== null && !isNonNegativeFinite(body.lineTotalQuoted)) {
          return { status: 400 as const, body: { error: 'lineTotalQuoted cannot be negative.' } };
        }

        const prevLine = quote.lines[lineIndex];
        const updatedLine = {
          ...prevLine,
          ...(body.rfqItemId !== undefined ? { rfqItemId: body.rfqItemId } : {}),
          ...(body.matchStatus !== undefined ? { matchStatus: body.matchStatus } : {}),
          ...(body.quotedQty !== undefined ? { quotedQty: body.quotedQty } : {}),
          ...(body.quotedUnitRate !== undefined ? { quotedUnitRate: body.quotedUnitRate } : {}),
          ...(body.uomConversionFactor !== undefined ? { uomConversionFactor: body.uomConversionFactor } : {}),
          ...(body.taxRatePct !== undefined ? { taxRatePct: body.taxRatePct } : {}),
          ...(body.taxCreditable !== undefined ? { taxCreditable: Boolean(body.taxCreditable) } : {}),
          ...(body.discountAmount !== undefined ? { discountAmount: body.discountAmount } : {}),
          ...(body.lineTotalQuoted !== undefined ? { lineTotalQuoted: body.lineTotalQuoted } : {}),
          humanEdited: true,
          verifiedField: body.verifiedField ?? true,
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

        return { status: 200 as const, body: recomputed };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Verify Quotation (Gate: blocks if mathValid === false)
  app.post('/api/quotations/:quoteId/verify', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return { status: 403 as const, body: { error: 'Viewers cannot verify quotations.' } };
        }
        const qIndex = state.quotations.findIndex((q) => q.id === req.params.quoteId);
        if (qIndex === -1) return { status: 404 as const, body: { error: 'Quotation not found.' } };
        const quote = state.quotations[qIndex];
        const rfq = state.rfqs.find((r) => r.id === quote.rfqId);
        if (!rfq) return { status: 404 as const, body: { error: 'Parent RFQ not found.' } };

        const recomputedPre = recomputeQuotation(quote, rfq);
        const unresolvedMath = recomputedPre.lines.filter((l) => !l.mathValid);
        if (unresolvedMath.length > 0) {
          return {
            status: 422 as const,
            body: {
              error: `Cannot verify quotation: ${unresolvedMath.length} line item(s) still have unresolved arithmetic mismatches.`,
            },
          };
        }

        const verifiedQuote = recomputeQuotation(
          {
            ...recomputedPre,
            isVerified: true,
            parseStatus: 'verified',
            verifiedBy: state.settings.activeUserName,
            verifiedAt: new Date().toISOString(),
            lines: recomputedPre.lines.map((l) => ({ ...l, verifiedField: true })),
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
        return { status: 200 as const, body: verifiedQuote };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Delete Quotation (referential integrity protected)
  app.delete('/api/quotations/:quoteId', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return { status: 403 as const, body: { error: 'Viewers cannot delete quotations.' } };
        }
        const idx = state.quotations.findIndex((q) => q.id === req.params.quoteId);
        if (idx === -1) return { status: 404 as const, body: { error: 'Quotation not found.' } };
        const target = state.quotations[idx];

        const linkedApprovedAward = state.awards.find(
          (a) =>
            a.approvalStatus === 'approved' &&
            a.allocations.some((al) => al.quotationId === target.id)
        );
        if (linkedApprovedAward) {
          return {
            status: 409 as const,
            body: {
              error: 'Cannot delete a quotation that is part of an approved award decision.',
            },
          };
        }

        state.quotations.splice(idx, 1);

        // Clean up any pending award referencing this deleted quotation
        const hadPending = state.awards.some(
          (a) =>
            a.approvalStatus === 'pending' &&
            a.allocations.some((al) => al.quotationId === target.id)
        );
        if (hadPending) {
          state.awards = state.awards.filter(
            (a) =>
              !(
                a.approvalStatus === 'pending' &&
                a.allocations.some((al) => al.quotationId === target.id)
              )
          );
          const parentRfq = state.rfqs.find((r) => r.id === target.rfqId);
          if (parentRfq && parentRfq.status === 'pending_approval') {
            parentRfq.status = 'in_review';
          }
        }

        addAudit(state, {
          entityType: 'quotation',
          entityId: target.id,
          action: 'QUOTATION_DELETED',
          detail: `Removed quotation ${target.quoteReference} (${target.documentName}).`,
        });
        return { status: 200 as const, body: { ok: true } };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Submit Award Recommendation (recomputes totals & validates referential integrity server-side)
  app.post('/api/rfqs/:rfqId/award', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole === 'viewer') {
          return {
            status: 403 as const,
            body: { error: 'Viewers cannot submit award recommendations.' },
          };
        }
        const rfq = state.rfqs.find((r) => r.id === req.params.rfqId);
        if (!rfq) return { status: 404 as const, body: { error: 'RFQ not found.' } };

        const { isSplitAward, nonL1Justification, allocations } = req.body || {};
        if (!Array.isArray(allocations) || allocations.length === 0) {
          return {
            status: 400 as const,
            body: { error: 'Award recommendation must include at least one item allocation.' },
          };
        }

        const rfqQuotes = state.quotations.filter((q) => q.rfqId === rfq.id);
        const verifiedAllocations: AwardAllocation[] = [];
        let computedTotalLanded = 0;

        for (const al of allocations) {
          const rfqItem = rfq.items.find((it) => it.id === al.rfqItemId);
          const quote = rfqQuotes.find((q) => q.id === al.quotationId);
          const line = quote?.lines.find((l) => l.id === al.quotationLineId);

          if (!rfqItem || !quote || !line || line.matchStatus === 'not_quoted') {
            return {
              status: 400 as const,
              body: { error: 'Invalid allocation reference to RFQ item or quotation line.' },
            };
          }
          if (!line.mathValid || line.normalizedUnitLanded === null) {
            return {
              status: 422 as const,
              body: {
                error: `Cannot include line "${line.rawDescription}" in an award while arithmetic mismatch or missing price remains.`,
              },
            };
          }

          const qty = rfqItem.quantity;
          const unitLanded = line.normalizedUnitLanded;
          computedTotalLanded += unitLanded * qty;
          verifiedAllocations.push({
            rfqItemId: rfqItem.id,
            quotationId: quote.id,
            quotationLineId: line.id,
            supplierId: quote.supplierId,
            awardedQty: qty,
            awardedUnitLanded: unitLanded,
          });
        }

        // For single-package awards, use the quote's authoritative totalLandedCost to avoid rounding drift
        const distinctQuoteIds = new Set(verifiedAllocations.map((a) => a.quotationId));
        if (!isSplitAward && distinctQuoteIds.size === 1) {
          const soleQuote = rfqQuotes.find((q) => q.id === [...distinctQuoteIds][0]);
          if (soleQuote && verifiedAllocations.length === rfq.items.length) {
            computedTotalLanded = soleQuote.totalLandedCost;
          }
        }
        computedTotalLanded = Math.round(computedTotalLanded * 100) / 100;

        // Server-side L1 check: compare against lowest complete/eligible L1 quote (or complete math-valid quote)
        const ranked = rankQuotations(rfqQuotes, 'landed');
        const l1Eligible = ranked.find((r) => r.rankIndex === 1);
        const isNonL1Server = l1Eligible
          ? computedTotalLanded > l1Eligible.totalForBasis + 1
          : false;

        if (isNonL1Server && (typeof nonL1Justification !== 'string' || !nonL1Justification.trim())) {
          return {
            status: 400 as const,
            body: {
              error: 'Justification is mandatory when awarding above the L1 lowest landed cost.',
            },
          };
        }

        const award: AwardDecision = {
          id: `award-${Date.now()}`,
          rfqId: rfq.id,
          isSplitAward: Boolean(isSplitAward),
          recommendedBy: state.settings.activeUserName,
          approvedBy: null,
          approvalStatus: 'pending',
          nonL1Justification:
            typeof nonL1Justification === 'string' && nonL1Justification.trim()
              ? nonL1Justification.trim()
              : null,
          approverNotes: null,
          totalAwardedLanded: computedTotalLanded,
          allocations: verifiedAllocations,
          decidedAt: null,
          createdAt: new Date().toISOString(),
        };

        state.awards = state.awards.filter(
          (a) => !(a.rfqId === rfq.id && a.approvalStatus === 'pending')
        );
        state.awards.unshift(award);
        rfq.status = 'pending_approval';
        rfq.updatedAt = new Date().toISOString();

        addAudit(state, {
          entityType: 'award',
          entityId: award.id,
          action: 'AWARD_RECOMMENDED',
          detail: `Submitted ${award.isSplitAward ? 'Split' : 'Full'} award recommendation for ${rfq.rfqNumber} (Landed total: ${award.totalAwardedLanded}).`,
        });

        return { status: 201 as const, body: award };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Approve or Reject Award
  app.post('/api/awards/:awardId/decide', async (req, res, next) => {
    try {
      const result = await mutateWorkspace((state) => {
        if (state.settings.activeUserRole !== 'approver' && state.settings.activeUserRole !== 'admin') {
          return {
            status: 403 as const,
            body: {
              error: 'Only Approver (MD) or Admin roles can approve or reject awards. Switch role in Settings or sidebar.',
            },
          };
        }

        const award = state.awards.find((a) => a.id === req.params.awardId);
        if (!award) return { status: 404 as const, body: { error: 'Award decision not found.' } };
        if (award.approvalStatus !== 'pending') {
          return { status: 409 as const, body: { error: 'This award decision has already been finalized.' } };
        }
        const rfq = state.rfqs.find((r) => r.id === award.rfqId);
        if (!rfq) return { status: 404 as const, body: { error: 'Parent RFQ not found.' } };

        const { decision, approverNotes } = req.body || {};
        if (decision !== 'approved' && decision !== 'rejected') {
          return { status: 400 as const, body: { error: 'Decision must be "approved" or "rejected".' } };
        }

        award.approvalStatus = decision;
        award.approvedBy = state.settings.activeUserName;
        award.approverNotes =
          typeof approverNotes === 'string' && approverNotes.trim() ? approverNotes.trim() : null;
        award.decidedAt = new Date().toISOString();

        if (decision === 'approved') {
          rfq.status = 'awarded';
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
          detail: `${decision === 'approved' ? 'Approved' : 'Returned for revision'} award for ${rfq.rfqNumber}. ${award.approverNotes || ''}`.trim(),
        });

        return { status: 200 as const, body: { award, rfq } };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  if (enableVite) {
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
  }

  // Centralized error handler (Multer limits + safe error output without secret/stack leakage)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Uploaded file exceeds the 25 MB limit.' });
      }
      return res.status(400).json({ error: `File upload error: ${err.message}` });
    }
    const status =
      err instanceof ExtractionServiceError ? err.statusCode : 500;
    const message =
      err instanceof Error ? err.message : 'Internal server error.';
    if (status >= 500) {
      console.error('[server error]', message);
    }
    res.status(status).json({ error: message });
  });

  return app;
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const PORT = Number(process.env.PORT) || 3000;
  createApp({ enableVite: true }).then((app) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`NORUS QUOTEFLOW server running on http://0.0.0.0:${PORT}`);
    });
  });
}
