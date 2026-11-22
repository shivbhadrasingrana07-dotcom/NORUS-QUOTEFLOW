import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../src/db/index.ts';
import {
  auditLogs,
  awardAllocations,
  awards,
  catalogItems,
  organizationMemberships,
  organizations,
  priceHistory,
  quotationLines,
  quotations,
  rfqItems,
  rfqs,
  storedDocuments,
  suppliers,
  users,
} from '../src/db/schema.ts';
import type { WorkspaceState } from '../src/types.ts';
import { buildDocumentStorageKey, type ObjectStorageProvider } from './objectStorage.ts';
import { slugifyOrgName } from './security.ts';

export interface MigrationCounts {
  suppliers: number;
  catalogItems: number;
  priceHistory: number;
  rfqs: number;
  rfqItems: number;
  quotations: number;
  quotationLines: number;
  awards: number;
  awardAllocations: number;
  auditLogs: number;
  inlineDocumentsExtracted: number;
}

export interface MigrationReport {
  dryRun: boolean;
  sourcePath: string;
  backupPath: string | null;
  organizationId: string;
  organizationName: string;
  sourceCounts: MigrationCounts;
  targetCountsAfter: MigrationCounts | null;
  integrityVerified: boolean;
  warnings: string[];
}

function validateWorkspaceJson(raw: unknown): WorkspaceState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Legacy JSON file does not contain a valid WorkspaceState object.');
  }
  const obj = raw as Partial<WorkspaceState>;
  if (!obj.settings || typeof obj.settings.name !== 'string') {
    throw new Error('Legacy JSON is missing valid settings.');
  }
  for (const key of ['suppliers', 'items', 'rfqs', 'quotations', 'awards', 'auditLogs'] as const) {
    if (!Array.isArray(obj[key])) {
      throw new Error(`Legacy JSON is missing required array "${key}".`);
    }
  }
  return obj as WorkspaceState;
}

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return {
    mimeType: m[1],
    buffer: Buffer.from(m[2], 'base64'),
  };
}

export function computeSourceCounts(state: WorkspaceState): MigrationCounts {
  return {
    suppliers: state.suppliers.length,
    catalogItems: state.items.length,
    priceHistory: state.items.reduce((sum, it) => sum + (it.priceHistory?.length || 0), 0),
    rfqs: state.rfqs.length,
    rfqItems: state.rfqs.reduce((sum, r) => sum + (r.items?.length || 0), 0),
    quotations: state.quotations.length,
    quotationLines: state.quotations.reduce((sum, q) => sum + (q.lines?.length || 0), 0),
    awards: state.awards.length,
    awardAllocations: state.awards.reduce((sum, a) => sum + (a.allocations?.length || 0), 0),
    auditLogs: state.auditLogs.length,
    inlineDocumentsExtracted: state.quotations.filter((q) => Boolean(q.fileDataUrl)).length,
  };
}

