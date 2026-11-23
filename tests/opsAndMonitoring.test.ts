import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { isValidSenderAddress, ResendEmailProvider } from '../server/emailService.ts';
import { runScheduledMaintenance } from '../server/maintenance.ts';
import type { ObjectStorageProvider } from '../server/objectStorage.ts';
import { LocalPrivateStorageProvider } from '../server/objectStorage.ts';
import {
  BootstrapError,
  bootstrapFirstOwnerDirect,
  inspectOrganizationOwnership,
  issueFirstOwnerClaimToken,
} from '../server/ownerBootstrap.ts';
import { PgDataStore, StoreError } from '../server/pgStore.ts';
import { adminAuth, verifyFirebaseIdToken } from '../server/firebase-admin.ts';
import { generateSecureToken, sha256Hex } from '../server/security.ts';
import {
  invitations,
  organizationMemberships,
  organizations,
  rateLimitBuckets,
  sessions,
  storedDocuments,
  users,
} from '../src/db/schema.ts';
import {
  cleanupTestOrganizationsAndUsers,
  closeTestDbPool,
  createMinimalValidPng,
  getTestDbAndPool,
  isSafeTestDbConfigured,
  startIntegratedTestServer,
  TEST_DB_SKIP_REASON,
  TestCookieClient,
  uniqueRunTag,
} from './_helpers.ts';

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];
const createdRateBuckets: string[] = [];
const tempDirs: string[] = [];

after(async () => {
  await cleanupTestOrganizationsAndUsers({
    orgIds: createdOrgIds,
    userIds: createdUserIds,
    rateBucketKeys: createdRateBuckets,
  });
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await closeTestDbPool();
});

