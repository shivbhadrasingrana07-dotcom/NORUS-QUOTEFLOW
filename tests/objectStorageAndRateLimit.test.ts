import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  buildDocumentStorageKey,
  LocalPrivateStorageProvider,
  S3CompatibleStorageProvider,
  verifySignedDocumentToken,
} from '../server/objectStorage.ts';
import { MemoryRateLimitStore, PostgresRateLimitStore } from '../server/rateLimiter.ts';
import { db, isSqlEnvConfigured, pool } from '../src/db/index.ts';
import { rateLimitBuckets } from '../src/db/schema.ts';

const tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-storage-test-'));
const createdRateBuckets: string[] = [];

after(async () => {
  fs.rmSync(tempStorageDir, { recursive: true, force: true });
  for (const key of createdRateBuckets) {
    await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucketKey, key)).catch(() => undefined);
  }
  await pool.end();
});

test('LocalPrivateStorageProvider stores, reads, deletes, prevents path traversal, and verifies HMAC signed URLs', async () => {
  const provider = new LocalPrivateStorageProvider(tempStorageDir);
  const key = buildDocumentStorageKey('org-alpha', 'doc-001', '../../etc/passwd quote.pdf');
  assert.ok(!key.includes('..'));
  assert.match(key, /^orgs\/org-alpha\/docs\/doc-001\//);

  const payload = Buffer.from('%PDF-1.4\ntest-doc\n', 'utf8');
  await provider.putObject({ key, buffer: payload, contentType: 'application/pdf' });

  const fetched = await provider.getObject(key);
  assert.deepEqual(fetched.buffer, payload);

  const signed = await provider.createSignedDownloadUrl({
    documentId: 'doc-001',
    storageKey: key,
    organizationId: 'org-alpha',
    filename: 'quote.pdf',
    expiresInSec: 120,
  });

  const parsed = new URL(`http://localhost${signed.url}`);
  const org = parsed.searchParams.get('org') || '';
  const exp = Number(parsed.searchParams.get('exp'));
  const sig = parsed.searchParams.get('sig') || '';

  assert.equal(
    verifySignedDocumentToken({
      documentId: 'doc-001',
      organizationId: org,
      exp,
      sig,
    }),
    true
  );

  // Tampered org / doc / expired must fail
  assert.equal(
    verifySignedDocumentToken({
      documentId: 'doc-001',
      organizationId: 'org-beta',
      exp,
      sig,
    }),
    false
  );
  assert.equal(
    verifySignedDocumentToken({
      documentId: 'doc-001',
      organizationId: org,
      exp: Math.floor(Date.now() / 1000) - 10,
      sig,
    }),
    false
  );

  await provider.deleteObject(key);
  await assert.rejects(() => provider.getObject(key));
});

test('S3CompatibleStorageProvider generates AWS SigV4 headers and presigned download URLs', async () => {
  const s3 = new S3CompatibleStorageProvider({
    endpoint: 'https://s3.ap-south-1.example.com',
    region: 'ap-south-1',
    bucket: 'norus-private-docs',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });

  const calls: Array<{ url: string; method: string; auth: string }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers || {});
    calls.push({
      url,
      method: init?.method || 'GET',
      auth: headers.get('Authorization') || '',
    });
    if ((init?.method || 'GET') === 'GET') {
      return new Response(Buffer.from('hello-s3'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    await s3.putObject({
      key: 'orgs/org-1/docs/doc-9/quote.pdf',
      buffer: Buffer.from('hello-s3'),
      contentType: 'application/pdf',
    });
    const got = await s3.getObject('orgs/org-1/docs/doc-9/quote.pdf');
    assert.equal(got.buffer.toString('utf8'), 'hello-s3');
    await s3.deleteObject('orgs/org-1/docs/doc-9/quote.pdf');

    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.match(c.auth, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
      assert.match(c.auth, /SignedHeaders=/);
      assert.match(c.auth, /Signature=[0-9a-f]{64}$/);
    }

    const presigned = await s3.createSignedDownloadUrl({
      documentId: 'doc-9',
      storageKey: 'orgs/org-1/docs/doc-9/quote.pdf',
      organizationId: 'org-1',
      filename: 'quote.pdf',
      expiresInSec: 300,
    });
    const parsed = new URL(presigned.url);
    assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(parsed.searchParams.get('X-Amz-Expires'), '300');
    assert.match(parsed.searchParams.get('X-Amz-Signature') || '', /^[0-9a-f]{64}$/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('MemoryRateLimitStore enforces window limit and resets after window expires', async () => {
  const store = new MemoryRateLimitStore();
  const r1 = await store.consume('k1', 2, 40);
  const r2 = await store.consume('k1', 2, 40);
  const r3 = await store.consume('k1', 2, 40);
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, false);
  assert.equal(r3.remaining, 0);

  await new Promise((r) => setTimeout(r, 55));
  const r4 = await store.consume('k1', 2, 40);
  assert.equal(r4.allowed, true);
});

test('MemoryRateLimitStore bounds active buckets with LRU eviction and prunes expired buckets', async () => {
  const store = new MemoryRateLimitStore(3);
  await store.consume('b1', 5, 5000);
  await store.consume('b2', 5, 5000);
  await store.consume('b3', 5, 5000);
  assert.equal(store.getBucketCount(), 3);

  // Access b1 again so b2 becomes the least-recently-used key
  await store.consume('b1', 5, 5000);
  await store.consume('b4', 5, 5000);
  assert.equal(store.getBucketCount(), 3);

  // b1 must still remember count=2 (only 3 left out of 5) while b2 was evicted and starts fresh
  const b1Check = await store.consume('b1', 5, 5000);
  assert.equal(b1Check.remaining, 2);

  // Expired buckets are cleaned out before counting capacity
  const timedStore = new MemoryRateLimitStore(2);
  await timedStore.consume('e1', 5, 25);
  await timedStore.consume('e2', 5, 25);
  await new Promise((r) => setTimeout(r, 40));
  await timedStore.consume('e3', 5, 5000);
  assert.equal(timedStore.getBucketCount(), 1);
});

test('PostgresRateLimitStore persists atomic counters in Cloud SQL rate_limit_buckets', async (t) => {
  if (!isSqlEnvConfigured()) {
    t.skip('SQL_* env vars not configured');
    return;
  }
  const pgLimiter = new PostgresRateLimitStore(db);
  const key = `test-rl-${Date.now().toString(36)}`;
  createdRateBuckets.push(key);

  const a = await pgLimiter.consume(key, 2, 5000);
  const b = await pgLimiter.consume(key, 2, 5000);
  const c = await pgLimiter.consume(key, 2, 5000);

  assert.equal(a.allowed, true);
  assert.equal(a.remaining, 1);
  assert.equal(b.allowed, true);
  assert.equal(b.remaining, 0);
  assert.equal(c.allowed, false);
  assert.equal(c.remaining, 0);
});
