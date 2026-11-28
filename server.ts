import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { pathToFileURL } from 'url';
import { createServer as createViteServer } from 'vite';
import type { AiTokenUsageTelemetry } from './src/types.ts';
import {
  db as defaultDb,
  type DrizzleDb,
  isSqlEnvConfigured,
  pool as defaultPool,
  validateProductionSqlConfig,
} from './src/db/index.ts';
import { createEmailProvider, type EmailProvider } from './server/emailService.ts';
import { validateUploadedFile } from './server/fileSecurity.ts';
import {
  verifyFirebaseIdToken,
  type FirebaseTokenVerifier,
  type VerifiedFirebaseUser,
} from './server/firebase-admin.ts';
import {
  ExtractionServiceError,
  extractQuotationWithGemini,
  extractQuotationWithTelemetry,
  GEMINI_EXTRACTION_MODEL,
  parseSpreadsheetBufferIsolated,
  type GenerateContentFn,
  type ParsedSpreadsheetResult,
} from './server/geminiExtractor.ts';
import {
  QuotaExceededError,
  validateOptionalIdempotencyKey,
} from './server/usagePolicy.ts';
import { runScheduledMaintenance } from './server/maintenance.ts';
import {
  checkDependencyReadiness,
  createCorrelationMiddleware,
  dispatchErrorTrackerHook,
  type ErrorTrackerHook,
  isGoogleAuthConfigured,
  logEvent,
} from './server/monitoring.ts';
import {
  buildDocumentStorageKey,
  createObjectStorageProvider,
  type ObjectStorageProvider,
  verifySignedDocumentToken,
} from './server/objectStorage.ts';
import { PgDataStore, type SessionAuthContext, StoreError } from './server/pgStore.ts';
import {
  createMultiKeyRateLimitMiddleware,
  createRateLimitMiddleware,
  getClientIp,
  hashEmailRateLimitIdentity,
  MemoryRateLimitStore,
  normalizeEmailForRateLimit,
  PostgresRateLimitStore,
  type RateLimitStore,
} from './server/rateLimiter.ts';
import { hasPermission, type Permission } from './server/rbac.ts';
import {
  clearAuthCookies,
  generateSecureToken,
  getSigningSecret,
  isPlaceholderSecret,
  normalizeOptionalEnvValue,
  parseCookies,
  redactSensitiveText,
  resolveCookieSameSite,
  SESSION_COOKIE_NAME,
  setAuthCookies,
  signHmac,
  stripSurroundingQuotes,
  verifyHmac,
} from './server/security.ts';
import {
  DEMO_ORGANIZATION_SUMMARY,
  DEMO_USER,
  DemoStoreError,
  DemoWorkspaceStore,
  extractDemoQuotationOffline,
} from './server/demoWorkspace.ts';

declare global {
  namespace Express {
    interface Request {
      auth?: SessionAuthContext;
      requestId?: string;
    }
  }
}

export interface AppOptions {
  enableVite?: boolean;
  db?: DrizzleDb;
  storageProvider?: ObjectStorageProvider;
  rateLimitStore?: RateLimitStore;
  demoRateLimitStore?: RateLimitStore;
  emailProvider?: EmailProvider;
  firebaseVerifier?: FirebaseTokenVerifier;
  generateContentOverride?: GenerateContentFn;
  authRateLimitMax?: number;
  demoMutationLimitMax?: number;
  demoExtractLimitMax?: number;
  errorTrackerHook?: ErrorTrackerHook;
  demoMode?: boolean;
  store?: PgDataStore;
  appUrl?: string;
}

export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export const AUTH_RATE_LIMIT_POLICIES = {
  login: { ipMax: 25, emailMax: 10 },
  register: { ipMax: 12, emailMax: 5 },
  forgotPassword: { ipMax: 10, emailMax: 4 },
  verifyEmail: { ipMax: 15 },
  resendVerification: { ipMax: 12, accountMax: 5 },
  resetPassword: { ipMax: 10 },
  google: { ipMax: 25 },
  logout: { ipMax: 30 },
} as const;

export function validateHttpAppUrl(rawValue: string | undefined | null): string | null {
  const cleaned = stripSurroundingQuotes(rawValue ?? '');
  if (!cleaned || isPlaceholderSecret(cleaned)) {
    return null;
  }
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, ''));
  } catch {
    return null;
  }
}

export function resolveProductionAppUrl(
  params: { appUrlOverride?: string; env?: Record<string, string | undefined> } = {}
): string {
  const env = params.env ?? process.env;
  const raw = params.appUrlOverride ?? env.APP_URL;
  const valid = validateHttpAppUrl(raw);
  if (!valid) {
    throw new Error(
      'Configuration error: APP_URL must be set to a valid, non-placeholder http(s) URL in production. Failing closed.'
    );
  }
  return valid;
}

function normalizeOptionalFlagEnv(rawValue: string | undefined): string {
  let value = (rawValue ?? '').trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  // Treat masked secret placeholders (e.g., "••••" or "****") as unset
  if (/^[\u2022*]+$/.test(value)) {
    return '';
  }
  return value.toLowerCase();
}

export function resolveDemoMode(params: {
  nodeEnv?: string;
  demoModeOverride?: boolean;
  envDemoMode?: string;
} = {}): boolean {
  const nodeEnv = normalizeOptionalFlagEnv(params.nodeEnv ?? process.env.NODE_ENV) || 'development';
  const rawEnv = normalizeOptionalFlagEnv(params.envDemoMode ?? process.env.DEMO_MODE);

  if (nodeEnv === 'production') {
    if (params.demoModeOverride === true) {
      throw new Error(
        'Configuration error: Demo mode cannot be enabled when NODE_ENV=production.'
      );
    }
    if (rawEnv === 'true' || rawEnv === '1' || rawEnv === 'yes') {
      throw new Error(
        'Configuration error: DEMO_MODE=true is forbidden when NODE_ENV=production. Unset DEMO_MODE or set DEMO_MODE=false.'
      );
    }
    if (rawEnv === '' || rawEnv === 'false' || rawEnv === '0' || rawEnv === 'no') {
      return false;
    }
    throw new Error(
      'Configuration error: Invalid DEMO_MODE value in production. Unset DEMO_MODE or set DEMO_MODE=false.'
    );
  }

  if (params.demoModeOverride !== undefined) {
    return params.demoModeOverride;
  }

  if (rawEnv === 'false' || rawEnv === '0' || rawEnv === 'no') {
    return false;
  }
  if (rawEnv === '' || rawEnv === 'true' || rawEnv === '1' || rawEnv === 'yes') {
    return true;
  }

  throw new Error(
    'Configuration error: Invalid DEMO_MODE value. Set "true", "false", or leave unset.'
  );
}

export function resolveTrustProxySetting(
  env: Record<string, string | undefined> = process.env
): number | false {
  const raw = normalizeOptionalFlagEnv(env.TRUST_PROXY_HOPS);
  if (!raw) return 1;
  if (raw === 'false' || raw === '0') return false;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (Number.isSafeInteger(hops) && hops > 0) return hops;
  }
  throw new Error(
    'Configuration error: Invalid TRUST_PROXY_HOPS value. Expected a positive integer, "0", or "false".'
  );
}