test('ResendEmailProvider validates senders, retries transient 503/429 failures, aborts timeouts, and redacts API keys', async () => {
  assert.equal(isValidSenderAddress('NORUS QUOTEFLOW <noreply@norus.in>'), true);
  assert.equal(isValidSenderAddress('ops@norus.in'), true);
  assert.equal(isValidSenderAddress('not-an-email'), false);
  assert.throws(() => new ResendEmailProvider('re_test_key', 'invalid-sender'), /EMAIL_FROM/);

  const secretKey = 're_live_SUPERSECRET_999888777';
  const provider = new ResendEmailProvider(secretKey, 'NORUS <noreply@norus.in>', {
    timeoutMs: 80,
    maxRetries: 2,
    retryBaseDelayMs: 10,
  });
  assert.deepEqual(provider.getStatus(), {
    mode: 'resend',
    configured: true,
    senderValid: true,
  });

  const origFetch = globalThis.fetch;
  try {
    // 1. Transient 503 -> 429 -> 200 recovery
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('unavailable', { status: 503 });
      if (calls === 2) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
    }) as typeof fetch;

    const ok = await provider.send({
      to: 'buyer@example.com',
      subject: 'Verify account',
      text: 'Click link',
    });
    assert.equal(ok.delivered, true);
    assert.equal(ok.provider, 'resend');
    assert.equal(ok.attempts, 3);

    // 2. Non-retryable 401 fails immediately on attempt 1
    let authFailCalls = 0;
    globalThis.fetch = (async () => {
      authFailCalls += 1;
      return new Response('unauthorized', { status: 401 });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        provider.send({
          to: 'buyer@example.com',
          subject: 'Test',
          text: 'Hello',
        }),
      /status 401/
    );
    assert.equal(authFailCalls, 1);

    // 3. Error redaction hides Bearer token if thrown by network stack
    globalThis.fetch = (async () => {
      throw new Error(`Network failed with Bearer ${secretKey}`);
    }) as typeof fetch;

    await assert.rejects(
      () =>
        provider.send({
          to: 'buyer@example.com',
          subject: 'Redaction check',
          text: 'Hello',
        }),
      (err: Error) => {
        assert.equal(err.message.includes(secretKey), false);
        assert.ok(err.message.includes('[REDACTED]'));
        return true;
      }
    );

    // 4. Timeout via AbortController
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      })) as typeof fetch;

    await assert.rejects(
      () =>
        provider.send({
          to: 'buyer@example.com',
          subject: 'Timeout check',
          text: 'Hello',
        }),
      /timed out/i
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test(
  'Token security: expired verification/reset tokens fail, one-time reuse is blocked, and Google existing-user invite + unverified link checks work',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    const { db } = getTestDbAndPool();
    const store = new PgDataStore(db);
  const tag = uniqueRunTag();
  const email = `tok-${tag}@example.com`;

  const reg = await store.registerWithPassword({
    email,
    password: 'StrongPassword#2026!',
    fullName: 'Token Security User',
    organizationName: `Token Org ${tag}`,
  });
  createdUserIds.push(reg.user.id);
  createdOrgIds.push(reg.activeOrganization!.id);

  // One-time email verification succeeds once, second reuse fails
  const verified = await store.verifyEmailByToken(reg.rawVerificationToken);
  assert.equal(verified.emailVerified, true);
  await assert.rejects(() => store.verifyEmailByToken(reg.rawVerificationToken), StoreError);

  // Expired verification token rejected
  const issuedVerif = await store.createEmailVerificationToken(reg.user.id);
  await db
    .update(users)
    .set({ emailVerificationExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(users.id, reg.user.id));
  await assert.rejects(() => store.verifyEmailByToken(issuedVerif.rawToken), /expired/i);

  // Expired password reset token rejected
  const resetIssued = await store.createPasswordResetToken(email);
  assert.ok(resetIssued);
  await db
    .update(users)
    .set({ passwordResetExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(users.id, reg.user.id));
  await assert.rejects(
    () => store.resetPasswordByToken(resetIssued.rawToken, 'NewStrongPassword#2026!'),
    /expired/i
  );

  // Unverified Google account cannot link onto existing password account (403)
  await assert.rejects(
    () =>
      store.loginWithGoogle({
        firebaseUid: `g-unverified-${tag}`,
        email,
        fullName: 'Token Security User',
        emailVerified: false,
      }),
    (err: unknown) => err instanceof StoreError && err.statusCode === 403
  );

  // Verified Google login links existing user AND accepts an invitation to a second organization
  const owner2 = await store.registerWithPassword({
    email: `owner2-${tag}@example.com`,
    password: 'StrongPassword#2026!',
    fullName: 'Owner Two',
    organizationName: `Second Org ${tag}`,
  });
  createdUserIds.push(owner2.user.id);
  createdOrgIds.push(owner2.activeOrganization!.id);

  const inv = await store.createInvitation({
    organizationId: owner2.activeOrganization!.id,
    email,
    role: 'buyer',
    invitedByUserId: owner2.user.id,
    actorName: owner2.user.fullName,
    actorRole: 'owner',
  });

  const googleJoined = await store.loginWithGoogle({
    firebaseUid: `g-verified-${tag}`,
    email,
    fullName: 'Token Security User',
    emailVerified: true,
    inviteToken: inv.rawToken,
  });
  assert.equal(googleJoined.user.hasGoogleLinked, true);
  assert.equal(googleJoined.activeOrganization?.id, owner2.activeOrganization!.id);
  assert.equal(googleJoined.activeOrganization?.role, 'buyer');
  assert.equal(googleJoined.organizations.length, 2);
});

test(
  'First-owner bootstrap safely links an owner-less organization via claim token & direct bootstrap, blocking duplicates and enforcing last-owner protection',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    const { db } = getTestDbAndPool();
    const store = new PgDataStore(db);
  const tag = uniqueRunTag();
  const orgTokenId = `org-boot-tok-${tag}`;
  const orgDirectId = `org-boot-dir-${tag}`;
  createdOrgIds.push(orgTokenId, orgDirectId);

  await db.insert(organizations).values([
    {
      id: orgTokenId,
      slug: `boot-tok-${tag}`,
      name: `Ownerless Token Corp ${tag}`,
      countryCode: 'IN',
      defaultCurrency: 'INR',
      taxRegime: 'INDIA_GST',
      defaultTaxCreditable: true,
      uomAliases: { nos: 'pcs' },
    },
    {
      id: orgDirectId,
      slug: `boot-dir-${tag}`,
      name: `Ownerless Direct Corp ${tag}`,
      countryCode: 'IN',
      defaultCurrency: 'INR',
      taxRegime: 'INDIA_GST',
      defaultTaxCreditable: true,
      uomAliases: { nos: 'pcs' },
    },
  ]);

  // 1. Inspect detects missing owner
  const inspectBefore = await inspectOrganizationOwnership(db, orgTokenId);
  assert.equal(inspectBefore.organizationExists, true);
  assert.equal(inspectBefore.activeOwnerCount, 0);
  assert.equal(inspectBefore.requiresFirstOwnerBootstrap, true);

  // 2. Issue one-time claim token for founder email
  const founderEmail = `founder-${tag}@example.com`;
  const claim = await issueFirstOwnerClaimToken({
    db,
    organizationId: orgTokenId,
    allowedEmail: founderEmail,
    ttlHours: 24,
  });
  assert.equal(claim.allowedEmail, founderEmail);

  // Wrong user email cannot hijack the claim token (403)
  await assert.rejects(
    () =>
      store.registerWithPassword({
        email: `intruder-${tag}@example.com`,
        password: 'StrongPassword#2026!',
        fullName: 'Unauthorized User',
        inviteToken: claim.rawClaimToken,
      }),
    (err: unknown) => err instanceof StoreError && err.statusCode === 403
  );

  // Authorized founder claims first ownership cleanly
  const founder = await store.registerWithPassword({
    email: founderEmail,
    password: 'StrongPassword#2026!',
    fullName: 'Real Founder',
    inviteToken: claim.rawClaimToken,
  });
  createdUserIds.push(founder.user.id);
  assert.equal(founder.activeOrganization?.id, orgTokenId);
  assert.equal(founder.activeOrganization?.role, 'owner');

  const inspectAfter = await inspectOrganizationOwnership(db, orgTokenId);
  assert.equal(inspectAfter.activeOwnerCount, 1);
  assert.equal(inspectAfter.requiresFirstOwnerBootstrap, false);

  // Re-issuing claim token or direct bootstrap when owner already exists is blocked (409)
  await assert.rejects(
    () =>
      issueFirstOwnerClaimToken({
        db,
        organizationId: orgTokenId,
        allowedEmail: `another-${tag}@example.com`,
      }),
    (err: unknown) => err instanceof BootstrapError && err.statusCode === 409
  );
  await assert.rejects(
    () =>
      bootstrapFirstOwnerDirect({
        db,
        organizationId: orgTokenId,
        userEmail: founderEmail,
      }),
    (err: unknown) => err instanceof BootstrapError && err.statusCode === 409
  );

  // Last-owner demotion and removal remain enforced
  await assert.rejects(
    () =>
      store.updateMemberRole({
        organizationId: orgTokenId,
        actorUserId: founder.user.id,
        actorName: founder.user.fullName,
        actorRole: 'owner',
        targetUserId: founder.user.id,
        newRole: 'admin',
      }),
    (err: unknown) => err instanceof StoreError && err.statusCode === 409
  );
  await assert.rejects(
    () =>
      store.removeMember({
        organizationId: orgTokenId,
        actorUserId: founder.user.id,
        actorName: founder.user.fullName,
        actorRole: 'owner',
        targetUserId: founder.user.id,
      }),
    (err: unknown) => err instanceof StoreError && err.statusCode === 409
  );

  // 3. Direct bootstrap requires an existing registered user (404 if missing), then succeeds once
  await assert.rejects(
    () =>
      bootstrapFirstOwnerDirect({
        db,
        organizationId: orgDirectId,
        userEmail: `missing-${tag}@example.com`,
      }),
    (err: unknown) => err instanceof BootstrapError && err.statusCode === 404
  );

  const bootResult = await bootstrapFirstOwnerDirect({
    db,
    organizationId: orgDirectId,
    userEmail: founderEmail,
  });
  assert.equal(bootResult.ownerUserId, founder.user.id);
  const directStatus = await inspectOrganizationOwnership(db, orgDirectId);
  assert.equal(directStatus.activeOwnerCount, 1);
  assert.equal(directStatus.requiresFirstOwnerBootstrap, false);
});

test(
  'Scheduled maintenance cleans expired tokens, sessions, invitations, rate buckets, orphaned docs & temp files idempotently while preserving valid records',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    const { db } = getTestDbAndPool();
    const tag = uniqueRunTag();
  const orgId = `org-maint-${tag}`;
  const userId = `usr-maint-${tag}`;
  createdOrgIds.push(orgId);
  createdUserIds.push(userId);

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norus-maint-storage-'));
  tempDirs.push(storageDir);
  const storageProvider = new LocalPrivateStorageProvider(storageDir);

  const now = new Date();
  const past2h = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const past10d = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const past40d = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
  const future2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  await db.insert(organizations).values({
    id: orgId,
    slug: `maint-${tag}`,
    name: `Maint Org ${tag}`,
    countryCode: 'IN',
    defaultCurrency: 'INR',
    taxRegime: 'INDIA_GST',
    defaultTaxCreditable: true,
    uomAliases: { nos: 'pcs' },
  });

  await db.insert(users).values({
    id: userId,
    email: `maint-${tag}@example.com`,
    passwordHash: 'placeholder',
    fullName: 'Maint Test User',
    title: 'Buyer',
    emailVerified: false,
    emailVerificationTokenHash: sha256Hex(`ev-${tag}`),
    emailVerificationExpiresAt: past2h,
    passwordResetTokenHash: sha256Hex(`pr-${tag}`),
    passwordResetExpiresAt: past2h,
    lastActiveOrgId: orgId,
  });

  await db.insert(organizationMemberships).values({
    id: `mem-maint-${tag}`,
    organizationId: orgId,
    userId,
    role: 'owner',
    status: 'active',
  });

  const expSessionId = `ses-exp-${tag}`;
  const revOldSessionId = `ses-revold-${tag}`;
  const validSessionId = `ses-valid-${tag}`;
  await db.insert(sessions).values([
    {
      id: expSessionId,
      userId,
      activeOrganizationId: orgId,
      tokenHash: sha256Hex(`s1-${tag}`),
      csrfToken: 'c1',
      authMethod: 'password',
      expiresAt: past2h,
      lastSeenAt: past2h,
    },
    {
      id: revOldSessionId,
      userId,
      activeOrganizationId: orgId,
      tokenHash: sha256Hex(`s2-${tag}`),
      csrfToken: 'c2',
      authMethod: 'password',
      expiresAt: future2h,
      revokedAt: past10d,
      lastSeenAt: past10d,
    },
    {
      id: validSessionId,
      userId,
      activeOrganizationId: orgId,
      tokenHash: sha256Hex(`s3-${tag}`),
      csrfToken: 'c3',
      authMethod: 'password',
      expiresAt: future2h,
      lastSeenAt: now,
    },
  ]);

  const pendExpInvId = `inv-pendexp-${tag}`;
  const termOldInvId = `inv-termold-${tag}`;
  const validInvId = `inv-valid-${tag}`;
  await db.insert(invitations).values([
    {
      id: pendExpInvId,
      organizationId: orgId,
      email: `p1-${tag}@example.com`,
      role: 'buyer',
      tokenHash: sha256Hex(`i1-${tag}`),
      status: 'pending',
      expiresAt: past2h,
    },
    {
      id: termOldInvId,
      organizationId: orgId,
      email: `p2-${tag}@example.com`,
      role: 'buyer',
      tokenHash: sha256Hex(`i2-${tag}`),
      status: 'revoked',
      expiresAt: past40d,
    },
    {
      id: validInvId,
      organizationId: orgId,
      email: `p3-${tag}@example.com`,
      role: 'buyer',
      tokenHash: sha256Hex(`i3-${tag}`),
      status: 'pending',
      expiresAt: future2h,
    },
  ]);

  const expiredBucketKey = `maint-exp-${tag}`;
  const activeBucketKey = `maint-act-${tag}`;
  createdRateBuckets.push(expiredBucketKey, activeBucketKey);
  await db.insert(rateLimitBuckets).values([
    { bucketKey: expiredBucketKey, hits: 3, resetAt: past2h },
    { bucketKey: activeBucketKey, hits: 1, resetAt: future2h },
  ]);

  // Orphaned stored document older than grace window + stale .tmp file vs active file
  const orphanDocId = `doc-orph-${tag}`;
  const orphanKey = `orgs/${orgId}/docs/${orphanDocId}/orphan.png`;
  await storageProvider.putObject({
    key: orphanKey,
    buffer: createMinimalValidPng(),
    contentType: 'image/png',
  });
  await db.insert(storedDocuments).values({
    id: orphanDocId,
    organizationId: orgId,
    uploadedByUserId: userId,
    storageProvider: 'local',
    storageKey: orphanKey,
    originalFilename: 'orphan.png',
    mimeType: 'image/png',
    byteSize: 67,
    sha256: crypto.createHash('sha256').update(createMinimalValidPng()).digest('hex'),
    createdAt: past2h.toISOString(),
  });

  const staleTmpPath = path.join(storageDir, 'upload.part.tmp');
  fs.writeFileSync(staleTmpPath, 'partial-bytes');
  const past2hSec = past2h.getTime() / 1000;
  fs.utimesSync(staleTmpPath, past2hSec, past2hSec);

  const freshValidFile = path.join(storageDir, 'keep.txt');
  fs.writeFileSync(freshValidFile, 'keep-me');

  const summary1 = await runScheduledMaintenance({
    db,
    storageProvider,
    localStorageDir: storageDir,
    batchSize: 500,
    now,
    orphanGraceMs: 60 * 60 * 1000,
  });

  assert.equal(summary1.errors.length, 0);
  assert.ok(summary1.deletedSessions >= 2);
  assert.ok(summary1.expiredPendingInvitations >= 1);
  assert.ok(summary1.deletedTerminalInvitations >= 1);
  assert.ok(summary1.clearedExpiredVerificationTokens >= 1);
  assert.ok(summary1.clearedExpiredResetTokens >= 1);
  assert.ok(summary1.deletedExpiredRateBuckets >= 1);
  assert.ok(summary1.cleanedOrphanedDocuments >= 1);
  assert.equal(summary1.cleanedTempStorageFiles, 1);

  // Verify valid records preserved & user account preserved with cleared expired tokens
  const [validSess] = await db.select().from(sessions).where(eq(sessions.id, validSessionId));
  assert.ok(validSess);
  const [userAfter] = await db.select().from(users).where(eq(users.id, userId));
  assert.ok(userAfter);
  assert.equal(userAfter.emailVerificationTokenHash, null);
  assert.equal(userAfter.passwordResetTokenHash, null);
  const [pendInvAfter] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.id, pendExpInvId));
  assert.equal(pendInvAfter?.status, 'expired');
  const [validInvAfter] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.id, validInvId));
  assert.equal(validInvAfter?.status, 'pending');
  const [activeBucket] = await db
    .select()
    .from(rateLimitBuckets)
    .where(eq(rateLimitBuckets.bucketKey, activeBucketKey));
  assert.ok(activeBucket);
  const [orphanDocAfter] = await db
    .select()
    .from(storedDocuments)
    .where(eq(storedDocuments.id, orphanDocId));
  assert.equal(orphanDocAfter, undefined);
  await assert.rejects(() => storageProvider.getObject(orphanKey));
  assert.equal(fs.existsSync(staleTmpPath), false);
  assert.equal(fs.existsSync(freshValidFile), true);

  // Second run is strictly idempotent with 0 errors
  const summary2 = await runScheduledMaintenance({
    db,
    storageProvider,
    localStorageDir: storageDir,
    batchSize: 500,
    now,
    orphanGraceMs: 60 * 60 * 1000,
  });
  assert.equal(summary2.errors.length, 0);
  assert.equal(summary2.cleanedTempStorageFiles, 0);
});

