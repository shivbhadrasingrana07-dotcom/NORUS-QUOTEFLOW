import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import type { DrizzleDb } from '../src/db/index.ts';
import type { EmailProvider } from './emailService.ts';
import type { ObjectStorageProvider } from './objectStorage.ts';
import { isPlaceholderSecret, redactSensitiveText } from './security.ts';

export function isGoogleAuthConfigured(configPath?: string): boolean {
  try {
    const resolved = configPath || path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (!fs.existsSync(resolved)) return false;
    const raw = fs.readFileSync(resolved, 'utf8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    return Boolean(
      typeof cfg.projectId === 'string' &&
        cfg.projectId.trim() &&
        typeof cfg.apiKey === 'string' &&
        cfg.apiKey.trim() &&
        typeof cfg.authDomain === 'string' &&
        cfg.authDomain.trim()
    );
  } catch {
    return false;
  }
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface StructuredLogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  requestId?: string;
  [key: string]: unknown;
}

export type ErrorTrackerHook = (payload: {
  requestId?: string;
  method?: string;
  path?: string;
  statusCode: number;
  message: string;
  organizationId?: string | null;
  userId?: string | null;
  ts: string;
}) => void | Promise<void>;

function sanitizeValue(val: unknown): unknown {
  if (typeof val === 'string') {
    return redactSensitiveText(val);
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (
        /password|secret|token|cookie|authorization|apikey|api_key/i.test(k) &&
        typeof v === 'string'
      ) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeValue(v);
      }
    }
    return out;
  }
  return val;
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): StructuredLogEntry {
  const entry: StructuredLogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(sanitizeValue(fields) as Record<string, unknown>),
  };

  if (process.env.NODE_ENV !== 'test') {
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  }
  return entry;
}

export function createCorrelationMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const safeIncoming =
      typeof incoming === 'string' && /^[a-zA-Z0-9._-]{8,64}$/.test(incoming.trim())
        ? incoming.trim()
        : null;
    const requestId = safeIncoming || crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const startMs = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) {
        const level: LogLevel =
          res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        logEvent(level, 'http_request', {
          requestId,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startMs,
          organizationId: req.auth?.activeOrganization?.id ?? null,
          userId: req.auth?.user.id ?? null,
        });
      }
    });

    next();
  };
}

export interface DependencyReadinessReport {
  status: 'ready' | 'degraded';
  timestamp: string;
  uptimeSec: number;
  checks: {
    database: {
      ok: boolean;
      latencyMs: number;
      error?: string;
    };
    storage: {
      ok: boolean;
      mode: 's3' | 'local';
      latencyMs: number;
      error?: string;
    };
    email: {
      mode: 'resend' | 'dev_outbox';
      configured: boolean;
      senderValid: boolean;
    };
    gemini: {
      configured: boolean;
    };
    googleAuth: {
      configured: boolean;
    };
  };
}

export async function checkDependencyReadiness(params: {
  db: DrizzleDb;
  storageProvider: ObjectStorageProvider;
  emailProvider: EmailProvider;
}): Promise<DependencyReadinessReport> {
  const dbStart = Date.now();
  let dbOk = false;
  let dbError: string | undefined;
  try {
    await params.db.execute(sql`SELECT 1 AS ok`);
    dbOk = true;
  } catch (err) {
    dbError = redactSensitiveText(err instanceof Error ? err.message : 'Database check failed');
    // Never leak low-level connection host/user details in readiness output
    if (dbError.length > 120) {
      dbError = 'Database readiness check failed.';
    }
  }
  const dbLatency = Date.now() - dbStart;

  const storageStart = Date.now();
  const storageCheck = await params.storageProvider.checkReadiness();
  const storageLatency = Date.now() - storageStart;

  const emailStatus = params.emailProvider.getStatus();
  const ready = dbOk && storageCheck.ok;

  return {
    status: ready ? 'ready' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    checks: {
      database: {
        ok: dbOk,
        latencyMs: dbLatency,
        ...(dbError ? { error: dbError } : {}),
      },
      storage: {
        ok: storageCheck.ok,
        mode: params.storageProvider.mode,
        latencyMs: storageLatency,
        ...(storageCheck.error ? { error: redactSensitiveText(storageCheck.error) } : {}),
      },
      email: emailStatus,
      gemini: {
        configured: !isPlaceholderSecret(process.env.GEMINI_API_KEY),
      },
      googleAuth: {
        configured: isGoogleAuthConfigured(),
      },
    },
  };
}

export function dispatchErrorTrackerHook(
  hook: ErrorTrackerHook | undefined,
  payload: Parameters<ErrorTrackerHook>[0]
) {
  if (hook) {
    Promise.resolve(hook(payload)).catch(() => undefined);
    return;
  }
  const webhookUrl = process.env.ERROR_WEBHOOK_URL?.trim();
  if (webhookUrl && process.env.NODE_ENV !== 'test') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitizeValue(payload)),
      signal: controller.signal,
    })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }
}
