import path from 'path';

export interface ValidatedUpload {
  ok: true;
  detectedMime: string;
  extension: string;
  safeFilename: string;
}

export interface RejectedUpload {
  ok: false;
  status: number;
  error: string;
}

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.xlsx',
  '.xls',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
]);

const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.sh',
  '.bat',
  '.cmd',
  '.js',
  '.mjs',
  '.html',
  '.htm',
  '.svg',
  '.xlsm',
  '.docm',
  '.zip',
]);

export function sanitizeFilename(rawName: string): string {
  const normalized = (rawName || 'quotation').replace(/\\/g, '/');
  const base = path.basename(normalized).replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_');
  const trimmed = base.replace(/^\.+/, '').slice(0, 140);
  return trimmed || 'quotation_upload';
}

function isLikelyUtf8Text(buf: Buffer): boolean {
  // Reject NUL bytes and excessive non-printable ASCII control chars
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) {
      return false;
    }
  }
  return true;
}

export function validateUploadedFile(
  buffer: Buffer,
  originalname: string,
  declaredMime: string
): ValidatedUpload | RejectedUpload {
  if (!buffer || buffer.length === 0) {
    return { ok: false, status: 400, error: 'Uploaded file is empty.' };
  }

  const safeFilename = sanitizeFilename(originalname);
  const ext = path.extname(safeFilename).toLowerCase();

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      status: 415,
      error: `Unsupported or unsafe file extension "${ext}". Macro-enabled workbooks, scripts, HTML, and SVG files are blocked.`,
    };
  }

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      status: 415,
      error: `Unsupported file type "${ext || declaredMime}". Allowed: PDF, XLSX, XLS, CSV, PNG, JPG, WEBP.`,
    };
  }

  // Magic-byte inspection
  const head = buffer.subarray(0, 16);

  if (ext === '.pdf') {
    if (head.subarray(0, 5).toString('ascii') !== '%PDF-') {
      return {
        ok: false,
        status: 415,
        error: 'File content does not match PDF signature (%PDF-).',
      };
    }
    return { ok: true, detectedMime: 'application/pdf', extension: ext, safeFilename };
  }

  if (ext === '.png') {
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!head.subarray(0, 8).equals(pngSig)) {
      return { ok: false, status: 415, error: 'File content does not match PNG signature.' };
    }
    return { ok: true, detectedMime: 'image/png', extension: ext, safeFilename };
  }

  if (ext === '.jpg' || ext === '.jpeg') {
    if (!(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)) {
      return { ok: false, status: 415, error: 'File content does not match JPEG signature.' };
    }
    return { ok: true, detectedMime: 'image/jpeg', extension: ext, safeFilename };
  }

  if (ext === '.webp') {
    const riff = head.subarray(0, 4).toString('ascii') === 'RIFF';
    const webp = head.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!riff || !webp) {
      return { ok: false, status: 415, error: 'File content does not match WEBP signature.' };
    }
    return { ok: true, detectedMime: 'image/webp', extension: ext, safeFilename };
  }

  if (ext === '.xlsx') {
    const isZip = head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05);
    if (!isZip) {
      return { ok: false, status: 415, error: 'File content does not match XLSX (OpenXML ZIP) signature.' };
    }
    return {
      ok: true,
      detectedMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: ext,
      safeFilename,
    };
  }

  if (ext === '.xls') {
    const isOle =
      head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
    const isTextTable = isLikelyUtf8Text(buffer);
    if (!isOle && !isTextTable) {
      return { ok: false, status: 415, error: 'File content does not match XLS signature.' };
    }
    return { ok: true, detectedMime: 'application/vnd.ms-excel', extension: ext, safeFilename };
  }

  // .csv
  if (!isLikelyUtf8Text(buffer)) {
    return { ok: false, status: 415, error: 'CSV file contains binary or non-text bytes.' };
  }
  return { ok: true, detectedMime: 'text/csv', extension: ext, safeFilename };
}
