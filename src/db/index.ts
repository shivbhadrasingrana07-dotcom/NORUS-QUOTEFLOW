import fs from 'fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';
import {
  isMaskedEnvPlaceholder,
  isPlaceholderSecret,
  normalizeOptionalEnvValue,
  redactSensitiveText,
  stripSurroundingQuotes,
} from '../../server/security.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

export function resolveSqlPassword(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (env.SQL_PASSWORD === undefined || isMaskedEnvPlaceholder(env.SQL_PASSWORD)) {
    return undefined;
  }
  return stripSurroundingQuotes(env.SQL_PASSWORD);
}

export function isSqlEnvConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  const isProd = normalizeOptionalEnvValue(env.NODE_ENV).toLowerCase() === 'production';
  const passwordValid = isProd
    ? !isPlaceholderSecret(env.SQL_PASSWORD)
    : env.SQL_PASSWORD !== undefined && !isMaskedEnvPlaceholder(env.SQL_PASSWORD);
  return Boolean(
    normalizeOptionalEnvValue(env.SQL_HOST) &&
      normalizeOptionalEnvValue(env.SQL_USER) &&
      passwordValid &&
      normalizeOptionalEnvValue(env.SQL_DB_NAME)
  );
}

export function validateProductionSqlConfig(
  env: Record<string, string | undefined> = process.env
): void {
  if (
    !isSqlEnvConfigured(env) ||
    isPlaceholderSecret(env.SQL_HOST) ||
    isPlaceholderSecret(env.SQL_USER) ||
    isPlaceholderSecret(env.SQL_PASSWORD) ||
    isPlaceholderSecret(env.SQL_DB_NAME)
  ) {
    throw new Error(
      'PostgreSQL configuration (SQL_HOST, SQL_USER, SQL_PASSWORD, SQL_DB_NAME) must be non-placeholder and is required in production. Failing closed.'
    );
  }
}

export function buildPgSslConfig(
  env: Record<string, string | undefined> = process.env
): { rejectUnauthorized: boolean; ca?: string } | undefined {
  if (normalizeOptionalEnvValue(env.SQL_SSL).toLowerCase() !== 'true') {
    return undefined;
  }
  const host = normalizeOptionalEnvValue(env.SQL_HOST);
  // Cloud SQL Auth Proxy / Unix domain socket connections do not use TCP TLS
  if (host.startsWith('/')) {
    return undefined;
  }

  const rawCa = normalizeOptionalEnvValue(env.SQL_SSL_CA);
  let ca: string | undefined;
  if (rawCa) {
    if (rawCa.includes('BEGIN CERTIFICATE')) {
      ca = rawCa.replace(/\\n/g, '\n');
    } else {
      try {
        ca = fs.readFileSync(rawCa, 'utf8');
      } catch {
        throw new Error(`Configuration error: Unable to read SQL_SSL_CA certificate file at "${rawCa}".`);
      }
    }
  }

  const allowSelfSigned =
    normalizeOptionalEnvValue(env.SQL_SSL_ALLOW_SELF_SIGNED).toLowerCase() === 'true';
  return {
    rejectUnauthorized: !allowSelfSigned,
    ...(ca ? { ca } : {}),
  };
}

export const createPool = () => {
  if (!global._postgresPool) {
    const rawPort = normalizeOptionalEnvValue(process.env.SQL_PORT);
    const parsedPort = /^\d+$/.test(rawPort) ? Number(rawPort) : undefined;
    global._postgresPool = new Pool({
      host: normalizeOptionalEnvValue(process.env.SQL_HOST) || undefined,
      port:
        parsedPort && Number.isSafeInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
          ? parsedPort
          : undefined,
      user: normalizeOptionalEnvValue(process.env.SQL_USER) || undefined,
      password: resolveSqlPassword(process.env),
      database: normalizeOptionalEnvValue(process.env.SQL_DB_NAME) || undefined,
      ssl: buildPgSslConfig(process.env),
      max: 10,
      connectionTimeoutMillis: 15000,
    });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', redactSensitiveText(err.message));
    });
  }
  return global._postgresPool;
};

export const pool = createPool();
export const db = drizzle(pool, { schema });
export type DrizzleDb = typeof db;