export function buildProductionCspPolicy(
  env: Record<string, string | undefined> = process.env
): string {
  let s3Origin = '';
  const rawS3 = normalizeOptionalEnvValue(env.S3_ENDPOINT);
  if (rawS3) {
    try {
      s3Origin = new URL(rawS3).origin;
    } catch {
      s3Origin = '';
    }
  }

  let firebaseFrameOrigin = '';
  const explicitAuthDomain = normalizeOptionalEnvValue(env.FIREBASE_AUTH_DOMAIN);
  if (explicitAuthDomain) {
    firebaseFrameOrigin = explicitAuthDomain.startsWith('https://')
      ? explicitAuthDomain
      : `https://${explicitAuthDomain}`;
  } else {
    try {
      const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { authDomain?: unknown };
        if (typeof cfg.authDomain === 'string' && cfg.authDomain.trim() && !cfg.authDomain.includes('*')) {
          firebaseFrameOrigin = `https://${cfg.authDomain.trim()}`;
        }
      }
    } catch {
      firebaseFrameOrigin = '';
    }
  }

  const imgSrc = ["'self'", 'data:', 'blob:', s3Origin].filter(Boolean).join(' ');
  const connectSrc = [
    "'self'",
    'https://identitytoolkit.googleapis.com',
    'https://securetoken.googleapis.com',
    'https://www.googleapis.com',
    'https://apis.google.com',
    s3Origin,
  ]
    .filter(Boolean)
    .join(' ');
  const frameSrc = ["'self'", 'blob:', firebaseFrameOrigin, 'https://accounts.google.com']
    .filter(Boolean)
    .join(' ');

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "script-src 'self' https://apis.google.com https://www.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src ${imgSrc}`,
    `connect-src ${connectSrc}`,
    `frame-src ${frameSrc}`,
  ].join('; ');
}

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const appUrl = validateHttpAppUrl(process.env.APP_URL);
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      // Ignore malformed APP_URL
    }
  }
  const extra = normalizeOptionalEnvValue(process.env.ALLOWED_ORIGINS).split(',');
  for (const item of extra) {
    const trimmed = normalizeOptionalEnvValue(item);
    if (!trimmed || isPlaceholderSecret(trimmed)) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      origins.add(trimmed);
    }
  }
  return origins;
}

