import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import { createApp, type AppOptions } from '../server.ts';
import { DevOutboxEmailProvider } from '../server/emailService.ts';
import { LocalPrivateStorageProvider } from '../server/objectStorage.ts';
import { MemoryRateLimitStore } from '../server/rateLimiter.ts';
import type { DrizzleDb } from '../src/db/index.ts';
import * as schema from '../src/db/schema.ts';
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

export const TEST_DB_SKIP_REASON =
  'Skipped: disposable TEST_DATABASE_URL or TEST_SQL_* test database is not configured (managed Cloud SQL is never used for tests).';

const FORBIDDEN_TEST_DB_NAMES = new Set([
  'cloud_sql_development_database',
  'prod',
  'production',
  'staging',
  'postgres',
]);

const LOCAL_CI_TEST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'postgres']);

function isUnsafeTestDbName(dbName: string): boolean {
  const normalized = dbName.trim().toLowerCase();
  if (!normalized) return true;
  if (FORBIDDEN_TEST_DB_NAMES.has(normalized)) return true;
  if (normalized.includes('cloud_sql_development')) return true;
  if (normalized.includes('production') || normalized.includes('staging')) return true;
  return false;
}

function isUnsafeSocketHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith('/') || normalized.includes('/cloudsql/');
}

function isPermittedOverlap(
  env: Record<string, string | undefined>,
  testHost: string,
  testDbName: string
): boolean {
  const sqlHost = env.SQL_HOST?.trim().toLowerCase();
  const sqlDb = env.SQL_DB_NAME?.trim().toLowerCase();
  if (!sqlHost || !sqlDb) return true;
  if (testHost.trim().toLowerCase() !== sqlHost || testDbName.trim().toLowerCase() !== sqlDb) {
    return true;
  }
  const nodeEnv = (env.NODE_ENV || '').trim().toLowerCase();
  const dbLower = testDbName.trim().toLowerCase();
  return (
    nodeEnv === 'test' &&
    LOCAL_CI_TEST_HOSTS.has(testHost.trim().toLowerCase()) &&
    (dbLower.endsWith('_test') || dbLower.endsWith('-test'))
  );
}

export function getSafeTestDbConfig(
  env: Record<string, string | undefined> = process.env
): PoolConfig | null {
  const testUrl = env.TEST_DATABASE_URL?.trim();
  if (testUrl) {
    try {
      const parsed = new URL(testUrl);
      const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      const urlHost = parsed.searchParams.get('host') || parsed.hostname || '';
      if (isUnsafeTestDbName(dbName) || isUnsafeSocketHost(urlHost) || isUnsafeSocketHost(testUrl)) {
        return null;
      }
      if (!isPermittedOverlap(env, urlHost, dbName)) {
        return null;
      }
      return {
        connectionString: testUrl,
        max: 5,
        connectionTimeoutMillis: 10000,
      };
    } catch {
      return null;
    }
  }

  const host = env.TEST_SQL_HOST?.trim();
  const user = env.TEST_SQL_USER?.trim();
  const password = env.TEST_SQL_PASSWORD;
  const database = env.TEST_SQL_DB_NAME?.trim();
  if (!host || !user || password === undefined || !database) {
    return null;
  }
  if (isUnsafeTestDbName(database) || isUnsafeSocketHost(host)) {
    return null;
  }
  if (!isPermittedOverlap(env, host, database)) {
    return null;
  }
  return {
    host,
    port: env.TEST_SQL_PORT ? Number(env.TEST_SQL_PORT) : 5432,
    user,
    password,
    database,
    ssl:
      env.TEST_SQL_SSL === 'true'
        ? { rejectUnauthorized: env.TEST_SQL_SSL_ALLOW_SELF_SIGNED !== 'true' }
        : undefined,
    max: 5,
    connectionTimeoutMillis: 10000,
  };
}

export function isSafeTestDbConfigured(): boolean {
  return getSafeTestDbConfig() !== null;
}

let cachedTestPool: Pool | null = null;
let cachedTestDb: DrizzleDb | null = null;

export function getTestDbAndPool(): { db: DrizzleDb; pool: Pool } {
  const cfg = getSafeTestDbConfig();
  if (!cfg) {
    throw new Error(TEST_DB_SKIP_REASON);
  }
  if (!cachedTestPool || !cachedTestDb) {
    cachedTestPool = new Pool(cfg);
    cachedTestDb = drizzle(cachedTestPool, { schema }) as unknown as DrizzleDb;
  }
  return { db: cachedTestDb, pool: cachedTestPool };
}

export async function closeTestDbPool(): Promise<void> {
  if (cachedTestPool) {
    const toClose = cachedTestPool;
    cachedTestPool = null;
    cachedTestDb = null;
    await toClose.end();
  }
}

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

  let dbForApp: DrizzleDb;
  if (overrides.db) {
    dbForApp = overrides.db;
  } else if (isSafeTestDbConfigured()) {
    dbForApp = getTestDbAndPool().db;
  } else if (overrides.demoMode === true) {
    dbForApp = {} as DrizzleDb;
  } else {
    throw new Error(TEST_DB_SKIP_REASON);
  }

  let rejectNextMath = false;

  const app = await createApp({
    enableVite: false,
    db: dbForApp,
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
  if (!isSafeTestDbConfigured()) {
    return;
  }
  const orgIds = Array.from(new Set(params.orgIds || [])).filter(Boolean);
  const userIds = Array.from(new Set(params.userIds || [])).filter(Boolean);
  const rateBucketKeys = Array.from(new Set(params.rateBucketKeys || [])).filter(Boolean);

  if (orgIds.length === 0 && userIds.length === 0 && rateBucketKeys.length === 0) {
    return;
  }

  const { db } = getTestDbAndPool();

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