export async function migrateLegacyJsonToPostgres(params: {
  db: DrizzleDb;
  storageProvider: ObjectStorageProvider;
  jsonPath?: string;
  backupDir?: string;
  dryRun?: boolean;
  organizationIdOverride?: string;
  ownerEmail?: string;
}): Promise<MigrationReport> {
  const jsonPath = path.resolve(
    params.jsonPath ||
      process.env.QUOTEFLOW_DB_PATH ||
      path.join(process.cwd(), 'data', 'quoteflow-db.json')
  );

  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Legacy JSON file not found at ${jsonPath}`);
  }

  const rawText = await fs.promises.readFile(jsonPath, 'utf-8');
  const parsed = JSON.parse(rawText);
  const state = validateWorkspaceJson(parsed);

  const orgId = params.organizationIdOverride || state.settings.id || 'org-kalyani-hydraulics';
  const sourceCounts = computeSourceCounts(state);
  const warnings: string[] = [];

  if (params.dryRun) {
    return {
      dryRun: true,
      sourcePath: jsonPath,
      backupPath: null,
      organizationId: orgId,
      organizationName: state.settings.name,
      sourceCounts,
      targetCountsAfter: null,
      integrityVerified: true,
      warnings,
    };
  }

  // Create pre-migration backup without touching/deleting original JSON
  const backupDir = path.resolve(
    params.backupDir || path.join(path.dirname(jsonPath), 'backups')
  );
  await fs.promises.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `quoteflow-db.pre-migration.${stamp}.json`);
  await fs.promises.copyFile(jsonPath, backupPath);

  // Extract any inline Base64 attachments to private object storage before DB transaction
  const uploadedDocsByQuoteId = new Map<
    string,
    {
      id: string;
      storageKey: string;
      mimeType: string;
      byteSize: number;
      sha256: string;
      originalFilename: string;
    }
  >();

  for (const q of state.quotations) {
    if (!q.fileDataUrl) continue;
    const decoded = parseDataUrl(q.fileDataUrl);
    if (!decoded) {
      warnings.push(`Quotation ${q.id} had unparseable fileDataUrl; skipped attachment extraction.`);
      continue;
    }
    const docId = `doc-mig-${q.id}`;
    const storageKey = buildDocumentStorageKey(orgId, docId, q.documentName);
    await params.storageProvider.putObject({
      key: storageKey,
      buffer: decoded.buffer,
      contentType: decoded.mimeType,
    });
    const sha256 = crypto.createHash('sha256').update(decoded.buffer).digest('hex');
    uploadedDocsByQuoteId.set(q.id, {
      id: docId,
      storageKey,
      mimeType: decoded.mimeType,
      byteSize: decoded.buffer.byteLength,
      sha256,
      originalFilename: q.documentName,
    });
  }

  await params.db.transaction(async (tx) => {
    const [existingOrg] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!existingOrg) {
      await tx
        .insert(organizations)
        .values({
          id: orgId,
          slug: slugifyOrgName(state.settings.name),
          name: state.settings.name,
          countryCode: state.settings.countryCode || 'IN',
          defaultCurrency: state.settings.defaultCurrency || 'INR',
          taxRegime: state.settings.taxRegime || 'INDIA_GST',
          defaultTaxCreditable: state.settings.defaultTaxCreditable ?? true,
          uomAliases: state.settings.uomAliases || {},
        })
        .onConflictDoNothing();
    }

    if (params.ownerEmail) {
      const email = params.ownerEmail.trim().toLowerCase();
      const [ownerUser] = await tx
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (ownerUser) {
        await tx
          .insert(organizationMemberships)
          .values({
            id: `mem-mig-${ownerUser.id.slice(-8)}-${orgId.slice(-6)}`,
            organizationId: orgId,
            userId: ownerUser.id,
            role: 'owner',
            status: 'active',
          })
          .onConflictDoNothing();
      } else {
        warnings.push(`Requested ownerEmail "${email}" was not found in users table.`);
      }
    }

    const validSupplierIds = new Set(state.suppliers.map((s) => s.id));
    for (const s of state.suppliers) {
      await tx
        .insert(suppliers)
        .values({
          id: s.id,
          organizationId: orgId,
          name: s.name,
          taxId: s.taxId || '',
          city: s.city || '',
          contactName: s.contactName || '',
          email: s.email || '',
          phoneWhatsapp: s.phoneWhatsapp || '',
          defaultPaymentTerms: s.defaultPaymentTerms || 'Net 30 Days',
          categories: s.categories || [],
          createdAt: s.createdAt || new Date().toISOString(),
        })
        .onConflictDoNothing();
    }

    const validCatalogIds = new Set(state.items.map((it) => it.id));
    for (const it of state.items) {
      await tx
        .insert(catalogItems)
        .values({
          id: it.id,
          organizationId: orgId,
          skuCode: it.skuCode || '',
          name: it.name,
          normalizedName: it.normalizedName || it.name.toLowerCase(),
          defaultUom: it.defaultUom || 'pcs',
          hsnSacCode: it.hsnSacCode || '',
          lastAwardedUnitPrice: it.lastAwardedUnitPrice,
          lastAwardedCurrency: it.lastAwardedCurrency,
          lastAwardedAt: it.lastAwardedAt,
          lastSupplierId:
            it.lastSupplierId && validSupplierIds.has(it.lastSupplierId)
              ? it.lastSupplierId
              : null,
        })
        .onConflictDoNothing();

      for (let hIdx = 0; hIdx < (it.priceHistory || []).length; hIdx += 1) {
        const h = it.priceHistory[hIdx];
        await tx
          .insert(priceHistory)
          .values({
            id: `ph-mig-${it.id}-${hIdx + 1}`,
            organizationId: orgId,
            catalogItemId: it.id,
            rfqId: h.rfqId,
            rfqNumber: h.rfqNumber,
            supplierId: h.supplierId,
            supplierName: h.supplierName,
            unitLandedPrice: h.unitLandedPrice,
            currency: h.currency,
            awardedAt: h.awardedAt,
          })
          .onConflictDoNothing();
      }
    }

    const validRfqItemIds = new Set<string>();
    for (const r of state.rfqs) {
      await tx
        .insert(rfqs)
        .values({
          id: r.id,
          organizationId: orgId,
          rfqNumber: r.rfqNumber,
          title: r.title,
          status: r.status,
          currency: r.currency,
          incoterms: r.incoterms,
          deliveryLocation: r.deliveryLocation,
          deadlineDate: r.deadlineDate,
          createdBy: r.createdBy,
          createdByUserId: null,
          invitedSupplierIds: r.invitedSupplierIds || [],
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })
        .onConflictDoNothing();

      for (const it of r.items) {
        validRfqItemIds.add(it.id);
        await tx
          .insert(rfqItems)
          .values({
            id: it.id,
            organizationId: orgId,
            rfqId: r.id,
            itemId: it.itemId && validCatalogIds.has(it.itemId) ? it.itemId : null,
            lineNo: it.lineNo,
            skuCode: it.skuCode || '',
            description: it.description,
            quantity: it.quantity,
            uom: it.uom || 'pcs',
            targetUnitPrice: it.targetUnitPrice,
          })
          .onConflictDoNothing();
      }
    }

    const validQuotationIds = new Set<string>();
    const validQuotationLineIds = new Set<string>();
    for (const q of state.quotations) {
      validQuotationIds.add(q.id);
      const uploaded = uploadedDocsByQuoteId.get(q.id);
      if (uploaded) {
        await tx
          .insert(storedDocuments)
          .values({
            id: uploaded.id,
            organizationId: orgId,
            uploadedByUserId: null,
            storageProvider: params.storageProvider.mode,
            storageKey: uploaded.storageKey,
            originalFilename: uploaded.originalFilename,
            mimeType: uploaded.mimeType,
            byteSize: uploaded.byteSize,
            sha256: uploaded.sha256,
            createdAt: q.createdAt || new Date().toISOString(),
          })
          .onConflictDoNothing();
      }

      await tx
        .insert(quotations)
        .values({
          id: q.id,
          organizationId: orgId,
          rfqId: q.rfqId,
          supplierId: q.supplierId,
          documentId: uploaded?.id ?? null,
          documentName: q.documentName,
          documentKind: q.documentKind,
          mimeType: q.mimeType,
          rawEmailText: q.rawEmailText ?? null,
          sheetPreview: q.sheetPreview ?? null,
          parseStatus: q.parseStatus,
          quoteReference: q.quoteReference,
          quoteDate: q.quoteDate,
          validUntil: q.validUntil,
          currency: q.currency,
          exchangeRateToRfq: q.exchangeRateToRfq,
          leadTimeDays: q.leadTimeDays,
          paymentTerms: q.paymentTerms,
          freightCharges: q.freightCharges,
          packingForwarding: q.packingForwarding,
          otherCharges: q.otherCharges,
          globalDiscount: q.globalDiscount,
          taxIncludedInRates: q.taxIncludedInRates,
          missingFreightWarning: q.missingFreightWarning,
          subtotalBase: q.subtotalBase,
          totalTax: q.totalTax,
          totalLandedCost: q.totalLandedCost,
          totalGrossPayable: q.totalGrossPayable,
          completenessRatio: q.completenessRatio,
          isVerified: q.isVerified,
          verifiedBy: q.verifiedBy,
          verifiedAt: q.verifiedAt,
          headerTraces: q.headerTraces || {},
          createdAt: q.createdAt,
        })
        .onConflictDoNothing();

      for (const l of q.lines) {
        validQuotationLineIds.add(l.id);
        await tx
          .insert(quotationLines)
          .values({
            id: l.id,
            organizationId: orgId,
            quotationId: q.id,
            rfqItemId: l.rfqItemId && validRfqItemIds.has(l.rfqItemId) ? l.rfqItemId : null,
            vendorLineNo: l.vendorLineNo,
            rawDescription: l.rawDescription,
            quotedQty: l.quotedQty,
            quotedUom: l.quotedUom,
            uomConversionFactor: l.uomConversionFactor,
            quotedUnitRate: l.quotedUnitRate,
            discountAmount: l.discountAmount,
            taxRatePct: l.taxRatePct,
            taxCreditable: l.taxCreditable,
            allocatedOverhead: l.allocatedOverhead,
            normalizedUnitBase: l.normalizedUnitBase,
            normalizedUnitLanded: l.normalizedUnitLanded,
            normalizedUnitGross: l.normalizedUnitGross,
            lineTotalQuoted: l.lineTotalQuoted,
            expectedLineTotal: l.expectedLineTotal,
            mathValid: l.mathValid,
            mathErrorDetail: l.mathErrorDetail,
            matchStatus: l.matchStatus,
            confidenceScore: l.confidenceScore,
            humanEdited: l.humanEdited,
            verifiedField: l.verifiedField,
            sourceTrace: l.sourceTrace,
          })
          .onConflictDoNothing();
      }
    }

    for (const a of state.awards) {
      await tx
        .insert(awards)
        .values({
          id: a.id,
          organizationId: orgId,
          rfqId: a.rfqId,
          isSplitAward: a.isSplitAward,
          recommendedBy: a.recommendedBy,
          recommendedByUserId: null,
          approvedBy: a.approvedBy,
          approvedByUserId: null,
          approvalStatus: a.approvalStatus,
          nonL1Justification: a.nonL1Justification,
          approverNotes: a.approverNotes,
          totalAwardedLanded: a.totalAwardedLanded,
          decidedAt: a.decidedAt,
          createdAt: a.createdAt,
        })
        .onConflictDoNothing();

      for (let alIdx = 0; alIdx < a.allocations.length; alIdx += 1) {
        const al = a.allocations[alIdx];
        if (
          !validRfqItemIds.has(al.rfqItemId) ||
          !validQuotationIds.has(al.quotationId) ||
          !validQuotationLineIds.has(al.quotationLineId)
        ) {
          warnings.push(`Skipped dangling award allocation on ${a.id} for item ${al.rfqItemId}`);
          continue;
        }
        await tx
          .insert(awardAllocations)
          .values({
            id: `al-mig-${a.id}-${alIdx + 1}`,
            organizationId: orgId,
            awardId: a.id,
            rfqItemId: al.rfqItemId,
            quotationId: al.quotationId,
            quotationLineId: al.quotationLineId,
            supplierId: al.supplierId,
            awardedQty: al.awardedQty,
            awardedUnitLanded: al.awardedUnitLanded,
          })
          .onConflictDoNothing();
      }
    }

    for (const log of state.auditLogs) {
      await tx
        .insert(auditLogs)
        .values({
          id: log.id,
          organizationId: orgId,
          actorUserId: null,
          actorName: log.actorName,
          actorRole: log.actorRole,
          entityType: log.entityType,
          entityId: log.entityId,
          action: log.action,
          detail: log.detail,
          createdAt: log.createdAt,
        })
        .onConflictDoNothing();
    }
  });

  // Post-migration verification counts
  const [
    supRows,
    catRows,
    phRows,
    rfqRows,
    rfqItemRows,
    quoteRows,
    quoteLineRows,
    awardRows,
    allocRows,
    auditRows,
    docRows,
  ] = await Promise.all([
    params.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.organizationId, orgId)),
    params.db
      .select({ id: catalogItems.id })
      .from(catalogItems)
      .where(eq(catalogItems.organizationId, orgId)),
    params.db
      .select({ id: priceHistory.id })
      .from(priceHistory)
      .where(eq(priceHistory.organizationId, orgId)),
    params.db.select({ id: rfqs.id }).from(rfqs).where(eq(rfqs.organizationId, orgId)),
    params.db.select({ id: rfqItems.id }).from(rfqItems).where(eq(rfqItems.organizationId, orgId)),
    params.db
      .select({ id: quotations.id })
      .from(quotations)
      .where(eq(quotations.organizationId, orgId)),
    params.db
      .select({ id: quotationLines.id })
      .from(quotationLines)
      .where(eq(quotationLines.organizationId, orgId)),
    params.db.select({ id: awards.id }).from(awards).where(eq(awards.organizationId, orgId)),
    params.db
      .select({ id: awardAllocations.id })
      .from(awardAllocations)
      .where(eq(awardAllocations.organizationId, orgId)),
    params.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, orgId)),
    params.db
      .select({ id: storedDocuments.id })
      .from(storedDocuments)
      .where(eq(storedDocuments.organizationId, orgId)),
  ]);

  const targetCountsAfter: MigrationCounts = {
    suppliers: supRows.length,
    catalogItems: catRows.length,
    priceHistory: phRows.length,
    rfqs: rfqRows.length,
    rfqItems: rfqItemRows.length,
    quotations: quoteRows.length,
    quotationLines: quoteLineRows.length,
    awards: awardRows.length,
    awardAllocations: allocRows.length,
    auditLogs: auditRows.length,
    inlineDocumentsExtracted: docRows.length,
  };

  const integrityVerified =
    targetCountsAfter.suppliers >= sourceCounts.suppliers &&
    targetCountsAfter.catalogItems >= sourceCounts.catalogItems &&
    targetCountsAfter.priceHistory >= sourceCounts.priceHistory &&
    targetCountsAfter.rfqs >= sourceCounts.rfqs &&
    targetCountsAfter.rfqItems >= sourceCounts.rfqItems &&
    targetCountsAfter.quotations >= sourceCounts.quotations &&
    targetCountsAfter.quotationLines >= sourceCounts.quotationLines &&
    targetCountsAfter.awards >= sourceCounts.awards &&
    targetCountsAfter.awardAllocations >= sourceCounts.awardAllocations &&
    targetCountsAfter.auditLogs >= sourceCounts.auditLogs &&
    targetCountsAfter.inlineDocumentsExtracted >= sourceCounts.inlineDocumentsExtracted;

  return {
    dryRun: false,
    sourcePath: jsonPath,
    backupPath,
    organizationId: orgId,
    organizationName: state.settings.name,
    sourceCounts,
    targetCountsAfter,
    integrityVerified,
    warnings,
  };
}
