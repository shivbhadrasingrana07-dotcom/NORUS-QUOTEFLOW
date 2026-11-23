import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { signHmac, verifyHmac } from './security.ts';

export interface SignedDownloadResult {
  url: string;
  expiresAt: string;
}

export interface ObjectStorageProvider {
  readonly mode: 's3' | 'local';
  putObject(params: { key: string; buffer: Buffer; contentType: string }): Promise<void>;
  getObject(key: string): Promise<{ buffer: Buffer; contentType?: string }>;
  deleteObject(key: string): Promise<void>;
  createSignedDownloadUrl(params: {
    documentId: string;
    storageKey: string;
    organizationId: string;
    filename: string;
    expiresInSec?: number;
  }): Promise<SignedDownloadResult>;
  checkReadiness(): Promise<{ ok: boolean; error?: string }>;
}

export function sanitizeStorageKey(rawKey: string): string {
  const cleaned = rawKey
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('/');
  if (!cleaned) {
    throw new Error('Invalid object storage key.');
  }
  return cleaned;
}

export function buildDocumentStorageKey(organizationId: string, documentId: string, filename: string): string {
  const safeOrg = organizationId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeDoc = documentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeFile = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'document';
  return sanitizeStorageKey(`orgs/${safeOrg}/docs/${safeDoc}/${safeFile}`);
}

