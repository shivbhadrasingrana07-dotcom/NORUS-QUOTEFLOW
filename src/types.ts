export type UserRole = 'admin' | 'buyer' | 'approver' | 'viewer';

export type TaxRegime = 'INDIA_GST' | 'UK_VAT' | 'US_TAX' | 'NONE';

export type RfqStatus =
  | 'draft'
  | 'collecting'
  | 'in_review'
  | 'pending_approval'
  | 'approved'
  | 'awarded'
  | 'closed';

export type ParseStatus =
  | 'queued'
  | 'parsing'
  | 'extracting'
  | 'needs_review'
  | 'verified'
  | 'failed';

export type MatchStatus = 'matched' | 'unmapped' | 'not_quoted' | 'alternate_spec';

export type CostBasis = 'base' | 'landed' | 'gross';

export interface OrganizationSettings {
  id: string;
  name: string;
  countryCode: string;
  defaultCurrency: 'INR' | 'USD' | 'GBP' | 'EUR';
  taxRegime: TaxRegime;
  defaultTaxCreditable: boolean;
  uomAliases: Record<string, string>;
  activeUserName: string;
  activeUserTitle: string;
  activeUserRole: UserRole;
}

export interface Supplier {
  id: string;
  name: string;
  taxId: string;
  city: string;
  contactName: string;
  email: string;
  phoneWhatsapp: string;
  defaultPaymentTerms: string;
  categories: string[];
  createdAt: string;
}

export interface PriceHistoryEntry {
  rfqId: string;
  rfqNumber: string;
  supplierId: string;
  supplierName: string;
  unitLandedPrice: number;
  currency: string;
  awardedAt: string;
}

export interface CatalogItem {
  id: string;
  skuCode: string;
  name: string;
  normalizedName: string;
  defaultUom: string;
  hsnSacCode: string;
  lastAwardedUnitPrice: number | null;
  lastAwardedCurrency: string | null;
  lastAwardedAt: string | null;
  lastSupplierId: string | null;
  priceHistory: PriceHistoryEntry[];
}

export interface RfqItem {
  id: string;
  rfqId: string;
  itemId: string | null;
  lineNo: number;
  skuCode: string;
  description: string;
  quantity: number;
  uom: string;
  targetUnitPrice: number | null;
}

export interface Rfq {
  id: string;
  rfqNumber: string;
  title: string;
  status: RfqStatus;
  currency: 'INR' | 'USD' | 'GBP' | 'EUR';
  incoterms: string;
  deliveryLocation: string;
  deadlineDate: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  items: RfqItem[];
  invitedSupplierIds: string[];
}

export interface SourceTrace {
  sourceType: 'pdf' | 'excel' | 'image' | 'email';
  page?: number;
  bbox?: [number, number, number, number]; // percentage [x0, y0, x1, y1] 0-100
  sheet?: string;
  cell?: string;
  snippet: string;
}

export interface QuotationLine {
  id: string;
  quotationId: string;
  rfqItemId: string | null;
  vendorLineNo: number;
  rawDescription: string;
  quotedQty: number | null;
  quotedUom: string | null;
  uomConversionFactor: number;
  quotedUnitRate: number | null;
  discountAmount: number;
  taxRatePct: number;
  taxCreditable: boolean;
  allocatedOverhead: number;
  normalizedUnitBase: number | null;
  normalizedUnitLanded: number | null;
  normalizedUnitGross: number | null;
  lineTotalQuoted: number | null;
  expectedLineTotal: number | null;
  mathValid: boolean;
  mathErrorDetail: string | null;
  matchStatus: MatchStatus;
  confidenceScore: number;
  humanEdited: boolean;
  verifiedField: boolean;
  sourceTrace: SourceTrace;
}

export interface Quotation {
  id: string;
  rfqId: string;
  supplierId: string;
  documentName: string;
  documentKind: 'pdf' | 'excel' | 'image' | 'email';
  mimeType: string;
  fileDataUrl?: string;
  rawEmailText?: string;
  sheetPreview?: {
    sheetName: string;
    rows: string[][];
  }[];
  parseStatus: ParseStatus;
  quoteReference: string;
  quoteDate: string | null;
  validUntil: string | null;
  currency: 'INR' | 'USD' | 'GBP' | 'EUR';
  exchangeRateToRfq: number;
  leadTimeDays: number | null;
  paymentTerms: string | null;
  freightCharges: number;
  packingForwarding: number;
  otherCharges: number;
  globalDiscount: number;
  taxIncludedInRates: boolean;
  missingFreightWarning: boolean;
  subtotalBase: number;
  totalTax: number;
  totalLandedCost: number;
  totalGrossPayable: number;
  completenessRatio: number;
  isVerified: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  headerTraces: Record<string, SourceTrace>;
  lines: QuotationLine[];
  createdAt: string;
}

export interface AwardAllocation {
  rfqItemId: string;
  quotationId: string;
  quotationLineId: string;
  supplierId: string;
  awardedQty: number;
  awardedUnitLanded: number;
}

export interface AwardDecision {
  id: string;
  rfqId: string;
  isSplitAward: boolean;
  recommendedBy: string;
  approvedBy: string | null;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  nonL1Justification: string | null;
  approverNotes: string | null;
  totalAwardedLanded: number;
  allocations: AwardAllocation[];
  decidedAt: string | null;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorName: string;
  actorRole: UserRole;
  entityType: 'rfq' | 'quotation' | 'quotation_line' | 'award' | 'supplier' | 'settings';
  entityId: string;
  action: string;
  detail: string;
  createdAt: string;
}

export interface WorkspaceState {
  settings: OrganizationSettings;
  suppliers: Supplier[];
  items: CatalogItem[];
  rfqs: Rfq[];
  quotations: Quotation[];
  awards: AwardDecision[];
  auditLogs: AuditLogEntry[];
}
