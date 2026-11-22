import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { SourceTrace } from '../types.ts';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  firebaseUid: text('firebase_uid').unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  fullName: text('full_name').notNull(),
  title: text('title').notNull().default('Procurement Member'),
  emailVerified: boolean('email_verified').notNull().default(false),
  emailVerificationTokenHash: text('email_verification_token_hash'),
  emailVerificationExpiresAt: timestamp('email_verification_expires_at', { withTimezone: true }),
  passwordResetTokenHash: text('password_reset_token_hash'),
  passwordResetExpiresAt: timestamp('password_reset_expires_at', { withTimezone: true }),
  lastActiveOrgId: text('last_active_org_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  countryCode: text('country_code').notNull().default('IN'),
  defaultCurrency: text('default_currency').notNull().default('INR'),
  taxRegime: text('tax_regime').notNull().default('INDIA_GST'),
  defaultTaxCreditable: boolean('default_tax_creditable').notNull().default(true),
  uomAliases: jsonb('uom_aliases').$type<Record<string, string>>().notNull().default({}),
  createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // owner | admin | buyer | approver | viewer
    status: text('status').notNull().default('active'), // active | suspended
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('org_memberships_org_user_uidx').on(table.organizationId, table.userId),
    index('org_memberships_user_idx').on(table.userId),
  ]
);

export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: text('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('pending'), // pending | accepted | revoked | expired
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('invitations_org_email_idx').on(table.organizationId, table.email)]
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activeOrganizationId: text('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    tokenHash: text('token_hash').notNull().unique(),
    csrfToken: text('csrf_token').notNull(),
    authMethod: text('auth_method').notNull().default('password'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_user_exp_idx').on(table.userId, table.expiresAt)]
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    taxId: text('tax_id').notNull().default(''),
    city: text('city').notNull().default(''),
    contactName: text('contact_name').notNull().default(''),
    email: text('email').notNull().default(''),
    phoneWhatsapp: text('phone_whatsapp').notNull().default(''),
    defaultPaymentTerms: text('default_payment_terms').notNull().default('Net 30 Days'),
    categories: jsonb('categories').$type<string[]>().notNull().default([]),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('suppliers_org_idx').on(table.organizationId),
    index('suppliers_org_name_idx').on(table.organizationId, table.name),
  ]
);

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    skuCode: text('sku_code').notNull().default(''),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    defaultUom: text('default_uom').notNull().default('pcs'),
    hsnSacCode: text('hsn_sac_code').notNull().default(''),
    lastAwardedUnitPrice: doublePrecision('last_awarded_unit_price'),
    lastAwardedCurrency: text('last_awarded_currency'),
    lastAwardedAt: text('last_awarded_at'),
    lastSupplierId: text('last_supplier_id').references(() => suppliers.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('catalog_items_org_idx').on(table.organizationId),
    index('catalog_items_org_norm_idx').on(table.organizationId, table.normalizedName),
  ]
);

export const priceHistory = pgTable(
  'price_history',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    catalogItemId: text('catalog_item_id')
      .notNull()
      .references(() => catalogItems.id, { onDelete: 'cascade' }),
    rfqId: text('rfq_id').notNull(),
    rfqNumber: text('rfq_number').notNull(),
    supplierId: text('supplier_id').notNull(),
    supplierName: text('supplier_name').notNull(),
    unitLandedPrice: doublePrecision('unit_landed_price').notNull(),
    currency: text('currency').notNull(),
    awardedAt: text('awarded_at').notNull(),
  },
  (table) => [index('price_history_org_item_idx').on(table.organizationId, table.catalogItemId)]
);

export const rfqs = pgTable(
  'rfqs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    rfqNumber: text('rfq_number').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('collecting'),
    currency: text('currency').notNull().default('INR'),
    incoterms: text('incoterms').notNull().default('FOR Destination'),
    deliveryLocation: text('delivery_location').notNull().default(''),
    deadlineDate: text('deadline_date').notNull(),
    createdBy: text('created_by').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    invitedSupplierIds: jsonb('invited_supplier_ids').$type<string[]>().notNull().default([]),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('rfqs_org_number_uidx').on(table.organizationId, table.rfqNumber),
    index('rfqs_org_idx').on(table.organizationId),
  ]
);