function isOriginAllowed(origin: string, reqHost: string | undefined): boolean {
  try {
    const parsed = new URL(origin);
    if (reqHost && parsed.host === reqHost) return true;
    if (getAllowedOrigins().has(parsed.origin)) return true;
    if (
      process.env.NODE_ENV !== 'production' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function createApp(options: AppOptions = {}) {
  const {
    enableVite = false,
    db = defaultDb,
    firebaseVerifier = verifyFirebaseIdToken,
    generateContentOverride,
    authRateLimitMax = 25,
    demoMutationLimitMax = 200,
    demoExtractLimitMax = 40,
    demoMode,
  } = options;
  const demoModeEnabled = resolveDemoMode({ demoModeOverride: demoMode });

  let validatedProdAppUrl: string | null = null;
  if (process.env.NODE_ENV === 'production') {
    // Fail closed before initializing providers or mounting routes if required production configuration is missing/placeholder
    getSigningSecret();
    validatedProdAppUrl = resolveProductionAppUrl({ appUrlOverride: options.appUrl });
    if (!options.db) {
      validateProductionSqlConfig();
    }
  }

  const storageProvider = options.storageProvider ?? createObjectStorageProvider();
  const emailProvider = options.emailProvider ?? createEmailProvider();

  const store = options.store ?? new PgDataStore(db);
  const rateLimitStore: RateLimitStore =
    options.rateLimitStore ||
    (options.db || isSqlEnvConfigured()
      ? new PostgresRateLimitStore(db)
      : new MemoryRateLimitStore());
  const demoRateLimitStore: RateLimitStore =
    options.demoRateLimitStore || new MemoryRateLimitStore(2000);

  const app = express();
  app.locals.storageProvider = storageProvider;
  app.locals.storageProviderMode = storageProvider.mode;
  app.disable('x-powered-by');
  app.set('trust proxy', resolveTrustProxySetting());
  app.use(createCorrelationMiddleware());

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()'
    );
    const cspMode = normalizeOptionalEnvValue(process.env.CSP_MODE).toLowerCase();
    if (cspMode === 'enforce') {
      res.setHeader('Content-Security-Policy', buildProductionCspPolicy());
    } else if (process.env.NODE_ENV === 'production' || cspMode === 'report-only') {
      res.setHeader('Content-Security-Policy-Report-Only', buildProductionCspPolicy());
    }
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Strict CORS enforcement on /api/*
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!isOriginAllowed(origin, req.headers.host)) {
        return res.status(403).json({ error: 'Cross-origin request blocked by CORS policy.' });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-CSRF-Token, X-Demo-Session'
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  app.use(express.json({ limit: '4mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  const hasCustomAuthLimit = options.authRateLimitMax !== undefined;
  const resolveIpCap = (policyDefault: number, scaleWithHigherOverride = false): number => {
    if (!hasCustomAuthLimit) return policyDefault;
    return scaleWithHigherOverride ? authRateLimitMax : Math.min(policyDefault, authRateLimitMax);
  };
  const resolveAccountCap = (policyDefault: number): number =>
    hasCustomAuthLimit ? Math.min(policyDefault, authRateLimitMax) : policyDefault;

  const normalizedEmailIdentity = (req: Request): string | null => {
    const email = normalizeEmailForRateLimit((req.body as { email?: unknown } | undefined)?.email);
    return email ? hashEmailRateLimitIdentity(email) : null;
  };

  const loginRateLimiter = createMultiKeyRateLimitMiddleware({
    store: rateLimitStore,
    rules: [
      {
        namespace: 'auth:ip:login',
        limit: resolveIpCap(AUTH_RATE_LIMIT_POLICIES.login.ipMax, true),
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        keyFn: (req) => getClientIp(req),
      },
      {
        namespace: 'auth:email:login',
        limit: resolveAccountCap(AUTH_RATE_LIMIT_POLICIES.login.emailMax),
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        keyFn: normalizedEmailIdentity,
      },
    ],
  });

  const registerRateLimiter = createMultiKeyRateLimitMiddleware({
    store: rateLimitStore,
    rules: [
      {
        namespace: 'auth:ip:register',
        limit: resolveIpCap(AUTH_RATE_LIMIT_POLICIES.register.ipMax),
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        keyFn: (req) => getClientIp(req),
      },
      {
        namespace: 'auth:email:register',
        limit: resolveAccountCap(AUTH_RATE_LIMIT_POLICIES.register.emailMax),
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        keyFn: normalizedEmailIdentity,
      },
    ],
  });

  const forgotPasswordRateLimiter = createMultiKeyRateLimitMiddleware({
    store: rateLimitStore,
    rules: [
      {
        namespace: 'auth:ip:forgot-password',
        limit: resolveIpCap(AUTH_RATE_LIMIT_POLICIES.forgotPassword.ipMax),
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        keyFn: (req) => getClientIp(req),
      },
      {
        namespace: 'auth:email:forgot-password',
        limit: resolveAccountCap(AUTH_RATE_LIMIT_POLICIES.forgotPassword.emailMax),
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        keyFn: normalizedEmailIdentity,
      },
    ],
  });

  const verifyEmailRateLimiter = createRateLimitMiddleware({
    store: rateLimitStore,
    namespace: 'auth:ip:verify-email',
    limit: resolveIpCap(AUTH_RATE_LIMIT_POLICIES.verifyEmail.ipMax),
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    keyFn: (req) => getClientIp(req),
  });

  const resendVerificationRateLimiter = createMultiKeyRateLimitMiddleware({
    store: rateLimitStore,
    rules: [
      {
        namespace: 'auth:ip:resend-verification',
        limit: resolveIpCap(AUTH_RATE_LIMIT_POLICIES.resendVerification.ipMax),
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        keyFn: (req) => getClientIp(req),
      },
      {
        namespace: 'auth:account:resend-verification',
        limit: resolveAccountCap(AUTH_RATE_LIMIT_POLICIES.resendVerification.accountMax),
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        keyFn: (req) => {
          if (!req.auth) return null;
          const email = normalizeEmailForRateLimit(req.auth.user.email);
          return email ? hashEmailRateLimitIdentity(email) : req.auth.user.id;
        },
      },
    ],
  });

  const resetPasswordRateLimiter = createRateLimitMiddleware({
    store: rateLimitStore,
    namespace: 'auth:ip:reset-password',
    limit: resolveIpCap(AUTH_RATE_LIMIT_POLICIES.resetPassword.ipMax),
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    keyFn: (req) => getClientIp(req),
  });

  const googleAuthRateLimiter = createRateLimitMiddleware({
    store: rateLimitStore,
    namespace: 'auth:ip:google',
    limit: resolveIpCap(AUTH_RATE_LIMIT_POLICIES.google.ipMax, true),
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    keyFn: (req) => getClientIp(req),
  });

  const logoutRateLimiter = createRateLimitMiddleware({
    store: rateLimitStore,
    namespace: 'auth:ip:logout',
    limit: resolveIpCap(AUTH_RATE_LIMIT_POLICIES.logout.ipMax),
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    keyFn: (req) => getClientIp(req),
  });

  const extractRateLimiter = createRateLimitMiddleware({
    store: rateLimitStore,
    namespace: 'extract',
    limit: 40,
    windowMs: 15 * 60 * 1000,
    keyFn: (req) => req.auth?.activeOrganization?.id || getClientIp(req),
  });

  const mutationRateLimiter = createRateLimitMiddleware({
    store: rateLimitStore,
    namespace: 'mutate',
    limit: 250,
    windowMs: 15 * 60 * 1000,
    keyFn: (req) => req.auth?.user.id || getClientIp(req),
  });

  // Dedicated bounded in-memory rate limiters for /api/demo-workspace/* (never touch PostgreSQL)
  const demoMutationRateLimiter = createRateLimitMiddleware({
    store: demoRateLimitStore,
    namespace: 'demo-mutate',
    limit: demoMutationLimitMax,
    windowMs: 15 * 60 * 1000,
    keyFn: (req) => getClientIp(req),
  });

  const demoExtractRateLimiter = createRateLimitMiddleware({
    store: demoRateLimitStore,
    namespace: 'demo-extract',
    limit: demoExtractLimitMax,
    windowMs: 15 * 60 * 1000,
    keyFn: (req) => getClientIp(req),
  });

  const demoDocRateLimiter = createRateLimitMiddleware({
    store: demoRateLimitStore,
    namespace: 'demo-doc',
    limit: 200,
    windowMs: 15 * 60 * 1000,
    keyFn: (req) => getClientIp(req),
  });

  // Attach authenticated session context if nf_session cookie is present
  async function attachSession(req: Request, _res: Response, next: NextFunction) {
    try {
      const cookies = parseCookies(req);
      const token = cookies[SESSION_COOKIE_NAME];
      if (token) {
        const ctx = await store.getSessionContext(token);
        if (ctx) {
          req.auth = ctx;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  app.use('/api', attachSession);

  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }
    next();
  }

  function requireCsrf(req: Request, res: Response, next: NextFunction) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const headerToken = req.headers['x-csrf-token'];
    const token = typeof headerToken === 'string' ? headerToken.trim() : '';
    if (!token || !safeTimingEqual(token, req.auth.csrfToken)) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
    }
    next();
  }

  function requireOrgAndPermission(permission: Permission) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.auth) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const org = req.auth.activeOrganization;
      if (!org) {
        return res
          .status(403)
          .json({ error: 'No active organization membership found for this account.' });
      }
      if (!hasPermission(org.role, permission)) {
        return res.status(403).json({
          error: `Your role (${org.role}) does not have permission (${permission}).`,
        });
      }
      next();
    };
  }

  function requireVerifiedEmail(req: Request, res: Response, next: NextFunction) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }
    if (!req.auth.user.emailVerified) {
      return res.status(403).json({
        error:
          'Email verification is required before performing this action. Please verify your email address first.',
        code: 'EMAIL_VERIFICATION_REQUIRED',
      });
    }
    next();
  }

  function buildAuthResponse(ctx: SessionAuthContext) {
    return {
      authenticated: true,
      user: ctx.user,
      activeOrganization: ctx.activeOrganization,
      organizations: ctx.organizations,
      csrfToken: ctx.csrfToken,
      googleAuthEnabled: isGoogleAuthConfigured(),
      demoMode: demoModeEnabled,
    };
  }

  function getAppBaseUrl(req: Request): string {
    if (validatedProdAppUrl) {
      return validatedProdAppUrl;
    }
    const configuredAppUrl = validateHttpAppUrl(options.appUrl ?? process.env.APP_URL);
    if (configuredAppUrl) {
      return configuredAppUrl;
    }
    const proto =
      (typeof req.headers['x-forwarded-proto'] === 'string' &&
        req.headers['x-forwarded-proto'].split(',')[0].trim()) ||
      req.protocol ||
      'http';
    const host = req.headers.host || 'localhost:3000';
    return `${proto}://${host}`;
  }

  // Liveness Check (fast, never leaks credentials or executes blocking startup probes)
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      database: 'postgresql',
      storageProvider: storageProvider.mode,
      emailProvider: emailProvider.mode,
      geminiConfigured: !isPlaceholderSecret(process.env.GEMINI_API_KEY),
      googleAuthConfigured: isGoogleAuthConfigured(),
      timestamp: new Date().toISOString(),
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  // Dependency Readiness Check (PostgreSQL SELECT 1 + private object storage + email/AI config)
  app.get('/api/health/ready', async (_req, res) => {
    const report = await checkDependencyReadiness({
      db,
      storageProvider,
      emailProvider,
    });
    res.status(report.status === 'ready' ? 200 : 503).json(report);
  });

  // Disabled Demo Role Switcher
  app.all('/api/demo/switch-persona', (_req, res) => {
    res.status(410).json({
      error:
        'Demo persona switching has been disabled. Sign in with an authenticated organization account.',
    });
  });

  // ==================== AUTHENTICATION ROUTES ====================

  app.get('/api/auth/me', (req, res) => {
    if (!req.auth) {
      return res.json({
        authenticated: false,
        user: null,
        activeOrganization: null,
        organizations: [],
        csrfToken: null,
        googleAuthEnabled: isGoogleAuthConfigured(),
        demoMode: demoModeEnabled,
      });
    }
    res.json(buildAuthResponse(req.auth));
  });

  // ==================== ISOLATED SYNTHETIC DEMO WORKSPACE ====================
  const demoStore = new DemoWorkspaceStore();
  const DEMO_COOKIE_NAME = 'nf_demo_sid';

  function extractProvidedDemoSessionId(req: Request): string | null {
    const headerVal = req.headers['x-demo-session'];
    const cookies = parseCookies(req);
    const cookieVal = cookies[DEMO_COOKIE_NAME];
    return (
      (typeof headerVal === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(headerVal.trim())
        ? headerVal.trim()
        : null) ||
      (typeof cookieVal === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(cookieVal.trim())
        ? cookieVal.trim()
        : null)
    );
  }

  function resolveDemoSessionId(req: Request, res: Response): string {
    const cookies = parseCookies(req);
    const cookieVal = cookies[DEMO_COOKIE_NAME];
    const candidate = extractProvidedDemoSessionId(req);

    const sessionId = candidate || `demo-${generateSecureToken(16)}`;
    if (!cookieVal || cookieVal !== sessionId) {
      const proto = req.headers['x-forwarded-proto'];
      const secure =
        process.env.NODE_ENV === 'production' ||
        req.secure ||
        (typeof proto === 'string' && proto.split(',')[0].trim() === 'https');
      const sameSite = resolveCookieSameSite(secure);
      res.setHeader(
        'Set-Cookie',
        [
          `${DEMO_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
          'Path=/',
          'HttpOnly',
          'Max-Age=86400',
          `SameSite=${sameSite}`,
          secure ? 'Secure' : '',
        ]
          .filter(Boolean)
          .join('; ')
      );
    }
    return sessionId;
  }

  function requireDemoMode(_req: Request, res: Response, next: NextFunction) {
    if (!demoModeEnabled) {
      return res.status(410).json({
        error: 'Temporary demo mode is disabled. Sign in with an authenticated account.',
      });
    }
    next();
  }

  app.get('/api/demo-workspace', requireDemoMode, (req, res) => {
    const sessionId = resolveDemoSessionId(req, res);
    const workspace = demoStore.getWorkspace(sessionId);
    res.json({
      ...workspace,
      demoMode: true,
      demoSessionId: sessionId,
      user: DEMO_USER,
      activeOrganization: DEMO_ORGANIZATION_SUMMARY,
      organizations: [DEMO_ORGANIZATION_SUMMARY],
    });
  });

  app.post('/api/demo-workspace/reset', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const workspace = demoStore.resetSession(sessionId);
      res.json({
        ...workspace,
        demoMode: true,
        demoSessionId: sessionId,
        user: DEMO_USER,
        activeOrganization: DEMO_ORGANIZATION_SUMMARY,
        organizations: [DEMO_ORGANIZATION_SUMMARY],
      });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/demo-workspace/settings', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const updated = demoStore.updateSettings(sessionId, req.body || {});
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/demo-workspace/rfqs/load-sample', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const result = demoStore.loadSampleRfq(sessionId);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/demo-workspace/rfqs', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const created = demoStore.createRfq(sessionId, req.body || {});
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/demo-workspace/suppliers', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const supplier = demoStore.createSupplier(sessionId, req.body || {});
      res.status(201).json(supplier);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/demo-workspace/rfqs/:rfqId/quotes/extract',
    requireDemoMode,
    demoExtractRateLimiter,
    upload.single('file'),
    async (req, res, next) => {
      try {
        const sessionId = resolveDemoSessionId(req, res);
        const supplierId = req.body?.supplierId;
        if (typeof supplierId !== 'string' || !supplierId.trim()) {
          return res.status(400).json({ error: 'Valid supplierId is required.' });
        }

        const { rfq, settings, supplierName } = demoStore.getExtractionContext(
          sessionId,
          req.params.rfqId,
          supplierId.trim()
        );

        const rawEmailText =
          typeof req.body?.rawEmailText === 'string' ? req.body.rawEmailText.trim() : '';
        const file = req.file;

        if (!file && !rawEmailText) {
          return res.status(400).json({
            error: 'Upload a quotation file (PDF, Excel, CSV, Image) or paste email text.',
          });
        }

        let safeName = `Demo_Email_Quote_${Date.now().toString().slice(-4)}.txt`;
        let safeMime = 'text/plain';
        if (file) {
          const validation = validateUploadedFile(file.buffer, file.originalname, file.mimetype);
          if (!validation.ok) {
            return res.status(validation.status).json({ error: validation.error });
          }
          safeName = validation.safeFilename;
          safeMime = validation.detectedMime;
        }

        // Never allow anonymous demo sessions to invoke live production GEMINI_API_KEY quota.
        // Only run extractQuotationWithGemini if a test explicitly injects generateContentOverride.
        const extracted = generateContentOverride
          ? await extractQuotationWithGemini({
              rfq,
              supplierId: supplierId.trim(),
              settings,
              documentName: safeName,
              mimeType: safeMime,
              fileBuffer: file?.buffer,
              rawEmailText: rawEmailText || undefined,
              skipInlineDataUrl: true,
              generateContentOverride,
            })
          : await extractDemoQuotationOffline({
              rfq,
              supplierId: supplierId.trim(),
              settings,
              documentName: safeName,
              mimeType: safeMime,
              fileBuffer: file?.buffer,
              rawEmailText: rawEmailText || undefined,
            });

        const saved = demoStore.saveExtractedQuotation({
          sessionId,
          rfqId: rfq.id,
          supplierName,
          quotation: extracted,
          file: file
            ? {
                buffer: file.buffer,
                originalFilename: safeName,
                mimeType: safeMime,
              }
            : undefined,
        });

        res.status(201).json(saved);
      } catch (err) {
        next(err);
      }
    }
  );

  app.patch('/api/demo-workspace/quotations/:quoteId', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const updated = demoStore.updateQuotationHeader(sessionId, req.params.quoteId, req.body || {});
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.patch(
    '/api/demo-workspace/quotations/:quoteId/lines/:lineId',
    requireDemoMode,
    demoMutationRateLimiter,
    (req, res, next) => {
      try {
        const sessionId = resolveDemoSessionId(req, res);
        const updated = demoStore.updateQuotationLine(
          sessionId,
          req.params.quoteId,
          req.params.lineId,
          req.body || {}
        );
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/demo-workspace/quotations/:quoteId/verify', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const verified = demoStore.verifyQuotation(sessionId, req.params.quoteId);
      res.json(verified);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/demo-workspace/quotations/:quoteId', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      demoStore.deleteQuotation(sessionId, req.params.quoteId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/demo-workspace/rfqs/:rfqId/award', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const {
        isSplitAward,
        nonL1Justification,
        acceptedAlternateLineIds,
        commercialExceptionAccepted,
        allocations,
      } = req.body || {};
      const award = demoStore.submitAward(sessionId, {
        rfqId: req.params.rfqId,
        isSplitAward: Boolean(isSplitAward),
        nonL1Justification,
        acceptedAlternateLineIds,
        commercialExceptionAccepted,
        allocations,
      });
      res.status(201).json(award);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/demo-workspace/awards/:awardId/withdraw', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const result = demoStore.withdrawAward(sessionId, req.params.awardId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/demo-workspace/awards/:awardId/decide', requireDemoMode, demoMutationRateLimiter, (req, res, next) => {
    try {
      const sessionId = resolveDemoSessionId(req, res);
      const { decision, approverNotes } = req.body || {};
      const decided = demoStore.decideAward(sessionId, req.params.awardId, decision, approverNotes);
      res.json(decided);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/demo-workspace/documents/:docId/signed-url', requireDemoMode, demoDocRateLimiter, async (req, res, next) => {
    try {
      const candidateSession = extractProvidedDemoSessionId(req);
      if (!candidateSession || !demoStore.hasSession(candidateSession)) {
        return res.status(404).json({ error: 'Demo document not found in this session.' });
      }
      const doc = await demoStore.getDocument(candidateSession, req.params.docId);
      if (!doc) {
        return res.status(404).json({ error: 'Demo document not found in this session.' });
      }
      const exp = Math.floor(Date.now() / 1000) + 300;
      const sig = signHmac(`demo:${doc.id}:${candidateSession}:${exp}`);
      res.json({
        url: `/api/demo-workspace/documents/${encodeURIComponent(doc.id)}/content?demo=${encodeURIComponent(
          candidateSession
        )}&exp=${exp}&sig=${encodeURIComponent(sig)}`,
        expiresAt: new Date(exp * 1000).toISOString(),
        mimeType: doc.mimeType,
        originalFilename: doc.originalFilename,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/demo-workspace/documents/:docId/content', requireDemoMode, demoDocRateLimiter, async (req, res, next) => {
    try {
      const demoParam = typeof req.query.demo === 'string' ? req.query.demo : '';
      const expParam = typeof req.query.exp === 'string' ? Number(req.query.exp) : NaN;
      const sigParam = typeof req.query.sig === 'string' ? req.query.sig : '';

      if (
        !demoParam ||
        !Number.isFinite(expParam) ||
        expParam < Math.floor(Date.now() / 1000) ||
        !verifyHmac(`demo:${req.params.docId}:${demoParam}:${expParam}`, sigParam)
      ) {
        return res.status(403).json({ error: 'Signed demo document URL is invalid or expired.' });
      }

      const doc = await demoStore.getDocument(demoParam, req.params.docId);
      if (!doc) {
        return res.status(404).json({ error: 'Demo document not found.' });
      }

      res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${doc.originalFilename.replace(/["\r\n]/g, '_')}"`
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(doc.buffer);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/register', registerRateLimiter, async (req, res, next) => {
    try {
      const { email, password, fullName, title, organizationName, inviteToken } = req.body || {};
      const result = await store.registerWithPassword({
        email,
        password,
        fullName,
        title,
        organizationName,
        inviteToken,
        ipAddress: getClientIp(req),
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });

      const verifyUrl = `${getAppBaseUrl(req)}/?verify=${encodeURIComponent(
        result.rawVerificationToken
      )}`;
      await emailProvider.send({
        to: result.user.email,
        subject: 'Verify your NORUS QUOTEFLOW email',
        text: `Welcome to NORUS QUOTEFLOW, ${result.user.fullName}.\n\nVerify your email address by opening this link (valid for 24 hours):\n${verifyUrl}\n`,
      });

      setAuthCookies(req, res, result.rawSessionToken, result.csrfToken);
      res.status(201).json(buildAuthResponse(result));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/login', loginRateLimiter, async (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      const result = await store.loginWithPassword({
        email,
        password,
        ipAddress: getClientIp(req),
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });
      setAuthCookies(req, res, result.rawSessionToken, result.csrfToken);
      res.json(buildAuthResponse(result));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/google', googleAuthRateLimiter, async (req, res, next) => {
    try {
      const { idToken, inviteToken } = req.body || {};
      if (typeof idToken !== 'string' || !idToken.trim()) {
        return res.status(400).json({ error: 'Firebase Google ID token is required.' });
      }

      let verified: VerifiedFirebaseUser;
      try {
        verified = await firebaseVerifier(idToken.trim());
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Google token verification failed.';
        return res.status(401).json({ error: msg });
      }

      if (!verified.email) {
        return res.status(400).json({ error: 'Google account did not provide an email address.' });
      }

      const result = await store.loginWithGoogle({
        firebaseUid: verified.uid,
        email: verified.email,
        fullName: verified.name || verified.email.split('@')[0],
        emailVerified: Boolean(verified.email_verified),
        inviteToken: typeof inviteToken === 'string' ? inviteToken.trim() : undefined,
        ipAddress: getClientIp(req),
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });

      setAuthCookies(req, res, result.rawSessionToken, result.csrfToken);
      res.json(buildAuthResponse(result));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/logout', logoutRateLimiter, requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const cookies = parseCookies(req);
      const token = cookies[SESSION_COOKIE_NAME];
      if (token) {
        await store.revokeSessionByToken(token);
      }
      clearAuthCookies(req, res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/verify-email', verifyEmailRateLimiter, async (req, res, next) => {
    try {
      const { token } = req.body || {};
      const user = await store.verifyEmailByToken(typeof token === 'string' ? token.trim() : '');
      res.json({ ok: true, user });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/auth/resend-verification',
    requireAuth,
    requireCsrf,
    resendVerificationRateLimiter,
    async (req, res, next) => {
      try {
        if (req.auth!.user.emailVerified) {
          return res.json({ ok: true, alreadyVerified: true });
        }
        const issued = await store.createEmailVerificationToken(req.auth!.user.id);
        const verifyUrl = `${getAppBaseUrl(req)}/?verify=${encodeURIComponent(issued.rawToken)}`;
        await emailProvider.send({
          to: issued.email,
          subject: 'Verify your NORUS QUOTEFLOW email',
          text: `Hello ${issued.fullName},\n\nVerify your email address using this link (valid for 24 hours):\n${verifyUrl}\n`,
        });
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/auth/forgot-password', forgotPasswordRateLimiter, async (req, res, next) => {
    try {
      const { email } = req.body || {};
      if (typeof email === 'string' && email.trim()) {
        const issued = await store.createPasswordResetToken(email);
        if (issued) {
          const resetUrl = `${getAppBaseUrl(req)}/?reset=${encodeURIComponent(issued.rawToken)}`;
          await emailProvider.send({
            to: issued.email,
            subject: 'NORUS QUOTEFLOW Password Reset',
            text: `Hello ${issued.fullName},\n\nReset your password using the link below (valid for 1 hour):\n${resetUrl}\n\nIf you did not request this, ignore this email.\n`,
          });
        }
      }
      res.json({
        ok: true,
        message: 'If an account matches that email, a password reset link has been sent.',
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/reset-password', resetPasswordRateLimiter, async (req, res, next) => {
    try {
      const { token, newPassword } = req.body || {};
      await store.resetPasswordByToken(
        typeof token === 'string' ? token.trim() : '',
        typeof newPassword === 'string' ? newPassword : ''
      );
      clearAuthCookies(req, res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/auth/sessions', requireAuth, async (req, res, next) => {
    try {
      const list = await store.listUserSessions(req.auth!.user.id, req.auth!.sessionId);
      res.json({ sessions: list });
    } catch (err) {
      next(err);
    }
  });

  app.delete(
    '/api/auth/sessions/:sessionId',
    requireAuth,
    requireCsrf,
    async (req, res, next) => {
      try {
        await store.revokeSessionById(req.auth!.user.id, req.params.sessionId);
        if (req.params.sessionId === req.auth!.sessionId) {
          clearAuthCookies(req, res);
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );

  // ==================== ORGANIZATION & TEAM ROUTES ====================

  app.post(
    '/api/organizations',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    async (req, res, next) => {
      try {
        const { name, countryCode, defaultCurrency, taxRegime } = req.body || {};
        const org = await store.createOrganization({
          userId: req.auth!.user.id,
          userName: req.auth!.user.fullName,
          sessionId: req.auth!.sessionId,
          name,
          countryCode,
          defaultCurrency,
          taxRegime,
        });
        res.status(201).json({ organization: org });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/organizations/switch', requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const { organizationId } = req.body || {};
      if (typeof organizationId !== 'string' || !organizationId.trim()) {
        return res.status(400).json({ error: 'organizationId is required.' });
      }
      const org = await store.switchActiveOrganization({
        sessionId: req.auth!.sessionId,
        userId: req.auth!.user.id,
        organizationId: organizationId.trim(),
      });
      res.json({ organization: org });
    } catch (err) {
      next(err);
    }
  });

  app.get(
    '/api/organizations/current/members',
    requireAuth,
    requireOrgAndPermission('workspace:read'),
    async (req, res, next) => {
      try {
        const members = await store.listOrganizationMembers(req.auth!.activeOrganization!.id);
        res.json({ members });
      } catch (err) {
        next(err);
      }
    }
  );

  app.patch(
    '/api/organizations/current/members/:userId',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('org:members:manage'),
    async (req, res, next) => {
      try {
        const { role } = req.body || {};
        const org = req.auth!.activeOrganization!;
        const updated = await store.updateMemberRole({
          organizationId: org.id,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
          targetUserId: req.params.userId,
          newRole: role,
        });
        res.json({ member: updated });
      } catch (err) {
        next(err);
      }
    }
  );

  app.delete(
    '/api/organizations/current/members/:userId',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('org:members:manage'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        await store.removeMember({
          organizationId: org.id,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
          targetUserId: req.params.userId,
        });
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    '/api/organizations/current/invitations',
    requireAuth,
    requireOrgAndPermission('org:members:invite'),
    async (req, res, next) => {
      try {
        const list = await store.listInvitations(req.auth!.activeOrganization!.id);
        res.json({ invitations: list });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/organizations/current/invitations',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('org:members:invite'),
    requireVerifiedEmail,
    async (req, res, next) => {
      try {
        const { email, role } = req.body || {};
        const org = req.auth!.activeOrganization!;
        const created = await store.createInvitation({
          organizationId: org.id,
          email,
          role,
          invitedByUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });

        const inviteUrl = `${getAppBaseUrl(req)}/?invite=${encodeURIComponent(created.rawToken)}`;
        await emailProvider.send({
          to: created.invitation.email,
          subject: `Invitation to join ${created.organizationName} on NORUS QUOTEFLOW`,
          text: `${req.auth!.user.fullName} invited you to join ${created.organizationName} as ${created.invitation.role}.\n\nAccept your invitation:\n${inviteUrl}\n`,
        });

        res.status(201).json({ invitation: created.invitation });
      } catch (err) {
        next(err);
      }
    }
  );

  app.delete(
    '/api/organizations/current/invitations/:invitationId',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('org:members:invite'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        await store.revokeInvitation({
          organizationId: org.id,
          invitationId: req.params.invitationId,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/invitations/accept', requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const { token } = req.body || {};
      const org = await store.acceptInvitation({
        userId: req.auth!.user.id,
        userEmail: req.auth!.user.email,
        userName: req.auth!.user.fullName,
        sessionId: req.auth!.sessionId,
        rawToken: typeof token === 'string' ? token.trim() : '',
      });
      res.json({ organization: org });
    } catch (err) {
      next(err);
    }
  });

  // ==================== TENANT PROCUREMENT ROUTES ====================

  app.get(
    '/api/workspace',
    requireAuth,
    requireOrgAndPermission('workspace:read'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const state = await store.loadTenantWorkspace(org.id, req.auth!.user, org.role);
        res.json(state);
      } catch (err) {
        next(err);
      }
    }
  );

  app.patch(
    '/api/settings',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('org:settings:write'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const { name, defaultCurrency, taxRegime, defaultTaxCreditable } = req.body || {};
        const updated = await store.updateOrganizationSettings({
          organizationId: org.id,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
          patch: { name, defaultCurrency, taxRegime, defaultTaxCreditable },
        });
        updated.activeUserTitle = req.auth!.user.title;
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    '/api/organization/usage',
    requireAuth,
    requireOrgAndPermission('workspace:read'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const summary = await store.getOrganizationUsageSummary(org.id);
        res.json(summary);
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/rfqs/load-sample',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('rfq:write'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const result = await store.loadSampleRfq({
          organizationId: org.id,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/rfqs',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('rfq:write'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const created = await store.createRfq({
          organizationId: org.id,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
          input: req.body || {},
        });
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/suppliers',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('supplier:write'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const supplier = await store.createSupplier({
          organizationId: org.id,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
          input: req.body || {},
        });
        res.status(201).json(supplier);
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/items',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('item:write'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const item = await store.createCatalogItem({
          organizationId: org.id,
          input: req.body || {},
        });
        res.status(201).json(item);
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/rfqs/:rfqId/quotes/extract',
    requireAuth,
    requireCsrf,
    requireOrgAndPermission('quotation:extract'),
    requireVerifiedEmail,
    extractRateLimiter,
    upload.single('file'),
    async (req, res, next) => {
      let uploadedKeyForRollback: string | null = null;
      let reservationIdForRollback: string | null = null;
      let activeOrgIdForRollback: string | null = null;
      let observedTokenUsageForRollback: AiTokenUsageTelemetry | null = null;
      try {
        const org = req.auth!.activeOrganization!;
        activeOrgIdForRollback = org.id;
        const supplierId = req.body?.supplierId;
        if (typeof supplierId !== 'string' || !supplierId.trim()) {
          return res.status(400).json({ error: 'Valid supplierId is required.' });
        }

        const rawIdempotency =
          typeof req.headers['idempotency-key'] === 'string'
            ? req.headers['idempotency-key']
            : req.body?.idempotencyKey;
        const idempotencyCheck = validateOptionalIdempotencyKey(rawIdempotency);
        if (!idempotencyCheck.valid) {
          return res.status(400).json({ error: idempotencyCheck.error });
        }

        const { rfq, settings, supplierName } = await store.getExtractionContext({
          organizationId: org.id,
          rfqId: req.params.rfqId,
          supplierId: supplierId.trim(),
        });

        const rawEmailText =
          typeof req.body?.rawEmailText === 'string' ? req.body.rawEmailText.trim() : '';
        const file = req.file;

        if (!file && !rawEmailText) {
          return res.status(400).json({
            error: 'Upload a quotation file (PDF, Excel, CSV, Image) or paste email text.',
          });
        }

        let safeName = `Email_Quote_${Date.now().toString().slice(-4)}.txt`;
        let safeMime = 'text/plain';
        if (file) {
          const validation = validateUploadedFile(file.buffer, file.originalname, file.mimetype);
          if (!validation.ok) {
            return res.status(validation.status).json({ error: validation.error });
          }
          safeName = validation.safeFilename;
          safeMime = validation.detectedMime;
        }

        const isSpreadsheet =
          safeMime.includes('spreadsheet') ||
          safeMime.includes('excel') ||
          safeMime.includes('csv') ||
          /\.(xlsx|xls|csv)$/i.test(safeName);

        // Pre-validate & isolate-parse spreadsheets BEFORE reserving monthly/storage quota
        let preParsedSpreadsheet: ParsedSpreadsheetResult | undefined;
        if (isSpreadsheet && file) {
          preParsedSpreadsheet = await parseSpreadsheetBufferIsolated(file.buffer, {
            documentName: safeName,
            mimeType: safeMime,
          });
          if (!preParsedSpreadsheet.structuredText.trim()) {
            throw new ExtractionServiceError(
              'The uploaded spreadsheet contains no readable rows or quotation data.',
              422
            );
          }
        }

        const actualBytes = file ? file.buffer.byteLength : 0;
        const reservation = await store.reserveExtractionAndStorageQuota({
          organizationId: org.id,
          rfqId: rfq.id,
          supplierId: supplierId.trim(),
          reservedBytes: actualBytes,
          idempotencyKey: idempotencyCheck.key,
        });

        if (reservation.kind === 'idempotent_hit') {
          return res.status(200).json(reservation.quotation);
        }

        reservationIdForRollback = reservation.reservationId;

        const { quotation: extracted, tokenUsage } = await extractQuotationWithTelemetry({
          rfq,
          supplierId: supplierId.trim(),
          settings,
          documentName: safeName,
          mimeType: safeMime,
          fileBuffer: file?.buffer,
          rawEmailText: rawEmailText || undefined,
          preParsedSpreadsheet,
          skipInlineDataUrl: true,
          generateContentOverride,
        });
        observedTokenUsageForRollback = tokenUsage;

        let storedDoc = null;
        if (file) {
          const docId = `doc-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
          const storageKey = buildDocumentStorageKey(org.id, docId, safeName);
          await storageProvider.putObject({
            key: storageKey,
            buffer: file.buffer,
            contentType: safeMime,
          });
          uploadedKeyForRollback = storageKey;
          storedDoc = {
            id: docId,
            organizationId: org.id,
            uploadedByUserId: req.auth!.user.id,
            storageProvider: storageProvider.mode,
            storageKey,
            originalFilename: safeName,
            mimeType: safeMime,
            byteSize: file.buffer.byteLength,
            sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
            createdAt: new Date().toISOString(),
          };
        }

        const saved = await store.saveExtractedQuotation({
          organizationId: org.id,
          rfqId: rfq.id,
          supplierName,
          quotation: extracted,
          storedDoc,
          reservationId: reservationIdForRollback,
          tokenUsage,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        reservationIdForRollback = null;
        uploadedKeyForRollback = null;
        observedTokenUsageForRollback = null;

        logEvent('info', 'ai_extraction_completed', {
          requestId: req.requestId,
          organizationId: org.id,
          quotationId: saved.id,
          documentId: saved.documentId ?? null,
          model: tokenUsage.model,
          usageAvailable: tokenUsage.usageAvailable,
          promptTokenCount: tokenUsage.promptTokenCount,
          candidatesTokenCount: tokenUsage.candidatesTokenCount,
          totalTokenCount: tokenUsage.totalTokenCount,
          byteSize: actualBytes,
        });

        res.status(201).json(saved);
      } catch (err) {
        if (uploadedKeyForRollback) {
          await storageProvider.deleteObject(uploadedKeyForRollback).catch((delErr) => {
            logEvent('warn', 'storage_rollback_delete_failed', {
              requestId: req.requestId,
              storageKey: uploadedKeyForRollback,
              error: delErr instanceof Error ? delErr.message : String(delErr),
            });
          });
        }
        if (reservationIdForRollback && activeOrgIdForRollback) {
          const observedUsage =
            err instanceof ExtractionServiceError && err.tokenUsage
              ? err.tokenUsage
              : observedTokenUsageForRollback ?? {
                  model: GEMINI_EXTRACTION_MODEL,
                  usageAvailable: false,
                  promptTokenCount: null,
                  candidatesTokenCount: null,
                  totalTokenCount: null,
                  thoughtsTokenCount: null,
                };
          await store
            .releaseExtractionReservation({
              organizationId: activeOrgIdForRollback,
              reservationId: reservationIdForRollback,
              tokenUsage: observedUsage,
            })
            .catch((relErr) => {
              logEvent('warn', 'quota_reservation_release_failed', {
                requestId: req.requestId,
                reservationId: reservationIdForRollback,
                error: relErr instanceof Error ? relErr.message : String(relErr),
              });
            });
        }
        next(err);
      }
    }
  );

  app.patch(
    '/api/quotations/:quoteId',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('quotation:edit'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const updated = await store.updateQuotationHeader({
          organizationId: org.id,
          quoteId: req.params.quoteId,
          body: req.body || {},
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  app.patch(
    '/api/quotations/:quoteId/lines/:lineId',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('quotation:edit'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const updated = await store.updateQuotationLine({
          organizationId: org.id,
          quoteId: req.params.quoteId,
          lineId: req.params.lineId,
          body: req.body || {},
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/quotations/:quoteId/verify',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('quotation:verify'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const verified = await store.verifyQuotation({
          organizationId: org.id,
          quoteId: req.params.quoteId,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        res.json(verified);
      } catch (err) {
        next(err);
      }
    }
  );

  app.delete(
    '/api/quotations/:quoteId',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('quotation:delete'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const result = await store.deleteQuotation({
          organizationId: org.id,
          quoteId: req.params.quoteId,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        if (result.deletedDocument) {
          await storageProvider
            .deleteObject(result.deletedDocument.storageKey)
            .catch((delErr) => {
              logEvent('warn', 'storage_post_delete_failed', {
                requestId: req.requestId,
                storageKey: result.deletedDocument!.storageKey,
                error: delErr instanceof Error ? delErr.message : String(delErr),
              });
            });
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/rfqs/:rfqId/award',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('award:recommend'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const {
          isSplitAward,
          nonL1Justification,
          acceptedAlternateLineIds,
          commercialExceptionAccepted,
          allocations,
        } = req.body || {};
        const award = await store.submitAward({
          organizationId: org.id,
          rfqId: req.params.rfqId,
          isSplitAward: Boolean(isSplitAward),
          nonL1Justification,
          acceptedAlternateLineIds,
          commercialExceptionAccepted,
          allocations,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        res.status(201).json(award);
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/awards/:awardId/withdraw',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('award:recommend'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const result = await store.withdrawAward({
          organizationId: org.id,
          awardId: req.params.awardId,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/awards/:awardId/decide',
    requireAuth,
    requireCsrf,
    mutationRateLimiter,
    requireOrgAndPermission('award:decide'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const { decision, approverNotes } = req.body || {};
        const result = await store.decideAward({
          organizationId: org.id,
          awardId: req.params.awardId,
          decision,
          approverNotes,
          actorUserId: req.auth!.user.id,
          actorName: req.auth!.user.fullName,
          actorRole: org.role,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // ==================== PRIVATE DOCUMENT ACCESS ====================

  app.get(
    '/api/documents/:docId/signed-url',
    requireAuth,
    requireOrgAndPermission('document:download'),
    async (req, res, next) => {
      try {
        const org = req.auth!.activeOrganization!;
        const doc = await store.getStoredDocumentForOrg(org.id, req.params.docId);
        if (!doc) {
          return res.status(404).json({ error: 'Document not found in active organization.' });
        }
        const signed = await storageProvider.createSignedDownloadUrl({
          documentId: doc.id,
          storageKey: doc.storageKey,
          organizationId: org.id,
          filename: doc.originalFilename,
          expiresInSec: 300,
        });
        res.json({
          url: signed.url,
          expiresAt: signed.expiresAt,
          mimeType: doc.mimeType,
          originalFilename: doc.originalFilename,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get('/api/documents/:docId/content', async (req, res, next) => {
    try {
      const orgParam = typeof req.query.org === 'string' ? req.query.org : '';
      const expParam = typeof req.query.exp === 'string' ? Number(req.query.exp) : NaN;
      const sigParam = typeof req.query.sig === 'string' ? req.query.sig : '';

      let authorizedOrgId: string | null = null;
      if (sigParam || orgParam || req.query.exp) {
        const validSig = verifySignedDocumentToken({
          documentId: req.params.docId,
          organizationId: orgParam,
          exp: expParam,
          sig: sigParam,
        });
        if (!validSig) {
          return res.status(403).json({ error: 'Signed document URL is invalid or expired.' });
        }
        authorizedOrgId = orgParam;
      } else {
        if (!req.auth) {
          return res.status(401).json({ error: 'Authentication required.' });
        }
        if (!req.auth.activeOrganization) {
          return res.status(403).json({ error: 'No active organization membership.' });
        }
        if (!hasPermission(req.auth.activeOrganization.role, 'document:download')) {
          return res.status(403).json({ error: 'Permission denied.' });
        }
        authorizedOrgId = req.auth.activeOrganization.id;
      }

      const doc = await store.getStoredDocumentForOrg(authorizedOrgId, req.params.docId);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found.' });
      }

      const obj = await storageProvider.getObject(doc.storageKey);
      res.setHeader('Content-Type', doc.mimeType || obj.contentType || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${doc.originalFilename.replace(/["\r\n]/g, '_')}"`
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(obj.buffer);
    } catch (err) {
      next(err);
    }
  });

  if (enableVite) {
    if (process.env.NODE_ENV !== 'production') {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.resolve(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  // Centralized error handler (never leaks raw SQL/stack/secrets)
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'Uploaded file exceeds the 25 MB limit.',
          requestId: req.requestId,
        });
      }
      return res.status(400).json({
        error: `File upload error: ${redactSensitiveText(err.message)}`,
        requestId: req.requestId,
      });
    }
    if (err instanceof QuotaExceededError) {
      return res.status(err.statusCode).json({
        error: redactSensitiveText(err.message),
        code: err.code,
        quota: err.details,
        requestId: req.requestId,
      });
    }
    const status =
      err instanceof StoreError
        ? err.statusCode
        : err instanceof DemoStoreError
        ? err.statusCode
        : err instanceof ExtractionServiceError
        ? err.statusCode
        : 500;
    const rawMessage = err instanceof Error ? err.message : 'Internal server error.';
    const safeRaw = redactSensitiveText(rawMessage);
    const message = status >= 500 ? 'Internal server error.' : safeRaw;
    if (status >= 500) {
      logEvent('error', 'unhandled_server_error', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        statusCode: status,
        message: safeRaw,
        organizationId: req.auth?.activeOrganization?.id ?? null,
        userId: req.auth?.user.id ?? null,
      });
      dispatchErrorTrackerHook(options.errorTrackerHook, {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        statusCode: status,
        message: safeRaw,
        organizationId: req.auth?.activeOrganization?.id ?? null,
        userId: req.auth?.user.id ?? null,
        ts: new Date().toISOString(),
      });
    }
    res.status(status).json({ error: message, requestId: req.requestId });
  });

  return app;
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const PORT = Number(process.env.PORT) || 3000;
  try {
    const demoModeAtBoot = resolveDemoMode();
    createApp({ enableVite: true })
      .then((app) => {
        const storageProvider = app.locals.storageProvider as ObjectStorageProvider;
        const httpServer = app.listen(PORT, '0.0.0.0', () => {
          logEvent('info', 'server_started', {
            port: PORT,
            nodeEnv: process.env.NODE_ENV || 'development',
            demoMode: demoModeAtBoot,
            storageProvider: storageProvider.mode,
          });
        });

        httpServer.on('error', (err) => {
          logEvent('error', 'server_listen_failed', {
            port: PORT,
            error: redactSensitiveText(err instanceof Error ? err.message : String(err)),
          });
          process.exit(1);
        });

        const rawInterval = normalizeOptionalEnvValue(process.env.MAINTENANCE_INTERVAL_MINUTES);
        const intervalMinutes = Number(rawInterval || '360');
        if (Number.isFinite(intervalMinutes) && intervalMinutes > 0 && isSqlEnvConfigured()) {
          const timer = setInterval(() => {
            runScheduledMaintenance({ db: defaultDb, storageProvider, lockPool: defaultPool }).catch(
              (err) => {
                logEvent('error', 'scheduled_maintenance_failed', {
                  error: redactSensitiveText(err instanceof Error ? err.message : String(err)),
                });
              }
            );
          }, intervalMinutes * 60 * 1000);
          timer.unref();
        }
      })
      .catch((err) => {
        logEvent('error', 'server_startup_failed', {
          port: PORT,
          nodeEnv: process.env.NODE_ENV || 'development',
          error: redactSensitiveText(err instanceof Error ? err.message : String(err)),
        });
        process.exit(1);
      });
  } catch (err) {
    logEvent('error', 'server_startup_failed', {
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development',
      error: redactSensitiveText(err instanceof Error ? err.message : String(err)),
    });
    process.exit(1);
  }
}