test(
  'Operational monitoring: correlation IDs, COOP header, readiness ready/degraded checks, and ErrorTrackerHook redaction',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    const trackedErrors: Array<{ requestId?: string; statusCode: number; message: string }> = [];
  const srv = await startIntegratedTestServer({
    errorTrackerHook: (payload) => {
      trackedErrors.push({
        requestId: payload.requestId,
        statusCode: payload.statusCode,
        message: payload.message,
      });
    },
  });
  const tag = uniqueRunTag();

  try {
    // 1. Custom X-Request-Id echoed + COOP popup header present
    const customReqId = `req-trace-${tag}`;
    const healthRes = await fetch(`${srv.baseUrl}/api/health`, {
      headers: { 'X-Request-Id': customReqId },
    });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('x-request-id'), customReqId);
    assert.equal(
      healthRes.headers.get('cross-origin-opener-policy'),
      'same-origin-allow-popups'
    );

    // 2. Readiness endpoint succeeds (200) and never leaks credentials or connection strings
    const readyRes = await fetch(`${srv.baseUrl}/api/health/ready`);
    assert.equal(readyRes.status, 200);
    const readyText = await readyRes.text();
    assert.equal(readyText.includes('SQL_PASSWORD'), false);
    assert.equal(readyText.includes('secretAccessKey'), false);
    const readyJson = JSON.parse(readyText) as {
      status: string;
      checks: { database: { ok: boolean }; storage: { ok: boolean } };
    };
    assert.equal(readyJson.status, 'ready');
    assert.equal(readyJson.checks.database.ok, true);
    assert.equal(readyJson.checks.storage.ok, true);
  } finally {
    await srv.close();
  }

  // 3. Degraded storage readiness returns 503 with redacted error, and unhandled 500 triggers ErrorTrackerHook
  const brokenStorage: ObjectStorageProvider = {
    mode: 's3',
    async checkReadiness() {
      return { ok: false, error: 'S3 check failed with secretAccessKey=my_raw_secret_123' };
    },
    async putObject() {},
    async getObject() {
      throw new Error('storage down Bearer raw_token_abc123');
    },
    async deleteObject() {},
    async createSignedDownloadUrl() {
      throw new Error('storage down');
    },
  };

  const degradedSrv = await startIntegratedTestServer({
    storageProvider: brokenStorage,
    errorTrackerHook: (payload) => {
      trackedErrors.push({
        requestId: payload.requestId,
        statusCode: payload.statusCode,
        message: payload.message,
      });
    },
  });

  try {
    const degradedRes = await fetch(`${degradedSrv.baseUrl}/api/health/ready`);
    assert.equal(degradedRes.status, 503);
    const degradedBody = (await degradedRes.json()) as {
      status: string;
      checks: { storage: { ok: boolean; error?: string } };
    };
    assert.equal(degradedBody.status, 'degraded');
    assert.equal(degradedBody.checks.storage.ok, false);
    assert.equal(degradedBody.checks.storage.error?.includes('my_raw_secret_123'), false);

    // Trigger unhandled 500 during document download check via registered user + signed URL or error hook
    const client = new TestCookieClient(degradedSrv.baseUrl);
    const reg = await client.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `mon-${tag}@example.com`,
        password: 'StrongPassword#2026!',
        fullName: 'Monitoring Tester',
        organizationName: `Monitor Org ${tag}`,
      }),
    });
    assert.equal(reg.status, 201);
    const regJson = (await reg.json()) as {
      user: { id: string };
      activeOrganization: { id: string };
    };
    createdUserIds.push(regJson.user.id);
    createdOrgIds.push(regJson.activeOrganization.id);

    const supRes = await client.request('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mon Vendor', taxId: `27MON${tag.slice(0, 6).toUpperCase()}Z1` }),
    });
    const sup = (await supRes.json()) as { id: string };

    const rfqRes = await client.request('/api/rfqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Mon RFQ',
        items: [{ description: 'Test Valve', quantity: 1, uom: 'pcs' }],
      }),
    });
    const rfq = (await rfqRes.json()) as { id: string };

    const form = new FormData();
    form.append('supplierId', sup.id);
    form.append(
      'file',
      new Blob([new Uint8Array(createMinimalValidPng())], { type: 'image/png' }),
      'quote.png'
    );
    const exRes = await client.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
      method: 'POST',
      body: form,
    });
    assert.equal(exRes.status, 201);
    const qJson = (await exRes.json()) as { documentId: string };

    const docRes = await client.request(`/api/documents/${qJson.documentId}/content`, {
      headers: { 'X-Request-Id': `err-trace-${tag}` },
    });
    assert.equal(docRes.status, 500);
    const errJson = (await docRes.json()) as { error: string; requestId: string };
    assert.equal(errJson.error, 'Internal server error.');
    assert.equal(errJson.requestId, `err-trace-${tag}`);
    assert.ok(
      trackedErrors.some(
        (e) =>
          e.requestId === `err-trace-${tag}` &&
          e.statusCode === 500 &&
          !e.message.includes('raw_token_abc123')
      )
    );
  } finally {
    await degradedSrv.close();
  }
});

