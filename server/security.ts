import crypto from 'crypto';
import { Request, Response } from 'express';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

let ephemeralDevSecret: string | null = null;

export function getSigningSecret(): string {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET (>= 32 characters) must be configured in production. Failing closed.'
    );
  }
  if (!ephemeralDevSecret) {
    ephemeralDevSecret = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralDevSecret;
}

export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 128) return 'Password exceeds maximum length of 128 characters.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include at least one letter and one number.';
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, buf) => {
      if (err) reject(err);
      else resolve(buf);
    });
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash || !password) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expectedHex = parts[5];
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expectedHex) {
    return false;
  }

  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, expectedHex.length / 2, { N: n, r, p }, (err, buf) => {
      if (err) reject(err);
      else resolve(buf);
    });
  });
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(derived, expectedBuf);
}

export function generateSecureToken(byteLen = 32): string {
  return crypto.randomBytes(byteLen).toString('base64url');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function signHmac(payload: string): string {
  return crypto.createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
}

export function verifyHmac(payload: string, signature: string): boolean {
  if (!signature) return false;
  const expected = signHmac(payload);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const SESSION_COOKIE_NAME = 'nf_session';
export const CSRF_COOKIE_NAME = 'nf_csrf';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

function shouldUseSecureCookie(req: Request): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  return false;
}

export function setAuthCookies(
  req: Request,
  res: Response,
  rawSessionToken: string,
  csrfToken: string
): void {
  const secure = shouldUseSecureCookie(req);
  const sameSite = secure ? 'None' : 'Lax';
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);

  const sessionCookie = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawSessionToken)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSec}`,
    `SameSite=${sameSite}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');

  const csrfCookie = [
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    `SameSite=${sameSite}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');

  res.setHeader('Set-Cookie', [sessionCookie, csrfCookie]);
}

export function clearAuthCookies(req: Request, res: Response): void {
  const secure = shouldUseSecureCookie(req);
  const sameSite = secure ? 'None' : 'Lax';
  const expire = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; ${expire}; SameSite=${sameSite}${secure ? '; Secure' : ''}`,
    `${CSRF_COOKIE_NAME}=; Path=/; ${expire}; SameSite=${sameSite}${secure ? '; Secure' : ''}`,
  ]);
}

export function redactSensitiveText(raw: string): string {
  let msg = raw || '';
  for (const envName of ['GEMINI_API_KEY', 'SESSION_SECRET', 'SQL_PASSWORD', 'SQL_ADMIN_PASSWORD', 'S3_SECRET_ACCESS_KEY', 'RESEND_API_KEY']) {
    const val = process.env[envName];
    if (val && val.length > 4) {
      msg = msg.split(val).join('[REDACTED]');
    }
  }
  return msg.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}

export function slugifyOrgName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${base || 'org'}-${suffix}`;
}
