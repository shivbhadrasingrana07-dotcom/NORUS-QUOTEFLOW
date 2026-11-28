import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import test, { after } from 'node:test';
import { like } from 'drizzle-orm';
import { AUTH_RATE_LIMIT_POLICIES, createApp } from '../server.ts';
import { DevOutboxEmailProvider } from '../server/emailService.ts';
import type { ObjectStorageProvider } from '../server/objectStorage.ts';
import { type PgDataStore, type SessionAuthContext } from '../server/pgStore.ts';
import {
  hashEmailRateLimitIdentity,
  MemoryRateLimitStore,
  normalizeEmailForRateLimit,
  PostgresRateLimitStore,
} from '../server/rateLimiter.ts';
import { createInitialWorkspaceState } from '../server/seedData.ts';
import { rateLimitBuckets } from '../src/db/schema.ts';
import type { UserRole } from '../src/types.ts';
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
const createdRateBucketKeys: string[] = [];

after(async () => {
  await cleanupTestOrganizationsAndUsers({
    orgIds: createdOrgIds,
    userIds: createdUserIds,
    rateBucketKeys: createdRateBucketKeys,
  });
  await closeTestDbPool();
});

function createSpyUnitHarness(options: {
  initialEmailVerified?: boolean;
  initialRole?: UserRole;
  authRateLimitMax?: number;
  demoMode?: boolean;
} = {}) {
  const ws = createInitialWorkspaceState();
  const rfq = ws.rfqs[0];
  const supplier = ws.suppliers[0];
  const emailProvider = new DevOutboxEmailProvider();
  const rateLimitStore = new MemoryRateLimitStore(2000);

  let emailVerified = options.initialEmailVerified ?? false;
  const role: UserRole = options.initialRole ?? 'owner';
  let extractReservationCalls = 0;
  let geminiCalls = 0;
  let storagePutCalls = 0;
  let inviteStoreCalls = 0;
  let acceptInviteCalls = 0;

  const mockStorage: ObjectStorageProvider = {
    mode: 'local',
    async putObject() {
      storagePutCalls += 1;
    },
    async getObject() {
      return { buffer: Buffer.alloc(0), contentType: 'application/octet-stream' };
    },
    async deleteObject() {},
    async createSignedDownloadUrl() {
      return { url: '/signed', expiresAt: new Date().toISOString() };
    },
    async checkReadiness() {
      return { ok: true };
    },
  };

  const sessionForToken = (token: string): SessionAuthContext | null => {
    if (token !== 'task021-session') return null;
    return {
      sessionId: 'sess-task021',
      csrfToken: 'task021-csrf',
      user: {
        id: 'usr-task021',
        email: 'Buyer.User@Example.COM'.toLowerCase(),
        fullName: 'Task021 User',
        title: 'Procurement Lead',
        emailVerified,
        hasPassword: true,
        hasGoogleLinked: false,
      },
      activeOrganization: {
        id: 'org-task021',
        slug: 'org-task021',
        name: 'Task021 Org',
        countryCode: 'IN',
        defaultCurrency: 'INR',
        taxRegime: 'INDIA_GST',
        defaultTaxCreditable: true,
        role,
        planTier: 'starter',
      },
      organizations: [],
    };
  };

  const existingEmails = new Set(['existing@example.com']);

  const spyStore = {
    async getSessionContext(token: string) {
      return sessionForToken(token);
    },
    async registerWithPassword(params: { email: string; fullName: string }) {
      const normalized = params.email.trim().toLowerCase();
      existingEmails.add(normalized);
      return {
        sessionId: 'sess-reg',
        rawSessionToken: 'task021-session',
        csrfToken: 'task021-csrf',
        rawVerificationToken: 'verify-tok-1',
        user: {
          id: 'usr-reg',
          email: normalized,
          fullName: params.fullName,
          title: 'Lead',
          emailVerified: false,
          hasPassword: true,
          hasGoogleLinked: false,
        },
        activeOrganization: sessionForToken('task021-session')!.activeOrganization,
        organizations: [],
      };
    },
    async loginWithPassword() {
      const err = new Error('Invalid email or password.') as Error & { statusCode?: number };
      err.statusCode = 401;
      // Throw same StoreError shape via dynamic import below? Return StoreError from pgStore.
      const { StoreError } = await import('../server/pgStore.ts');
      throw new StoreError(401, 'Invalid email or password.');
    },
    async createPasswordResetToken(rawEmail: string) {
      const normalized = rawEmail.trim().toLowerCase();
      if (!existingEmails.has(normalized)) return null;
      return { email: normalized, fullName: 'Existing User', rawToken: 'reset-tok-1' };
    },
    async createEmailVerificationToken() {
      return {
        email: 'buyer.user@example.com',
        fullName: 'Task021 User',
        rawToken: 'verify-tok-resend',
      };
    },
    async verifyEmailByToken(rawToken: string) {
      if (rawToken !== 'valid-verify-token') {
        const { StoreError } = await import('../server/pgStore.ts');
        throw new StoreError(400, 'Verification link is invalid or has expired.');
      }
      emailVerified = true;
      return {
        ...sessionForToken('task021-session')!.user,
        emailVerified: true,
      };
    },
    async resetPasswordByToken() {
      const { StoreError } = await import('../server/pgStore.ts');
      throw new StoreError(400, 'Password reset token is invalid or has expired.');
    },
    async revokeSessionByToken() {},
    async acceptInvitation() {
      acceptInviteCalls += 1;
      return sessionForToken('task021-session')!.activeOrganization!;
    },
    async createInvitation(params: { email: string; role: UserRole }) {
      inviteStoreCalls += 1;
      return {
        invitation: {
          id: `inv-${inviteStoreCalls}`,
          organizationId: 'org-task021',
          email: params.email.trim().toLowerCase(),
          role: params.role,
          status: 'pending' as const,
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          createdAt: new Date().toISOString(),
        },
        rawToken: 'raw-inv-token',
        organizationName: 'Task021 Org',
      };
    },
    async getExtractionContext() {
      return { rfq, settings: ws.settings, supplierName: supplier.name };
    },
    async reserveExtractionAndStorageQuota() {
      extractReservationCalls += 1;
      return { kind: 'reserved' as const, reservationId: 'res-021', periodMonth: '2026-11' };
    },
    async saveExtractedQuotation(params: { quotation: (typeof ws.quotations)[number] }) {
      return params.quotation;
    },
    async releaseExtractionReservation() {},
  } as unknown as PgDataStore;

  return {
    rfq,
    supplier,
    emailProvider,
    rateLimitStore,
    mockStorage,
    spyStore,
    setEmailVerified: (next: boolean) => {
      emailVerified = next;
    },
    getCounts: () => ({
      extractReservationCalls,
      geminiCalls,
      storagePutCalls,
      inviteStoreCalls,
      acceptInviteCalls,
    }),
    async start() {
      const app = await createApp({
        enableVite: false,
        demoMode: options.demoMode ?? false,
        db: {} as never,
        rateLimitStore,
        emailProvider,
        store: spyStore,
        storageProvider: mockStorage,
        authRateLimitMax: options.authRateLimitMax,
        firebaseVerifier: async (tok) => {
          if (tok === 'good-google-verified') {
            return {
              uid: 'g-verified',
              email: 'g@example.com',
              name: 'Google Verified',
              email_verified: true,
            };
          }
          throw new Error('Invalid Firebase token');
        },
        generateContentOverride: async () => {
          geminiCalls += 1;
          return {
            text: JSON.stringify({
              quoteReference: 'TASK021-Q',
              currency: 'INR',
              taxIncludedInRates: false,
              missingFreightWarning: false,
              lines: [],
            }),
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 50,
              totalTokenCount: 150,
            },
          };
        },
      });
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: async () => {
          await new Promise<void>((resolve, reject) => {
            server.closeAllConnections?.();
            server.close((err) => (err ? reject(err) : resolve()));
          });
        },
      };
    },
  };
}

