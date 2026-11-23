import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { eq, inArray } from 'drizzle-orm';
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

export interface EntityReconciliation {
  inserted: number;
  alreadyExisting: number;
  conflicting: number;
  mismatched: number;
}

export type MigrationReconciliation = Record<keyof MigrationCounts, EntityReconciliation>;

export interface MigrationReport {
  dryRun: boolean;
  sourcePath: string;
  backupPath: string | null;
  organizationId: string;
  organizationName: string;
  sourceCounts: MigrationCounts;
  targetCountsAfter: MigrationCounts | null;
  reconciliation: MigrationReconciliation | null;
  rolledBackStorageKeys: string[];
  rollbackErrors: string[];
  integrityVerified: boolean;
  warnings: string[];
}

export class MigrationConflictError extends Error {
  conflictingIds: string[];

  constructor(message: string, conflictingIds: string[]) {
    super(message);
    this.name = 'MigrationConflictError';
    this.conflictingIds = conflictingIds;
  }
}

function emptyReconciliation(): MigrationReconciliation {
  const mk = (): EntityReconciliation => ({
    inserted: 0,
    alreadyExisting: 0,
    conflicting: 0,
    mismatched: 0,
  });
  return {
    suppliers: mk(),
    catalogItems: mk(),
    priceHistory: mk(),
    rfqs: mk(),
    rfqItems: mk(),
    quotations: mk(),
    quotationLines: mk(),
    awards: mk(),
    awardAllocations: mk(),
    auditLogs: mk(),
    inlineDocumentsExtracted: mk(),
  };
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

async function detectCrossOrgConflicts(
  tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0],
  targetOrgId: string,
  checks: Array<{
    entity: keyof MigrationCounts;
    rows: Array<{ id: string; organizationId: string }>;
  }>,
  reconciliation: MigrationReconciliation
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const chk of checks) {
    for (const row of chk.rows) {
      if (row.organizationId !== targetOrgId) {
        reconciliation[chk.entity].conflicting += 1;
        conflicts.push(`${chk.entity}:${row.id} (belongs to org ${row.organizationId})`);
      }
    }
  }
  return conflicts;
}

