import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupTestOrganizationsAndUsers,
  closeTestDbPool,
  createMinimalValidPng,
  isSafeTestDbConfigured,
  startIntegratedTestServer,
  TEST_DB_SKIP_REASON,
  TestCookieClient,
  uniqueRunTag,
} from './_helpers.ts';

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

after(async () => {
  await cleanupTestOrganizationsAndUsers({
    orgIds: createdOrgIds,
    userIds: createdUserIds,
  });
  await closeTestDbPool();
});

test(
  'Authentication lifecycle: register, verify email, password reset revokes sessions, Google Sign-In, sessions list & revoke, CSRF/CORS/headers & brute-force rate limit',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
  const srv = await startIntegratedTestServer({ authRateLimitMax: 4 });
  const tag = uniqueRunTag();
  const email = `auth-${tag}@example.com`;
  const password = 'SecurePass#2026!';

  try {
    // 1. Unauthenticated requests must be rejected with 401 and include security headers
    const unauthWs = await fetch(`${srv.baseUrl}/api/workspace`);
    assert.equal(unauthWs.status, 401);
    assert.equal(unauthWs.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(unauthWs.headers.get('x-frame-options'), 'SAMEORIGIN');

    // Untrusted CORS origin rejected with 403
    const badCors = await fetch(`${srv.baseUrl}/api/health`, {
      headers: { Origin: 'https://evil-attacker.example.com' },
    });
    assert.equal(badCors.status, 403);

    // 2. Weak password rejected (400)
    const weakClient = new TestCookieClient(srv.baseUrl);
    const weakRes = await weakClient.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'short',
        fullName: 'Test Buyer',
      }),
    });
    assert.equal(weakRes.status, 400);

    // 3. Register + capture email verification link from DevOutboxEmailProvider
    const client = new TestCookieClient(srv.baseUrl);
    const regRes = await client.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        fullName: 'Ananya Rao',
        organizationName: `Rao Industries ${tag}`,
      }),
    });
    assert.equal(regRes.status, 201);
    const regBody = (await regRes.json()) as {
      user: { id: string; emailVerified: boolean };
      activeOrganization: { id: string; role: string };
    };
    assert.equal(regBody.user.emailVerified, false);
    createdUserIds.push(regBody.user.id);
    createdOrgIds.push(regBody.activeOrganization.id);

    const verifyEmailMsg = srv.emailProvider.sent.find((m) => m.to === email);
    assert.ok(verifyEmailMsg);
    const verifyTokenMatch = verifyEmailMsg.text.match(/\?verify=([^\s]+)/);
    assert.ok(verifyTokenMatch);

    const verifyRes = await fetch(`${srv.baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: decodeURIComponent(verifyTokenMatch[1]) }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyBody = (await verifyRes.json()) as { user: { emailVerified: boolean } };
    assert.equal(verifyBody.user.emailVerified, true);

    // 4. Duplicate registration returns 409
    const dupRes = await new TestCookieClient(srv.baseUrl).request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        fullName: 'Duplicate',
      }),
    });
    assert.equal(dupRes.status, 409);

    // 5. Missing/wrong CSRF token rejected (403)
    const noCsrfRes = await client.request('/api/rfqs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'wrong-csrf-token',
      },
      body: JSON.stringify({ title: 'Blocked', items: [{ description: 'Item', quantity: 1 }] }),
    });
    assert.equal(noCsrfRes.status, 403);

    // 6. Active sessions listing & password reset revokes prior sessions
    const sessRes = await client.request('/api/auth/sessions');
    assert.equal(sessRes.status, 200);
    const sessList = (await sessRes.json()) as { sessions: Array<{ id: string; isCurrent: boolean }> };
    assert.ok(sessList.sessions.some((s) => s.isCurrent));

    const forgotRes = await fetch(`${srv.baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(forgotRes.status, 200);
    const resetEmail = srv.emailProvider.sent.find(
      (m) => m.to === email && m.subject.includes('Password Reset')
    );
    assert.ok(resetEmail);
    const resetMatch = resetEmail.text.match(/\?reset=([^\s]+)/);
    assert.ok(resetMatch);

    const newPassword = 'NewStrongPassword#2026!';
    const resetRes = await fetch(`${srv.baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: decodeURIComponent(resetMatch[1]),
        newPassword,
      }),
    });
    assert.equal(resetRes.status, 200);

    // Prior session must now be revoked -> 401
    const oldSessionWs = await client.request('/api/workspace');
    assert.equal(oldSessionWs.status, 401);

    // Login with new password succeeds
    const client2 = new TestCookieClient(srv.baseUrl);
    const loginRes = await client2.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: newPassword }),
    });
    assert.equal(loginRes.status, 200);

    // Logout revokes session
    const logoutRes = await client2.request('/api/auth/logout', { method: 'POST' });
    assert.equal(logoutRes.status, 200);
    const afterLogout = await client2.request('/api/workspace');
    assert.equal(afterLogout.status, 401);

    // 7. Google Sign-In token verification (server-side verified via firebaseVerifier)
    const gSrv = await startIntegratedTestServer({
      firebaseVerifier: async (token) => {
        if (token !== 'valid-google-token') throw new Error('Invalid Firebase token');
        return {
          uid: `g-uid-${tag}`,
          email: `google-${tag}@example.com`,
          name: 'Google User',
          email_verified: true,
        };
      },
    });
    try {
      const gClient = new TestCookieClient(gSrv.baseUrl);
      const badGoogle = await gClient.request('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: 'bad-token' }),
      });
      assert.equal(badGoogle.status, 401);

      const okGoogle = await gClient.request('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: 'valid-google-token' }),
      });
      assert.equal(okGoogle.status, 200);
      const gBody = (await okGoogle.json()) as {
        user: { id: string; hasGoogleLinked: boolean };
        activeOrganization: { id: string };
      };
      assert.equal(gBody.user.hasGoogleLinked, true);
      createdUserIds.push(gBody.user.id);
      createdOrgIds.push(gBody.activeOrganization.id);
    } finally {
      await gSrv.close();
    }

    // 8. Brute-force rate limit triggers 429 on /api/auth/login after authRateLimitMax=4
    for (let i = 0; i < 3; i += 1) {
      const attempt = await fetch(`${srv.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'WrongPassword!1' }),
      });
      assert.equal(attempt.status, 401);
    }
    const throttled = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'WrongPassword!1' }),
    });
    assert.equal(throttled.status, 429);
  } finally {
    await srv.close();
  }
});