test('Task 021 unit: email rate-limit normalization & hashing collapses case/whitespace and excludes malformed values', () => {
  assert.equal(normalizeEmailForRateLimit('  Alice.Smith@Example.COM '), 'alice.smith@example.com');
  assert.equal(normalizeEmailForRateLimit('alice.smith@example.com'), 'alice.smith@example.com');
  assert.equal(
    hashEmailRateLimitIdentity('alice.smith@example.com'),
    hashEmailRateLimitIdentity(normalizeEmailForRateLimit('  Alice.Smith@Example.COM ')!)
  );
  assert.equal(normalizeEmailForRateLimit('not-an-email'), null);
  assert.equal(normalizeEmailForRateLimit('   '), null);
  assert.equal(normalizeEmailForRateLimit(null), null);
  assert.equal(normalizeEmailForRateLimit(`${'a'.repeat(320)}@example.com`), null);
});

test('Task 021 HTTP route unit: unverified email is blocked (403 EMAIL_VERIFICATION_REQUIRED) on AI extraction and invitations, spoof-resistant, and unblocked after verification', async () => {
  const harness = createSpyUnitHarness({
    initialEmailVerified: false,
    initialRole: 'owner',
    demoMode: true,
  });
  const srv = await harness.start();

  const authHeaders = {
    Cookie: 'nf_session=task021-session',
    'X-CSRF-Token': 'task021-csrf',
  };

  try {
    // 1. /api/auth/me remains accessible and shows emailVerified: false
    const meRes = await fetch(`${srv.baseUrl}/api/auth/me`, {
      headers: { Cookie: 'nf_session=task021-session' },
    });
    assert.equal(meRes.status, 200);
    const meBody = (await meRes.json()) as { user: { emailVerified: boolean } };
    assert.equal(meBody.user.emailVerified, false);

    // 2. Unverified owner can resend verification & accept invitations
    const resendRes = await fetch(`${srv.baseUrl}/api/auth/resend-verification`, {
      method: 'POST',
      headers: authHeaders,
    });
    assert.equal(resendRes.status, 200);
    assert.equal(harness.emailProvider.sent.length, 1);

    const acceptRes = await fetch(`${srv.baseUrl}/api/invitations/accept`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'inv-tok-1' }),
    });
    assert.equal(acceptRes.status, 200);
    assert.equal(harness.getCounts().acceptInviteCalls, 1);

    // 3. Unverified user CANNOT trigger AI quotation extraction (even if spoofing emailVerified=true in body/headers)
    const extractForm = new FormData();
    extractForm.set('supplierId', harness.supplier.id);
    extractForm.set('emailVerified', 'true');
    extractForm.set(
      'file',
      new Blob([new Uint8Array(createMinimalValidPng())], { type: 'image/png' }),
      'quote.png'
    );
    const blockedExtract = await fetch(`${srv.baseUrl}/api/rfqs/${harness.rfq.id}/quotes/extract`, {
      method: 'POST',
      headers: { ...authHeaders, 'X-Email-Verified': 'true' },
      body: extractForm,
    });
    assert.equal(blockedExtract.status, 403);
    const blockedExtractJson = (await blockedExtract.json()) as { code?: string; error: string };
    assert.equal(blockedExtractJson.code, 'EMAIL_VERIFICATION_REQUIRED');
    assert.equal(harness.getCounts().extractReservationCalls, 0);
    assert.equal(harness.getCounts().geminiCalls, 0);
    assert.equal(harness.getCounts().storagePutCalls, 0);

    // 4. Unverified owner CANNOT issue external team invitations
    const blockedInvite = await fetch(`${srv.baseUrl}/api/organizations/current/invitations`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'colleague@example.com',
        role: 'buyer',
        emailVerified: true,
      }),
    });
    assert.equal(blockedInvite.status, 403);
    const blockedInviteJson = (await blockedInvite.json()) as { code?: string };
    assert.equal(blockedInviteJson.code, 'EMAIL_VERIFICATION_REQUIRED');
    assert.equal(harness.getCounts().inviteStoreCalls, 0);
    assert.equal(harness.emailProvider.sent.length, 1);

    // 5. Demo mode synthetic extraction remains usable without email verification
    const demoRes = await fetch(`${srv.baseUrl}/api/demo-workspace`);
    assert.equal(demoRes.status, 200);
    const demoBody = (await demoRes.json()) as {
      demoSessionId: string;
      rfqs: Array<{ id: string }>;
      suppliers: Array<{ id: string }>;
    };
    const demoForm = new FormData();
    demoForm.set('supplierId', demoBody.suppliers[0].id);
    demoForm.set('rawEmailText', 'SS Valve 10 pcs @ 2500');
    const demoExtractRes = await fetch(
      `${srv.baseUrl}/api/demo-workspace/rfqs/${demoBody.rfqs[0].id}/quotes/extract`,
      {
        method: 'POST',
        headers: { 'X-Demo-Session': demoBody.demoSessionId },
        body: demoForm,
      }
    );
    assert.equal(demoExtractRes.status, 201);

    // 6. Verify email -> extraction and invitation succeed immediately on next request
    const verifyRes = await fetch(`${srv.baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'valid-verify-token' }),
    });
    assert.equal(verifyRes.status, 200);

    const geminiCallsBeforeVerified = harness.getCounts().geminiCalls;
    const okForm = new FormData();
    okForm.set('supplierId', harness.supplier.id);
    okForm.set('rawEmailText', 'Verified email quote');
    const okExtract = await fetch(`${srv.baseUrl}/api/rfqs/${harness.rfq.id}/quotes/extract`, {
      method: 'POST',
      headers: authHeaders,
      body: okForm,
    });
    assert.equal(okExtract.status, 201);
    assert.equal(harness.getCounts().extractReservationCalls, 1);
    assert.equal(harness.getCounts().geminiCalls, geminiCallsBeforeVerified + 1);

    const okInvite = await fetch(`${srv.baseUrl}/api/organizations/current/invitations`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'colleague@example.com', role: 'buyer' }),
    });
    assert.equal(okInvite.status, 201);
    assert.equal(harness.getCounts().inviteStoreCalls, 1);
    assert.equal(harness.emailProvider.sent.length, 2);
  } finally {
    await srv.close();
  }
});

test('Task 021 HTTP route unit: RBAC role enforcement stays intact for verified and unverified viewer roles', async () => {
  const harness = createSpyUnitHarness({
    initialEmailVerified: true,
    initialRole: 'viewer',
  });
  const srv = await harness.start();
  const authHeaders = {
    Cookie: 'nf_session=task021-session',
    'X-CSRF-Token': 'task021-csrf',
  };

  try {
    const f = new FormData();
    f.set('supplierId', harness.supplier.id);
    f.set('rawEmailText', 'Viewer attempt');
    const viewerExtract = await fetch(`${srv.baseUrl}/api/rfqs/${harness.rfq.id}/quotes/extract`, {
      method: 'POST',
      headers: authHeaders,
      body: f,
    });
    assert.equal(viewerExtract.status, 403);
    assert.equal(harness.getCounts().extractReservationCalls, 0);

    harness.setEmailVerified(false);
    const unverifiedViewerInvite = await fetch(
      `${srv.baseUrl}/api/organizations/current/invitations`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'other@example.com', role: 'buyer' }),
      }
    );
    assert.equal(unverifiedViewerInvite.status, 403);
    const body = (await unverifiedViewerInvite.json()) as { error: string; code?: string };
    assert.match(body.error, /permission/i);
    assert.equal(body.code, undefined);
  } finally {
    await srv.close();
  }
});

test('Task 021 HTTP route unit: per-normalized-email & per-IP rate limiting across auth endpoints with account non-enumeration and Retry-After headers', async () => {
  const harness = createSpyUnitHarness({ initialEmailVerified: false });
  const srv = await harness.start();

  try {
    // 1. Distributed brute force on /api/auth/login across distinct IPs using case/whitespace variants of same email
    const targetEmailVariants = [
      'victim@example.com',
      '  VICTIM@Example.com ',
      'Victim@example.COM',
      'victim@EXAMPLE.com  ',
    ];
    for (let i = 0; i < AUTH_RATE_LIMIT_POLICIES.login.emailMax; i += 1) {
      const res = await fetch(`${srv.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `198.51.100.${10 + i}`,
        },
        body: JSON.stringify({
          email: targetEmailVariants[i % targetEmailVariants.length],
          password: 'WrongPassword1',
        }),
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('x-ratelimit-limit') !== null, true);
      assert.equal(res.headers.get('x-ratelimit-remaining') !== null, true);
    }

    // 11th login attempt from yet another IP is blocked (429) with Retry-After
    const emailThrottled = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.200',
      },
      body: JSON.stringify({
        email: 'victim@example.com',
        password: 'WrongPassword1',
      }),
    });
    assert.equal(emailThrottled.status, 429);
    assert.ok(Number(emailThrottled.headers.get('retry-after')) >= 1);

    // Unrelated user from that same IP is NOT affected by victim's per-email limit
    const unrelatedLogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.200',
      },
      body: JSON.stringify({
        email: 'unrelated-user@example.com',
        password: 'WrongPassword1',
      }),
    });
    assert.equal(unrelatedLogin.status, 401);

    // 2. Single IP spraying distinct emails triggers /api/auth/login per-IP limit (25)
    for (let i = 0; i < AUTH_RATE_LIMIT_POLICIES.login.ipMax; i += 1) {
      const res = await fetch(`${srv.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.55',
        },
        body: JSON.stringify({
          email: `spray-${i}@example.com`,
          password: 'WrongPassword1',
        }),
      });
      assert.equal(res.status, 401);
    }
    const ipBlockedLogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.55',
      },
      body: JSON.stringify({
        email: 'fresh-innocent@example.com',
        password: 'WrongPassword1',
      }),
    });
    assert.equal(ipBlockedLogin.status, 429);
    // Blocked IP short-circuited before touching fresh-innocent@example.com's email bucket!
    const innocentElsewhere = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.56',
      },
      body: JSON.stringify({
        email: 'fresh-innocent@example.com',
        password: 'WrongPassword1',
      }),
    });
    assert.equal(innocentElsewhere.status, 401);

    // 3. /api/auth/forgot-password enforces per-email limit identically for existing & non-existent accounts (non-enumeration)
    for (const targetEmail of ['Existing@Example.COM', 'DoesNotExist@Example.COM']) {
      for (let i = 0; i < AUTH_RATE_LIMIT_POLICIES.forgotPassword.emailMax; i += 1) {
        const res = await fetch(`${srv.baseUrl}/api/auth/forgot-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': `198.51.101.${10 + i}`,
          },
          body: JSON.stringify({ email: i % 2 === 0 ? targetEmail : ` ${targetEmail.toLowerCase()} ` }),
        });
        assert.equal(res.status, 200);
      }
      const blockedForgot = await fetch(`${srv.baseUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.101.99',
        },
        body: JSON.stringify({ email: targetEmail }),
      });
      assert.equal(blockedForgot.status, 429);
      assert.ok(Number(blockedForgot.headers.get('retry-after')) >= 1);
    }

    // 4. /api/auth/register enforces per-email limit across rotating IPs
    for (let i = 0; i < AUTH_RATE_LIMIT_POLICIES.register.emailMax; i += 1) {
      const res = await fetch(`${srv.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `198.51.102.${10 + i}`,
        },
        body: JSON.stringify({
          email: i % 2 === 0 ? 'RegTarget@Example.COM' : '  regtarget@example.com ',
          password: 'StrongPassword#2026!',
          fullName: 'Reg Tester',
        }),
      });
      assert.equal(res.status, 201);
    }
    const blockedReg = await fetch(`${srv.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.102.99',
      },
      body: JSON.stringify({
        email: 'regtarget@example.com',
        password: 'StrongPassword#2026!',
        fullName: 'Reg Tester',
      }),
    });
    assert.equal(blockedReg.status, 429);

    // 5. /api/auth/verify-email, /api/auth/reset-password, /api/auth/google, /api/auth/resend-verification
    for (let i = 0; i < AUTH_RATE_LIMIT_POLICIES.verifyEmail.ipMax; i += 1) {
      const res = await fetch(`${srv.baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.103.1' },
        body: JSON.stringify({ token: `bad-${i}` }),
      });
      assert.equal(res.status, 400);
    }
    const blockedVerify = await fetch(`${srv.baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.103.1' },
      body: JSON.stringify({ token: 'bad-overflow' }),
    });
    assert.equal(blockedVerify.status, 429);

    for (let i = 0; i < AUTH_RATE_LIMIT_POLICIES.resetPassword.ipMax; i += 1) {
      const res = await fetch(`${srv.baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.104.1' },
        body: JSON.stringify({ token: `bad-${i}`, newPassword: 'StrongPassword#2026!' }),
      });
      assert.equal(res.status, 400);
    }
    const blockedReset = await fetch(`${srv.baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.104.1' },
      body: JSON.stringify({ token: 'bad-overflow', newPassword: 'StrongPassword#2026!' }),
    });
    assert.equal(blockedReset.status, 429);

    for (let i = 0; i < AUTH_RATE_LIMIT_POLICIES.resendVerification.accountMax; i += 1) {
      const res = await fetch(`${srv.baseUrl}/api/auth/resend-verification`, {
        method: 'POST',
        headers: {
          Cookie: 'nf_session=task021-session',
          'X-CSRF-Token': 'task021-csrf',
          'X-Forwarded-For': `198.51.105.${10 + i}`,
        },
      });
      assert.equal(res.status, 200);
    }
    const blockedResend = await fetch(`${srv.baseUrl}/api/auth/resend-verification`, {
      method: 'POST',
      headers: {
        Cookie: 'nf_session=task021-session',
        'X-CSRF-Token': 'task021-csrf',
        'X-Forwarded-For': '198.51.105.99',
      },
    });
    assert.equal(blockedResend.status, 429);
  } finally {
    await srv.close();
  }
});

test(
  'Task 021 PostgreSQL integration: end-to-end verification gating, Google verified/unverified parity, and shared PostgresRateLimitStore hashed email buckets',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
    const tag = uniqueRunTag();
    const { db } = getTestDbAndPool();
    const pgRateStore = new PostgresRateLimitStore(db);

    const srv = await startIntegratedTestServer({
      rateLimitStore: pgRateStore,
      firebaseVerifier: async (token) => {
        if (token === 'google-verified') {
          return {
            uid: `g-ver-${tag}`,
            email: `gver-${tag}@example.com`,
            name: 'Google Verified',
            email_verified: true,
          };
        }
        if (token === 'google-unverified') {
          return {
            uid: `g-unver-${tag}`,
            email: `gunver-${tag}@example.com`,
            name: 'Google Unverified',
            email_verified: false,
          };
        }
        throw new Error('Invalid token');
      },
    });

    try {
      // 1. Password signup starts unverified -> blocked on invites & extraction until email verified
      const pwEmail = `pg021-${tag}@example.com`;
      const pwClient = new TestCookieClient(srv.baseUrl);
      const regRes = await pwClient.request('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.200.1',
        },
        body: JSON.stringify({
          email: pwEmail,
          password: 'StrongPassword#2026!',
          fullName: 'PG Verification User',
          organizationName: `PG021 Org ${tag}`,
        }),
      });
      assert.equal(regRes.status, 201);
      const regBody = (await regRes.json()) as {
        user: { id: string; emailVerified: boolean };
        activeOrganization: { id: string };
      };
      assert.equal(regBody.user.emailVerified, false);
      createdUserIds.push(regBody.user.id);
      createdOrgIds.push(regBody.activeOrganization.id);

      const sup = (await (
        await pwClient.request('/api/suppliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `Vendor-${tag}`, taxId: `27PG${tag.slice(0, 6).toUpperCase()}Z1` }),
        })
      ).json()) as { id: string };
      const rfq = (await (
        await pwClient.request('/api/rfqs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `PG021 RFQ ${tag}`,
            items: [{ description: 'Valve', quantity: 5, uom: 'pcs' }],
          }),
        })
      ).json()) as { id: string };

      const formUnverified = new FormData();
      formUnverified.set('supplierId', sup.id);
      formUnverified.set('rawEmailText', 'Valve 5 pcs @ 100');
      const blockedEx = await pwClient.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        body: formUnverified,
      });
      assert.equal(blockedEx.status, 403);
      assert.equal(((await blockedEx.json()) as { code?: string }).code, 'EMAIL_VERIFICATION_REQUIRED');

      const blockedInv = await pwClient.request('/api/organizations/current/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `invitee-${tag}@example.com`, role: 'buyer' }),
      });
      assert.equal(blockedInv.status, 403);
      assert.equal(((await blockedInv.json()) as { code?: string }).code, 'EMAIL_VERIFICATION_REQUIRED');

      // Verify via queued verification token
      const sentVerify = srv.emailProvider.sent.find((m) => m.to === pwEmail);
      assert.ok(sentVerify);
      const token = decodeURIComponent(sentVerify.text.match(/\?verify=([^\s]+)/)![1]);
      const verRes = await fetch(`${srv.baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.200.1',
        },
        body: JSON.stringify({ token }),
      });
      assert.equal(verRes.status, 200);

      // Re-trying extraction & invitation now succeeds
      const formVerified = new FormData();
      formVerified.set('supplierId', sup.id);
      formVerified.set('rawEmailText', 'Valve 5 pcs @ 100');
      const okEx = await pwClient.request(`/api/rfqs/${rfq.id}/quotes/extract`, {
        method: 'POST',
        body: formVerified,
      });
      assert.equal(okEx.status, 201);

      const okInv = await pwClient.request('/api/organizations/current/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `invitee-${tag}@example.com`, role: 'buyer' }),
      });
      assert.equal(okInv.status, 201);

      // 2. Google Sign-In verified vs unverified
      const gVerClient = new TestCookieClient(srv.baseUrl);
      const gVerRes = await gVerClient.request('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.200.2' },
        body: JSON.stringify({ idToken: 'google-verified' }),
      });
      assert.equal(gVerRes.status, 200);
      const gVerBody = (await gVerRes.json()) as {
        user: { id: string; emailVerified: boolean };
        activeOrganization: { id: string };
      };
      assert.equal(gVerBody.user.emailVerified, true);
      createdUserIds.push(gVerBody.user.id);
      createdOrgIds.push(gVerBody.activeOrganization.id);

      const gVerInv = await gVerClient.request('/api/organizations/current/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `ginv-${tag}@example.com`, role: 'viewer' }),
      });
      assert.equal(gVerInv.status, 201);

      const gUnverClient = new TestCookieClient(srv.baseUrl);
      const gUnverRes = await gUnverClient.request('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.200.3' },
        body: JSON.stringify({ idToken: 'google-unverified' }),
      });
      assert.equal(gUnverRes.status, 200);
      const gUnverBody = (await gUnverRes.json()) as {
        user: { id: string; emailVerified: boolean };
        activeOrganization: { id: string };
      };
      assert.equal(gUnverBody.user.emailVerified, false);
      createdUserIds.push(gUnverBody.user.id);
      createdOrgIds.push(gUnverBody.activeOrganization.id);

      const gUnverBlockedInv = await gUnverClient.request('/api/organizations/current/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `gunvinv-${tag}@example.com`, role: 'viewer' }),
      });
      assert.equal(gUnverBlockedInv.status, 403);

      // 3. PostgresRateLimitStore enforces per-email limit across instances & stores SHA-256 hash (no raw PII email)
      const rateTargetEmail = `RateTarget-${tag}@Example.com`;
      const emailBucketHash = hashEmailRateLimitIdentity(rateTargetEmail.trim().toLowerCase());
      const expectedEmailBucketKey = `auth:email:login:${emailBucketHash}`;
      createdRateBucketKeys.push(expectedEmailBucketKey);

      for (let i = 0; i < AUTH_RATE_LIMIT_POLICIES.login.emailMax; i += 1) {
        const ip = `198.51.201.${10 + i}`;
        createdRateBucketKeys.push(`auth:ip:login:${ip}`);
        const attempt = await fetch(`${srv.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
          body: JSON.stringify({ email: rateTargetEmail, password: 'WrongPassword1!' }),
        });
        assert.equal(attempt.status, 401);
      }

      const finalIp = '198.51.201.99';
      createdRateBucketKeys.push(`auth:ip:login:${finalIp}`);
      const blockedPg = await fetch(`${srv.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': finalIp },
        body: JSON.stringify({ email: `  ${rateTargetEmail.toLowerCase()} `, password: 'WrongPassword1!' }),
      });
      assert.equal(blockedPg.status, 429);

      const allMatching = await db
        .select()
        .from(rateLimitBuckets)
        .where(like(rateLimitBuckets.bucketKey, `%${emailBucketHash}%`));
      assert.equal(allMatching.length, 1);
      assert.equal(allMatching[0].bucketKey, expectedEmailBucketKey);
      assert.equal(allMatching[0].bucketKey.includes(rateTargetEmail.toLowerCase()), false);
    } finally {
      await srv.close();
    }
  }
);