export const rfqItems = pgTable(
  'rfq_items',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    rfqId: text('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    itemId: text('item_id').references(() => catalogItems.id, { onDelete: 'set null' }),
    lineNo: integer('line_no').notNull(),
    skuCode: text('sku_code').notNull().default(''),
    description: text('description').notNull(),
    quantity: doublePrecision('quantity').notNull(),
    uom: text('uom').notNull().default('pcs'),
    targetUnitPrice: doublePrecision('target_unit_price'),
  },
  (table) => [index('rfq_items_org_rfq_idx').on(table.organizationId, table.rfqId)]
);

export const storedDocuments = pgTable(
  'stored_documents',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    uploadedByUserId: text('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    storageProvider: text('storage_provider').notNull(), // s3 | local
    storageKey: text('storage_key').notNull().unique(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('stored_documents_org_idx').on(table.organizationId)]
);

export const quotations = pgTable(
  'quotations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    rfqId: text('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    documentId: text('document_id').references(() => storedDocuments.id, {
      onDelete: 'set null',
    }),
    documentName: text('document_name').notNull(),
    documentKind: text('document_kind').notNull(),
    mimeType: text('mime_type').notNull(),
    rawEmailText: text('raw_email_text'),
    sheetPreview: jsonb('sheet_preview').$type<{ sheetName: string; rows: string[][] }[]>(),
    parseStatus: text('parse_status').notNull().default('needs_review'),
    quoteReference: text('quote_reference').notNull(),
    quoteDate: text('quote_date'),
    validUntil: text('valid_until'),
    currency: text('currency').notNull().default('INR'),
    exchangeRateToRfq: doublePrecision('exchange_rate_to_rfq').notNull().default(1),
    leadTimeDays: integer('lead_time_days'),
    paymentTerms: text('payment_terms'),
    freightCharges: doublePrecision('freight_charges').notNull().default(0),
    packingForwarding: doublePrecision('packing_forwarding').notNull().default(0),
    otherCharges: doublePrecision('other_charges').notNull().default(0),
    globalDiscount: doublePrecision('global_discount').notNull().default(0),
    taxIncludedInRates: boolean('tax_included_in_rates').notNull().default(false),
    missingFreightWarning: boolean('missing_freight_warning').notNull().default(false),
    subtotalBase: doublePrecision('subtotal_base').notNull().default(0),
    totalTax: doublePrecision('total_tax').notNull().default(0),
    totalLandedCost: doublePrecision('total_landed_cost').notNull().default(0),
    totalGrossPayable: doublePrecision('total_gross_payable').notNull().default(0),
    completenessRatio: doublePrecision('completeness_ratio').notNull().default(0),
    isVerified: boolean('is_verified').notNull().default(false),
    verifiedBy: text('verified_by'),
    verifiedAt: text('verified_at'),
    headerTraces: jsonb('header_traces').$type<Record<string, SourceTrace>>().notNull().default({}),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('quotations_org_rfq_idx').on(table.organizationId, table.rfqId),
    index('quotations_org_sup_idx').on(table.organizationId, table.supplierId),
  ]
);

export const quotationLines = pgTable(
  'quotation_lines',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    quotationId: text('quotation_id')
      .notNull()
      .references(() => quotations.id, { onDelete: 'cascade' }),
    rfqItemId: text('rfq_item_id').references(() => rfqItems.id, { onDelete: 'set null' }),
    vendorLineNo: integer('vendor_line_no').notNull(),
    rawDescription: text('raw_description').notNull(),
    quotedQty: doublePrecision('quoted_qty'),
    quotedUom: text('quoted_uom'),
    uomConversionFactor: doublePrecision('uom_conversion_factor').notNull().default(1),
    quotedUnitRate: doublePrecision('quoted_unit_rate'),
    discountAmount: doublePrecision('discount_amount').notNull().default(0),
    taxRatePct: doublePrecision('tax_rate_pct').notNull().default(0),
    taxCreditable: boolean('tax_creditable').notNull().default(true),
    allocatedOverhead: doublePrecision('allocated_overhead').notNull().default(0),
    normalizedUnitBase: doublePrecision('normalized_unit_base'),
    normalizedUnitLanded: doublePrecision('normalized_unit_landed'),
    normalizedUnitGross: doublePrecision('normalized_unit_gross'),
    lineTotalQuoted: doublePrecision('line_total_quoted'),
    expectedLineTotal: doublePrecision('expected_line_total'),
    mathValid: boolean('math_valid').notNull().default(true),
    mathErrorDetail: text('math_error_detail'),
    matchStatus: text('match_status').notNull().default('unmapped'),
    confidenceScore: doublePrecision('confidence_score').notNull().default(0.85),
    humanEdited: boolean('human_edited').notNull().default(false),
    verifiedField: boolean('verified_field').notNull().default(false),
    sourceTrace: jsonb('source_trace').$type<SourceTrace>().notNull(),
  },
  (table) => [index('quotation_lines_org_quote_idx').on(table.organizationId, table.quotationId)]
);