test('Task 005 regression: verifyFirebaseIdToken defaults checkRevoked=false, enforces aud/iss, and avoids host-project Identity Toolkit lookup errors', async () => {
  const prevCheckRevoked = process.env.FIREBASE_CHECK_REVOKED;
  delete process.env.FIREBASE_CHECK_REVOKED;

  const originalVerify = adminAuth.verifyIdToken.bind(adminAuth);
  const mutableAdminAuth = adminAuth as unknown as {
    verifyIdToken: typeof adminAuth.verifyIdToken;
  };

  try {
    // 1. Live default path with malformed JWT fails strictly on local JWT decoding (not Identity Toolkit 344782474303)
    await assert.rejects(
      () => verifyFirebaseIdToken('not.a.valid-jwt'),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(!msg.includes('identitytoolkit.googleapis.com'));
        assert.ok(!msg.includes('344782474303'));
        return true;
      }
    );

    if (isSafeTestDbConfigured()) {
      const realSrv = await startIntegratedTestServer();
      try {
        const client = new TestCookieClient(realSrv.baseUrl);
        const res = await client.request('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: 'not.a.valid-jwt' }),
        });
        assert.equal(res.status, 401);
        const errJson = (await res.json()) as { error: string };
        assert.ok(errJson.error.length > 0);
        assert.ok(!errJson.error.includes('identitytoolkit.googleapis.com'));
        assert.ok(!errJson.error.includes('344782474303'));
      } finally {
        await realSrv.close();
      }
    }

    // 2. Verify checkRevoked defaults to false, opts in when FIREBASE_CHECK_REVOKED=true, and validates aud/iss
    const seenCheckRevoked: Array<boolean | undefined> = [];
    mutableAdminAuth.verifyIdToken = (async (_token: string, checkRevoked?: boolean) => {
      seenCheckRevoked.push(checkRevoked);
      return {
        uid: 'uid-task005',
        email: 'founder@example.com',
        email_verified: true,
        aud: 'favorable-emblem-zxq1s',
        iss: 'https://securetoken.google.com/favorable-emblem-zxq1s',
      } as Awaited<ReturnType<typeof originalVerify>>;
    }) as typeof adminAuth.verifyIdToken;

    const okDecoded = await verifyFirebaseIdToken('fake.header.sig');
    assert.equal(okDecoded.uid, 'uid-task005');
    assert.equal(seenCheckRevoked[0], false);

    process.env.FIREBASE_CHECK_REVOKED = 'true';
    await verifyFirebaseIdToken('fake.header.sig');
    assert.equal(seenCheckRevoked[1], true);

    delete process.env.FIREBASE_CHECK_REVOKED;

    mutableAdminAuth.verifyIdToken = (async () =>
      ({
        uid: 'uid-bad-aud',
        aud: 'wrong-project',
        iss: 'https://securetoken.google.com/favorable-emblem-zxq1s',
      }) as Awaited<ReturnType<typeof originalVerify>>) as typeof adminAuth.verifyIdToken;

    await assert.rejects(
      () => verifyFirebaseIdToken('fake.header.sig'),
      /audience mismatch/i
    );

    mutableAdminAuth.verifyIdToken = (async () =>
      ({
        uid: 'uid-bad-iss',
        aud: 'favorable-emblem-zxq1s',
        iss: 'https://securetoken.google.com/wrong-project',
      }) as Awaited<ReturnType<typeof originalVerify>>) as typeof adminAuth.verifyIdToken;

    await assert.rejects(
      () => verifyFirebaseIdToken('fake.header.sig'),
      /issuer mismatch/i
    );
  } finally {
    mutableAdminAuth.verifyIdToken = originalVerify;
    if (prevCheckRevoked === undefined) {
      delete process.env.FIREBASE_CHECK_REVOKED;
    } else {
      process.env.FIREBASE_CHECK_REVOKED = prevCheckRevoked;
    }
  }
});