test(
  'Multi-tenancy isolation, organization switching, last-owner protection, and cross-tenant document blocking',
  { skip: isSafeTestDbConfigured() ? false : TEST_DB_SKIP_REASON },
  async () => {
  const srv = await startIntegratedTestServer();
  const tag = uniqueRunTag();

  try {
    // Tenant A owner
    const clientA = new TestCookieClient(srv.baseUrl);
    const regA = await clientA.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `orgA-${tag}@example.com`,
        password: 'PasswordA#2026!',
        fullName: 'Owner Alpha',
        organizationName: `Alpha Corp ${tag}`,
      }),
    });
    assert.equal(regA.status, 201);
    const bodyA = (await regA.json()) as {
      user: { id: string };
      activeOrganization: { id: string };
    };
    createdUserIds.push(bodyA.user.id);
    createdOrgIds.push(bodyA.activeOrganization.id);

    // Tenant A creates second organization & switches between orgs
    const secondOrgRes = await clientA.request('/api/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Alpha Sub ${tag}`, defaultCurrency: 'USD', taxRegime: 'US_TAX' }),
    });
    assert.equal(secondOrgRes.status, 201);
    const secondOrg = ((await secondOrgRes.json()) as { organization: { id: string } }).organization;
    createdOrgIds.push(secondOrg.id);

    const switchBack = await clientA.request('/api/organizations/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId: bodyA.activeOrganization.id }),
    });
    assert.equal(switchBack.status, 200);

    // Last-owner protection: cannot demote or remove the sole owner
    const demoteOwner = await clientA.request(
      `/api/organizations/current/members/${bodyA.user.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      }
    );
    assert.equal(demoteOwner.status, 409);

    // Tenant A creates RFQ, supplier, and private PNG document quotation
    const supA = await clientA.request('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha Vendor', taxId: `27ALP${tag.slice(0, 6).toUpperCase()}Z1` }),
    });
    assert.equal(supA.status, 201);
    const supplierA = (await supA.json()) as { id: string };

    const rfqARes = await clientA.request('/api/rfqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Secret Alpha BOM',
        items: [{ description: 'Titanium Housing', quantity: 10, uom: 'pcs' }],
      }),
    });
    assert.equal(rfqARes.status, 201);
    const rfqA = (await rfqARes.json()) as { id: string };

    const form = new FormData();
    form.append('supplierId', supplierA.id);
    form.append('file', new Blob([new Uint8Array(createMinimalValidPng())], { type: 'image/png' }), 'secret.png');
    const quoteARes = await clientA.request(`/api/rfqs/${rfqA.id}/quotes/extract`, {
      method: 'POST',
      body: form,
    });
    assert.equal(quoteARes.status, 201);
    const quoteA = (await quoteARes.json()) as { id: string; documentId: string; lines: { id: string }[] };

    // Tenant B owner
    const clientB = new TestCookieClient(srv.baseUrl);
    const regB = await clientB.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `orgB-${tag}@example.com`,
        password: 'PasswordB#2026!',
        fullName: 'Owner Beta',
        organizationName: `Beta Corp ${tag}`,
      }),
    });
    assert.equal(regB.status, 201);
    const bodyB = (await regB.json()) as {
      user: { id: string };
      activeOrganization: { id: string };
    };
    createdUserIds.push(bodyB.user.id);
    createdOrgIds.push(bodyB.activeOrganization.id);

    // Tenant B workspace must NOT include Tenant A data
    const wsBRes = await clientB.request('/api/workspace');
    assert.equal(wsBRes.status, 200);
    const wsB = (await wsBRes.json()) as { rfqs: Array<{ id: string }>; quotations: Array<{ id: string }> };
    assert.equal(wsB.rfqs.some((r) => r.id === rfqA.id), false);
    assert.equal(wsB.quotations.some((q) => q.id === quoteA.id), false);

    // Tenant B attempts to access/mutate/delete Tenant A's quotation, RFQ, and private document -> 404
    const crossEdit = await clientB.request(`/api/quotations/${quoteA.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ freightCharges: 999 }),
    });
    assert.equal(crossEdit.status, 404);

    const crossVerify = await clientB.request(`/api/quotations/${quoteA.id}/verify`, { method: 'POST' });
    assert.equal(crossVerify.status, 404);

    const crossDelete = await clientB.request(`/api/quotations/${quoteA.id}`, { method: 'DELETE' });
    assert.equal(crossDelete.status, 404);

    const crossSignedUrl = await clientB.request(`/api/documents/${quoteA.documentId}/signed-url`);
    assert.equal(crossSignedUrl.status, 404);

    const crossDocContent = await clientB.request(`/api/documents/${quoteA.documentId}/content`);
    assert.equal(crossDocContent.status, 404);

    const crossSwitchOrg = await clientB.request('/api/organizations/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId: bodyA.activeOrganization.id }),
    });
    assert.equal(crossSwitchOrg.status, 403);

    // Deleting unapproved quote in Tenant A removes both DB record and private object storage document
    const delA = await clientA.request(`/api/quotations/${quoteA.id}`, { method: 'DELETE' });
    assert.equal(delA.status, 200);
    const docAfterDelete = await clientA.request(`/api/documents/${quoteA.documentId}/signed-url`);
    assert.equal(docAfterDelete.status, 404);
  } finally {
    await srv.close();
  }
});