export const awards = pgTable(
  'awards',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    rfqId: text('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    isSplitAward: boolean('is_split_award').notNull().default(false),
    recommendedBy: text('recommended_by').notNull(),
    recommendedByUserId: text('recommended_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedBy: text('approved_by'),
    approvedByUserId: text('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvalStatus: text('approval_status').notNull().default('pending'),
    nonL1Justification: text('non_l1_justification'),
    approverNotes: text('approver_notes'),
    totalAwardedLanded: doublePrecision('total_awarded_landed').notNull().default(0),
    decidedAt: text('decided_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('awards_org_rfq_idx').on(table.organizationId, table.rfqId)]
);

export const awardAllocations = pgTable(
  'award_allocations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    awardId: text('award_id')
      .notNull()
      .references(() => awards.id, { onDelete: 'cascade' }),
    rfqItemId: text('rfq_item_id')
      .notNull()
      .references(() => rfqItems.id, { onDelete: 'cascade' }),
    quotationId: text('quotation_id')
      .notNull()
      .references(() => quotations.id, { onDelete: 'restrict' }),
    quotationLineId: text('quotation_line_id')
      .notNull()
      .references(() => quotationLines.id, { onDelete: 'restrict' }),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    awardedQty: doublePrecision('awarded_qty').notNull(),
    awardedUnitLanded: doublePrecision('awarded_unit_landed').notNull(),
  },
  (table) => [
    index('award_allocations_org_award_idx').on(table.organizationId, table.awardId),
    index('award_allocations_quote_idx').on(table.quotationId),
  ]
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name').notNull(),
    actorRole: text('actor_role').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    detail: text('detail').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('audit_logs_org_created_idx').on(table.organizationId, table.createdAt)]
);

export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  bucketKey: text('bucket_key').primaryKey(),
  hits: integer('hits').notNull().default(0),
  resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
});

// Drizzle Relations
export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMemberships),
  sessions: many(sessions),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(organizationMemberships),
  invitations: many(invitations),
  suppliers: many(suppliers),
  catalogItems: many(catalogItems),
  rfqs: many(rfqs),
  quotations: many(quotations),
  awards: many(awards),
  auditLogs: many(auditLogs),
}));

export const organizationMembershipsRelations = relations(
  organizationMemberships,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationMemberships.organizationId],
      references: [organizations.id],
    }),
    user: one(users, {
      fields: [organizationMemberships.userId],
      references: [users.id],
    }),
  })
);

export const rfqsRelations = relations(rfqs, ({ many }) => ({
  items: many(rfqItems),
  quotations: many(quotations),
  awards: many(awards),
}));

export const quotationsRelations = relations(quotations, ({ one, many }) => ({
  rfq: one(rfqs, {
    fields: [quotations.rfqId],
    references: [rfqs.id],
  }),
  supplier: one(suppliers, {
    fields: [quotations.supplierId],
    references: [suppliers.id],
  }),
  document: one(storedDocuments, {
    fields: [quotations.documentId],
    references: [storedDocuments.id],
  }),
  lines: many(quotationLines),
}));

export const awardsRelations = relations(awards, ({ one, many }) => ({
  rfq: one(rfqs, {
    fields: [awards.rfqId],
    references: [rfqs.id],
  }),
  allocations: many(awardAllocations),
}));