export async function migrateLegacyJsonToPostgres(params: {
  db: DrizzleDb;
  storageProvider: ObjectStorageProvider;
  jsonPath?: string;
  backupDir?: string;
  dryRun?: boolean;
  confirmed?: boolean;
  organizationIdOverride?: string;
  ownerEmail?: string;
}): Promise<MigrationReport> {
  const dryRun = params.dryRun ?? true;
  if (!dryRun && params.confirmed !== true) {
    throw new Error(
      'Legacy migration apply mode requires explicit confirmation (confirmed: true).'
    );
  }

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

  if (dryRun) {
    return {
      dryRun: true,
      sourcePath: jsonPath,
      backupPath: null,
      organizationId: orgId,
      organizationName: state.settings.name,
      sourceCounts,
      targetCountsAfter: null,
      reconciliation: null,
      rolledBackStorageKeys: [],
      rollbackErrors: [],
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
      warnings.push(
        `Quotation ${q.id} had unparseable fileDataUrl; skipped attachment extraction.`
      );
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

  const reconciliation = emptyReconciliation();
  const rolledBackStorageKeys: string[] = [];
  const rollbackErrors: string[] = [];

  try {
    await params.db.transaction(async (tx) => {
      // Pre-insert cross-organization ID conflict detection across all source IDs
      const supIds = state.suppliers.map((s) => s.id);
      const catIds = state.items.map((it) => it.id);
      const phIds = state.items.flatMap((it) =>
        (it.priceHistory || []).map((_, hIdx) => `ph-mig-${it.id}-${hIdx + 1}`)
      );
      const rfqIds = state.rfqs.map((r) => r.id);
      const rfqItemIds = state.rfqs.flatMap((r) => r.items.map((it) => it.id));
      const quoteIds = state.quotations.map((q) => q.id);
      const quoteLineIds = state.quotations.flatMap((q) => q.lines.map((l) => l.id));
      const awardIds = state.awards.map((a) => a.id);
      const allocIds = state.awards.flatMap((a) =>
        a.allocations.map((_, alIdx) => `al-mig-${a.id}-${alIdx + 1}`)
      );
      const auditIds = state.auditLogs.map((l) => l.id);
      const docIds = [...uploadedDocsByQuoteId.values()].map((d) => d.id);

      const conflicts = await detectCrossOrgConflicts(
        tx,
        orgId,
        [
          {
            entity: 'suppliers',
            rows: supIds.length
              ? await tx
                  .select({ id: suppliers.id, organizationId: suppliers.organizationId })
                  .from(suppliers)
                  .where(inArray(suppliers.id, supIds))
              : [],
          },
          {
            entity: 'catalogItems',
            rows: catIds.length
              ? await tx
                  .select({ id: catalogItems.id, organizationId: catalogItems.organizationId })
                  .from(catalogItems)
                  .where(inArray(catalogItems.id, catIds))
              : [],
          },
          {
            entity: 'priceHistory',
            rows: phIds.length
              ? await tx
                  .select({ id: priceHistory.id, organizationId: priceHistory.organizationId })
                  .from(priceHistory)
                  .where(inArray(priceHistory.id, phIds))
              : [],
          },
          {
            entity: 'rfqs',
            rows: rfqIds.length
              ? await tx
                  .select({ id: rfqs.id, organizationId: rfqs.organizationId })
                  .from(rfqs)
                  .where(inArray(rfqs.id, rfqIds))
              : [],
          },
          {
            entity: 'rfqItems',
            rows: rfqItemIds.length
              ? await tx
                  .select({ id: rfqItems.id, organizationId: rfqItems.organizationId })
                  .from(rfqItems)
                  .where(inArray(rfqItems.id, rfqItemIds))
              : [],
          },
          {
            entity: 'quotations',
            rows: quoteIds.length
              ? await tx
                  .select({ id: quotations.id, organizationId: quotations.organizationId })
                  .from(quotations)
                  .where(inArray(quotations.id, quoteIds))
              : [],
          },
          {
            entity: 'quotationLines',
            rows: quoteLineIds.length
              ? await tx
                  .select({ id: quotationLines.id, organizationId: quotationLines.organizationId })
                  .from(quotationLines)
                  .where(inArray(quotationLines.id, quoteLineIds))
              : [],
          },
          {
            entity: 'awards',
            rows: awardIds.length
              ? await tx
                  .select({ id: awards.id, organizationId: awards.organizationId })
                  .from(awards)
                  .where(inArray(awards.id, awardIds))
              : [],
          },
          {
            entity: 'awardAllocations',
            rows: allocIds.length
              ? await tx
                  .select({
                    id: awardAllocations.id,
                    organizationId: awardAllocations.organizationId,
                  })
                  .from(awardAllocations)
                  .where(inArray(awardAllocations.id, allocIds))
              : [],
          },
          {
            entity: 'auditLogs',
            rows: auditIds.length
              ? await tx
                  .select({ id: auditLogs.id, organizationId: auditLogs.organizationId })
                  .from(auditLogs)
                  .where(inArray(auditLogs.id, auditIds))
              : [],
          },
          {
            entity: 'inlineDocumentsExtracted',
            rows: docIds.length
              ? await tx
                  .select({
                    id: storedDocuments.id,
                    organizationId: storedDocuments.organizationId,
                  })
                  .from(storedDocuments)
                  .where(inArray(storedDocuments.id, docIds))
              : [],
          },
        ],
        reconciliation
      );

      if (conflicts.length > 0) {
        throw new MigrationConflictError(
          `Migration aborted: ${conflicts.length} record ID(s) already belong to a different organization (${conflicts
            .slice(0, 5)
            .join(', ')}).`,
          conflicts
        );
      }

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
        const inserted = await tx
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
          .onConflictDoNothing()
          .returning({ id: suppliers.id });
        if (inserted.length > 0) reconciliation.suppliers.inserted += 1;
        else reconciliation.suppliers.alreadyExisting += 1;
      }

      const validCatalogIds = new Set(state.items.map((it) => it.id));
      for (const it of state.items) {
        const insertedCat = await tx
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
          .onConflictDoNothing()
          .returning({ id: catalogItems.id });
        if (insertedCat.length > 0) reconciliation.catalogItems.inserted += 1;
        else reconciliation.catalogItems.alreadyExisting += 1;

        for (let hIdx = 0; hIdx < (it.priceHistory || []).length; hIdx += 1) {
          const h = it.priceHistory[hIdx];
          const insertedPh = await tx
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
            .onConflictDoNothing()
            .returning({ id: priceHistory.id });
          if (insertedPh.length > 0) reconciliation.priceHistory.inserted += 1;
          else reconciliation.priceHistory.alreadyExisting += 1;
        }
      }

      const validRfqItemIds = new Set<string>();
      for (const r of state.rfqs) {
        const insertedRfq = await tx
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
          .onConflictDoNothing()
          .returning({ id: rfqs.id });
        if (insertedRfq.length > 0) reconciliation.rfqs.inserted += 1;
        else reconciliation.rfqs.alreadyExisting += 1;

        for (const it of r.items) {
          validRfqItemIds.add(it.id);
          const insertedItem = await tx
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
            .onConflictDoNothing()
            .returning({ id: rfqItems.id });
          if (insertedItem.length > 0) reconciliation.rfqItems.inserted += 1;
          else reconciliation.rfqItems.alreadyExisting += 1;
        }
      }

      const validQuotationIds = new Set<string>();
      const validQuotationLineIds = new Set<string>();
      for (const q of state.quotations) {
        validQuotationIds.add(q.id);
        const uploaded = uploadedDocsByQuoteId.get(q.id);
        if (uploaded) {
          const insertedDoc = await tx
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
            .onConflictDoNothing()
            .returning({ id: storedDocuments.id });
          if (insertedDoc.length > 0) reconciliation.inlineDocumentsExtracted.inserted += 1;
          else reconciliation.inlineDocumentsExtracted.alreadyExisting += 1;
        }

        const insertedQuote = await tx
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
          .onConflictDoNothing()
          .returning({ id: quotations.id });
        if (insertedQuote.length > 0) reconciliation.quotations.inserted += 1;
        else reconciliation.quotations.alreadyExisting += 1;

        for (const l of q.lines) {
          validQuotationLineIds.add(l.id);
          const insertedLine = await tx
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
            .onConflictDoNothing()
            .returning({ id: quotationLines.id });
          if (insertedLine.length > 0) reconciliation.quotationLines.inserted += 1;
          else reconciliation.quotationLines.alreadyExisting += 1;
        }
      }

      for (const a of state.awards) {
        const insertedAward = await tx
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
          .onConflictDoNothing()
          .returning({ id: awards.id });
        if (insertedAward.length > 0) reconciliation.awards.inserted += 1;
        else reconciliation.awards.alreadyExisting += 1;

        for (let alIdx = 0; alIdx < a.allocations.length; alIdx += 1) {
          const al = a.allocations[alIdx];
          if (
            !validRfqItemIds.has(al.rfqItemId) ||
            !validQuotationIds.has(al.quotationId) ||
            !validQuotationLineIds.has(al.quotationLineId)
          ) {
            warnings.push(
              `Skipped dangling award allocation on ${a.id} for item ${al.rfqItemId}`
            );
            reconciliation.awardAllocations.mismatched += 1;
            continue;
          }
          const insertedAlloc = await tx
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
            .onConflictDoNothing()
            .returning({ id: awardAllocations.id });
          if (insertedAlloc.length > 0) reconciliation.awardAllocations.inserted += 1;
          else reconciliation.awardAllocations.alreadyExisting += 1;
        }
      }

      for (const log of state.auditLogs) {
        const insertedAudit = await tx
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
          .onConflictDoNothing()
          .returning({ id: auditLogs.id });
        if (insertedAudit.length > 0) reconciliation.auditLogs.inserted += 1;
        else reconciliation.auditLogs.alreadyExisting += 1;
      }
    });
  } catch (err) {
    for (const doc of uploadedDocsByQuoteId.values()) {
      try {
        await params.storageProvider.deleteObject(doc.storageKey);
        rolledBackStorageKeys.push(doc.storageKey);
      } catch (delErr) {
        rollbackErrors.push(
          `${doc.storageKey}: ${delErr instanceof Error ? delErr.message : String(delErr)}`
        );
      }
    }
    if (err instanceof Error) {
      const annotated = err as Error & {
        rolledBackStorageKeys?: string[];
        rollbackErrors?: string[];
      };
      annotated.rolledBackStorageKeys = rolledBackStorageKeys;
      annotated.rollbackErrors = rollbackErrors;
    }
    throw err;
  }

  // Post-migration per-ID and attribute verification scoped to organizationId
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
    params.db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(eq(suppliers.organizationId, orgId)),
    params.db
      .select({ id: catalogItems.id, name: catalogItems.name })
      .from(catalogItems)
      .where(eq(catalogItems.organizationId, orgId)),
    params.db
      .select({ id: priceHistory.id, unitLandedPrice: priceHistory.unitLandedPrice })
      .from(priceHistory)
      .where(eq(priceHistory.organizationId, orgId)),
    params.db
      .select({ id: rfqs.id, rfqNumber: rfqs.rfqNumber })
      .from(rfqs)
      .where(eq(rfqs.organizationId, orgId)),
    params.db
      .select({ id: rfqItems.id, rfqId: rfqItems.rfqId, quantity: rfqItems.quantity })
      .from(rfqItems)
      .where(eq(rfqItems.organizationId, orgId)),
    params.db
      .select({
        id: quotations.id,
        rfqId: quotations.rfqId,
        supplierId: quotations.supplierId,
        totalLandedCost: quotations.totalLandedCost,
      })
      .from(quotations)
      .where(eq(quotations.organizationId, orgId)),
    params.db
      .select({ id: quotationLines.id, quotationId: quotationLines.quotationId })
      .from(quotationLines)
      .where(eq(quotationLines.organizationId, orgId)),
    params.db
      .select({
        id: awards.id,
        rfqId: awards.rfqId,
        approvalStatus: awards.approvalStatus,
        totalAwardedLanded: awards.totalAwardedLanded,
      })
      .from(awards)
      .where(eq(awards.organizationId, orgId)),
    params.db
      .select({ id: awardAllocations.id, awardId: awardAllocations.awardId })
      .from(awardAllocations)
      .where(eq(awardAllocations.organizationId, orgId)),
    params.db
      .select({ id: auditLogs.id, action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, orgId)),
    params.db
      .select({ id: storedDocuments.id, sha256: storedDocuments.sha256 })
      .from(storedDocuments)
      .where(eq(storedDocuments.organizationId, orgId)),
  ]);

  const supMap = new Map(supRows.map((r) => [r.id, r]));
  for (const s of state.suppliers) {
    const found = supMap.get(s.id);
    if (!found || found.name !== s.name) {
      reconciliation.suppliers.mismatched += 1;
      warnings.push(`Supplier reconciliation mismatch for ${s.id}`);
    }
  }

  const catMap = new Map(catRows.map((r) => [r.id, r]));
  const phMap = new Map(phRows.map((r) => [r.id, r]));
  for (const it of state.items) {
    const found = catMap.get(it.id);
    if (!found || found.name !== it.name) {
      reconciliation.catalogItems.mismatched += 1;
      warnings.push(`CatalogItem reconciliation mismatch for ${it.id}`);
    }
    for (let hIdx = 0; hIdx < (it.priceHistory || []).length; hIdx += 1) {
      const phId = `ph-mig-${it.id}-${hIdx + 1}`;
      const phFound = phMap.get(phId);
      if (!phFound || Math.abs(phFound.unitLandedPrice - it.priceHistory[hIdx].unitLandedPrice) > 0.01) {
        reconciliation.priceHistory.mismatched += 1;
        warnings.push(`PriceHistory reconciliation mismatch for ${phId}`);
      }
    }
  }

  const rfqMap = new Map(rfqRows.map((r) => [r.id, r]));
  const rfqItemMap = new Map(rfqItemRows.map((r) => [r.id, r]));
  for (const r of state.rfqs) {
    const found = rfqMap.get(r.id);
    if (!found || found.rfqNumber !== r.rfqNumber) {
      reconciliation.rfqs.mismatched += 1;
      warnings.push(`RFQ reconciliation mismatch for ${r.id}`);
    }
    for (const it of r.items) {
      const itFound = rfqItemMap.get(it.id);
      if (!itFound || itFound.rfqId !== r.id || Math.abs(itFound.quantity - it.quantity) > 0.001) {
        reconciliation.rfqItems.mismatched += 1;
        warnings.push(`RFQ item reconciliation mismatch for ${it.id}`);
      }
    }
  }

  const quoteMap = new Map(quoteRows.map((r) => [r.id, r]));
  const qLineMap = new Map(quoteLineRows.map((r) => [r.id, r]));
  for (const q of state.quotations) {
    const found = quoteMap.get(q.id);
    if (
      !found ||
      found.rfqId !== q.rfqId ||
      found.supplierId !== q.supplierId ||
      Math.abs(found.totalLandedCost - q.totalLandedCost) > 0.01
    ) {
      reconciliation.quotations.mismatched += 1;
      warnings.push(`Quotation reconciliation mismatch for ${q.id}`);
    }
    for (const l of q.lines) {
      const lFound = qLineMap.get(l.id);
      if (!lFound || lFound.quotationId !== q.id) {
        reconciliation.quotationLines.mismatched += 1;
        warnings.push(`Quotation line reconciliation mismatch for ${l.id}`);
      }
    }
  }

  const awardMap = new Map(awardRows.map((r) => [r.id, r]));
  const allocMap = new Map(allocRows.map((r) => [r.id, r]));
  for (const a of state.awards) {
    const found = awardMap.get(a.id);
    if (
      !found ||
      found.rfqId !== a.rfqId ||
      found.approvalStatus !== a.approvalStatus ||
      Math.abs(found.totalAwardedLanded - a.totalAwardedLanded) > 0.01
    ) {
      reconciliation.awards.mismatched += 1;
      warnings.push(`Award reconciliation mismatch for ${a.id}`);
    }
    for (let alIdx = 0; alIdx < a.allocations.length; alIdx += 1) {
      const alId = `al-mig-${a.id}-${alIdx + 1}`;
      const alFound = allocMap.get(alId);
      if (!alFound || alFound.awardId !== a.id) {
        reconciliation.awardAllocations.mismatched += 1;
        warnings.push(`Award allocation reconciliation mismatch for ${alId}`);
      }
    }
  }

  const auditMap = new Map(auditRows.map((r) => [r.id, r]));
  for (const log of state.auditLogs) {
    const found = auditMap.get(log.id);
    if (!found || found.action !== log.action) {
      reconciliation.auditLogs.mismatched += 1;
      warnings.push(`Audit log reconciliation mismatch for ${log.id}`);
    }
  }

  const docMap = new Map(docRows.map((r) => [r.id, r]));
  for (const doc of uploadedDocsByQuoteId.values()) {
    const found = docMap.get(doc.id);
    if (!found || found.sha256 !== doc.sha256) {
      reconciliation.inlineDocumentsExtracted.mismatched += 1;
      warnings.push(`Stored document SHA-256 mismatch for ${doc.id}`);
    }
  }

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

  const integrityVerified = Object.values(reconciliation).every(
    (entry) => entry.conflicting === 0 && entry.mismatched === 0
  );

  return {
    dryRun: false,
    sourcePath: jsonPath,
    backupPath,
    organizationId: orgId,
    organizationName: state.settings.name,
    sourceCounts,
    targetCountsAfter,
    reconciliation,
    rolledBackStorageKeys,
    rollbackErrors,
    integrityVerified,
    warnings,
  };
}
