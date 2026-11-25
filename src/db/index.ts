import fs from 'fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';
import { redactSensitiveText } from '../../server/security.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

export function isSqlEnvConfigured(): boolean {
  return Boolean(
    process.env.SQL_HOST &&
      process.env.SQL_USER &&
      process.env.SQL_PASSWORD !== undefined &&
      process.env.SQL_DB_NAME
  );
}

export function buildPgSslConfig(
  env: Record<string, string | undefined> = process.env
): { rejectUnauthorized: boolean; ca?: string } | undefined {
  if ((env.SQL_SSL || '').trim().toLowerCase() !== 'true') {
    return undefined;
  }
  const host = (env.SQL_HOST || '').trim();
  // Cloud SQL Auth Proxy / Unix domain socket connections do not use TCP TLS
  if (host.startsWith('/')) {
    return undefined;
  }

  const rawCa = env.SQL_SSL_CA?.trim();
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

  const allowSelfSigned = (env.SQL_SSL_ALLOW_SELF_SIGNED || '').trim().toLowerCase() === 'true';
  return {
    rejectUnauthorized: !allowSelfSigned,
    ...(ca ? { ca } : {}),
  };
}

export const createPool = () => {
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      host: process.env.SQL_HOST,
      port: process.env.SQL_PORT ? Number(process.env.SQL_PORT) : undefined,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
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