export function signLocalDocumentUrl(params: {
  documentId: string;
  organizationId: string;
  expiresInSec?: number;
}): SignedDownloadResult {
  const ttl = Math.max(30, Math.min(3600, params.expiresInSec ?? 300));
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${params.documentId}:${params.organizationId}:${exp}`;
  const sig = signHmac(payload);
  return {
    url: `/api/documents/${encodeURIComponent(params.documentId)}/content?org=${encodeURIComponent(
      params.organizationId
    )}&exp=${exp}&sig=${encodeURIComponent(sig)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifySignedDocumentToken(params: {
  documentId: string;
  organizationId: string;
  exp: number;
  sig: string;
}): boolean {
  if (!Number.isFinite(params.exp) || params.exp <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  const payload = `${params.documentId}:${params.organizationId}:${params.exp}`;
  return verifyHmac(payload, params.sig);
}

export class LocalPrivateStorageProvider implements ObjectStorageProvider {
  readonly mode = 'local' as const;
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = path.resolve(
      rootDir || process.env.LOCAL_STORAGE_DIR || path.join(process.cwd(), 'data', 'private-storage')
    );
  }

  private resolveSafePath(key: string): string {
    const safeKey = sanitizeStorageKey(key);
    const full = path.resolve(this.rootDir, safeKey);
    if (!full.startsWith(this.rootDir + path.sep) && full !== this.rootDir) {
      throw new Error('Storage key escapes private storage root.');
    }
    return full;
  }

  async putObject(params: { key: string; buffer: Buffer; contentType: string }): Promise<void> {
    const target = this.resolveSafePath(params.key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, params.buffer);
    await fs.promises.rename(tmp, target);
  }

  async getObject(key: string): Promise<{ buffer: Buffer; contentType?: string }> {
    const target = this.resolveSafePath(key);
    const buffer = await fs.promises.readFile(target);
    return { buffer };
  }

  async deleteObject(key: string): Promise<void> {
    const target = this.resolveSafePath(key);
    try {
      await fs.promises.unlink(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
  }

  async createSignedDownloadUrl(params: {
    documentId: string;
    storageKey: string;
    organizationId: string;
    filename: string;
    expiresInSec?: number;
  }): Promise<SignedDownloadResult> {
    return signLocalDocumentUrl({
      documentId: params.documentId,
      organizationId: params.organizationId,
      expiresInSec: params.expiresInSec,
    });
  }

  async checkReadiness(): Promise<{ ok: boolean; error?: string }> {
    try {
      await fs.promises.mkdir(this.rootDir, { recursive: true });
      await fs.promises.access(this.rootDir, fs.constants.R_OK | fs.constants.W_OK);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Local storage directory inaccessible.',
      };
    }
  }
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  requestTimeoutMs?: number;
  readinessTimeoutMs?: number;
}

const DEFAULT_S3_TIMEOUT_MS = 15_000;
const DEFAULT_S3_READINESS_TIMEOUT_MS = 5_000;

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256HexBuf(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export class S3CompatibleStorageProvider implements ObjectStorageProvider {
  readonly mode = 's3' as const;
  private readonly cfg: S3Config;
  private readonly requestTimeoutMs: number;
  private readonly readinessTimeoutMs: number;

  constructor(cfg: S3Config) {
    this.cfg = {
      ...cfg,
      endpoint: cfg.endpoint.replace(/\/+$/, ''),
    };
    this.requestTimeoutMs =
      cfg.requestTimeoutMs && cfg.requestTimeoutMs > 0
        ? cfg.requestTimeoutMs
        : DEFAULT_S3_TIMEOUT_MS;
    this.readinessTimeoutMs =
      cfg.readinessTimeoutMs && cfg.readinessTimeoutMs > 0
        ? cfg.readinessTimeoutMs
        : DEFAULT_S3_READINESS_TIMEOUT_MS;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = this.requestTimeoutMs
  ): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        throw new Error(`Object storage request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private getSigningKey(dateStamp: string): Buffer {
    const kDate = hmacSha256(`AWS4${this.cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, this.cfg.region);
    const kService = hmacSha256(kRegion, 's3');
    return hmacSha256(kService, 'aws4_request');
  }

  private buildObjectUrl(storageKey: string): { url: URL; canonicalUri: string } {
    const safeKey = sanitizeStorageKey(storageKey);
    const baseUrl = new URL(this.cfg.endpoint);
    const encodedKey = safeKey.split('/').map(encodeRfc3986).join('/');
    const basePath = baseUrl.pathname.replace(/\/+$/, '');
    const canonicalUri = `${basePath}/${encodeRfc3986(this.cfg.bucket)}/${encodedKey}`;
    const fullUrl = new URL(`${baseUrl.origin}${canonicalUri}`);
    return { url: fullUrl, canonicalUri };
  }

  private signRequest(params: {
    method: 'PUT' | 'GET' | 'DELETE';
    storageKey: string;
    payloadHash: string;
    contentType?: string;
  }): { url: string; headers: Record<string, string> } {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const { url, canonicalUri } = this.buildObjectUrl(params.storageKey);

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': params.payloadHash,
      'x-amz-date': amzDate,
    };
    if (params.contentType) {
      headers['content-type'] = params.contentType;
    }

    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedKeys.join(';');

    const canonicalRequest = [
      params.method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      params.payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256HexBuf(canonicalRequest),
    ].join('\n');

    const signingKey = this.getSigningKey(dateStamp);
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');

    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers.host;

    return { url: url.toString(), headers };
  }

  async putObject(params: { key: string; buffer: Buffer; contentType: string }): Promise<void> {
    const payloadHash = sha256HexBuf(params.buffer);
    const signed = this.signRequest({
      method: 'PUT',
      storageKey: params.key,
      payloadHash,
      contentType: params.contentType,
    });

    const res = await this.fetchWithTimeout(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: new Uint8Array(params.buffer),
    });

    if (!res.ok) {
      throw new Error(`Object storage PUT failed with status ${res.status}`);
    }
  }

  async getObject(key: string): Promise<{ buffer: Buffer; contentType?: string }> {
    const signed = this.signRequest({
      method: 'GET',
      storageKey: key,
      payloadHash: sha256HexBuf(''),
    });

    const res = await this.fetchWithTimeout(signed.url, {
      method: 'GET',
      headers: signed.headers,
    });

    if (!res.ok) {
      throw new Error(`Object storage GET failed with status ${res.status}`);
    }
    const arr = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arr),
      contentType: res.headers.get('content-type') || undefined,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const signed = this.signRequest({
      method: 'DELETE',
      storageKey: key,
      payloadHash: sha256HexBuf(''),
    });

    const res = await this.fetchWithTimeout(signed.url, {
      method: 'DELETE',
      headers: signed.headers,
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Object storage DELETE failed with status ${res.status}`);
    }
  }

  async createSignedDownloadUrl(params: {
    documentId: string;
    storageKey: string;
    organizationId: string;
    filename: string;
    expiresInSec?: number;
  }): Promise<SignedDownloadResult> {
    const ttl = Math.max(30, Math.min(3600, params.expiresInSec ?? 300));
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const { url, canonicalUri } = this.buildObjectUrl(params.storageKey);

    const credentialScope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const queryEntries: Array<[string, string]> = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.cfg.accessKeyId}/${credentialScope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(ttl)],
      ['X-Amz-SignedHeaders', 'host'],
      [
        'response-content-disposition',
        `inline; filename="${params.filename.replace(/["\r\n]/g, '_')}"`,
      ],
    ];
    queryEntries.sort((a, b) => a[0].localeCompare(b[0]));

    const canonicalQuery = queryEntries
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
      .join('&');

    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQuery,
      `host:${url.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256HexBuf(canonicalRequest),
    ].join('\n');

    const signature = crypto
      .createHmac('sha256', this.getSigningKey(dateStamp))
      .update(stringToSign, 'utf8')
      .digest('hex');

    return {
      url: `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    };
  }

  async checkReadiness(): Promise<{ ok: boolean; error?: string }> {
    try {
      const signed = this.signRequest({
        method: 'GET',
        storageKey: '.healthcheck',
        payloadHash: sha256HexBuf(''),
      });
      const res = await this.fetchWithTimeout(
        signed.url,
        { method: 'GET', headers: signed.headers },
        this.readinessTimeoutMs
      );
      if (res.ok || res.status === 404) {
        return { ok: true };
      }
      return { ok: false, error: `S3 storage returned status ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'S3 connectivity check failed.',
      };
    }
  }
}

export function createObjectStorageProvider(): ObjectStorageProvider {
  const mode = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
  if (mode === 's3') {
    const endpoint = process.env.S3_ENDPOINT?.trim();
    const region = process.env.S3_REGION?.trim() || 'auto';
    const bucket = process.env.S3_BUCKET?.trim();
    const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();

    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'STORAGE_PROVIDER=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY. Failing closed.'
      );
    }

    return new S3CompatibleStorageProvider({
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
    });
  }

  return new LocalPrivateStorageProvider();
}
