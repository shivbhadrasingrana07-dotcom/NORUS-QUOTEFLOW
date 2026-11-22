import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import { createApp, type AppOptions } from '../server.ts';
import { DevOutboxEmailProvider } from '../server/emailService.ts';
import { LocalPrivateStorageProvider } from '../server/objectStorage.ts';
import { MemoryRateLimitStore } from '../server/rateLimiter.ts';
import { db } from '../src/db/index.ts';
import {
  auditLogs,
  awardAllocations,
  awards,
  catalogItems,
  invitations,
  organizationMemberships,
  organizations,
  priceHistory,
  quotationLines,
  quotations,
  rateLimitBuckets,
  rfqItems,
  rfqs,
  sessions,
  storedDocuments,
  suppliers,
  users,
} from '../src/db/schema.ts';

export class TestCookieClient {
  private readonly baseUrl: string;
  private cookiePair = '';
  public csrfToken = '';

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private captureCookies(res: Response) {
    const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const rawCookies = getSetCookie ? getSetCookie.call(res.headers) : [];
    const jar = new Map<string, string>();
    if (this.cookiePair) {
      for (const part of this.cookiePair.split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0) {
          jar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
        }
      }
    }
    for (const sc of rawCookies) {
      const first = sc.split(';')[0];
      const idx = first.indexOf('=');
      if (idx > 0) {
        const k = first.slice(0, idx).trim();
        const v = first.slice(idx + 1).trim();
        if (!v) jar.delete(k);
        else jar.set(k, v);
      }
    }
    this.cookiePair = Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request(urlPath: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers || {});
    if (this.cookiePair) {
      headers.set('Cookie', this.cookiePair);
    }
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && this.csrfToken && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', this.csrfToken);
    }
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      ...init,
      headers,
    });
    this.captureCookies(res);

    if (
      (urlPath === '/api/auth/register' ||
        urlPath === '/api/auth/login' ||
        urlPath === '/api/auth/google' ||
        urlPath === '/api/auth/me') &&
      res.ok
    ) {
      const cloned = res.clone();
      const body = (await cloned.json().catch(() => null)) as { csrfToken?: string } | null;
      if (body?.csrfToken) {
        this.csrfToken = body.csrfToken;
      }
    }
    return res;
  }

  clearSession() {
    this.cookiePair = '';
    this.csrfToken = '';
  }
}

export async function startIntegratedTestServer(overrides: Partial<AppOptions> = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-test-srv-'));
  const storageDir = path.join(tempRoot, 'private-storage');
  const emailProvider = new DevOutboxEmailProvider();
  const storageProvider = new LocalPrivateStorageProvider(storageDir);
  const rateLimitStore = overrides.rateLimitStore ?? new MemoryRateLimitStore();

  let rejectNextMath = false;

  const app = await createApp({
    enableVite: false,
    db,
    storageProvider,
    emailProvider,
    rateLimitStore,
    generateContentOverride:
      overrides.generateContentOverride ??
      (async (params) => {
        const textPart =
          params.contents.parts.find((p): p is { text: string } => 'text' in p)?.text || '';
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
      }),
    ...overrides,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    emailProvider,
    storageProvider,
    storageDir,
    setBadMathNext: () => {
      rejectNextMath = true;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

export async function cleanupTestOrganizationsAndUsers(params: {
  orgIds?: string[];
  userIds?: string[];
  rateBucketKeys?: string[];
}) {
  const orgIds = Array.from(new Set(params.orgIds || [])).filter(Boolean);
  const userIds = Array.from(new Set(params.userIds || [])).filter(Boolean);
  const rateBucketKeys = Array.from(new Set(params.rateBucketKeys || [])).filter(Boolean);

  if (rateBucketKeys.length > 0) {
    await db.delete(rateLimitBuckets).where(inArray(rateLimitBuckets.bucketKey, rateBucketKeys));
  }

  if (orgIds.length > 0) {
    await db.delete(awardAllocations).where(inArray(awardAllocations.organizationId, orgIds));
    await db.delete(awards).where(inArray(awards.organizationId, orgIds));
    await db.delete(quotationLines).where(inArray(quotationLines.organizationId, orgIds));
    await db.delete(quotations).where(inArray(quotations.organizationId, orgIds));
    await db.delete(storedDocuments).where(inArray(storedDocuments.organizationId, orgIds));
    await db.delete(rfqItems).where(inArray(rfqItems.organizationId, orgIds));
    await db.delete(rfqs).where(inArray(rfqs.organizationId, orgIds));
    await db.delete(priceHistory).where(inArray(priceHistory.organizationId, orgIds));
    await db.delete(catalogItems).where(inArray(catalogItems.organizationId, orgIds));
    await db.delete(suppliers).where(inArray(suppliers.organizationId, orgIds));
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgIds));
    await db.delete(invitations).where(inArray(invitations.organizationId, orgIds));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.organizationId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }

  if (userIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
}

export function createMinimalValidPng(): Buffer {
  // Valid 1x1 transparent PNG
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex'
  );
}

export function uniqueRunTag(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}
