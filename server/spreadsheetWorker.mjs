import * as XLSX from 'xlsx';
import { pathToFileURL } from 'node:url';

export const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_ZIP_ENTRIES = 120;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 32 * 1024 * 1024; // 32 MB
export const MAX_ZIP_COMPRESSION_RATIO = 100;
export const MAX_WORKSHEETS = 12;
export const MAX_PARSED_ROWS = 250;
export const MAX_PARSED_COLS = 30;
export const MAX_CELLS_PER_SHEET = 5000;
export const MAX_TOTAL_CELLS = 15000;
export const MAX_PREVIEW_SHEETS = 4;
export const MAX_PREVIEW_ROWS = 60;
export const MAX_CELL_TEXT_LENGTH = 500;
export const SPREADSHEET_WORKER_TIMEOUT_MS = 5000;
export const SPREADSHEET_WORKER_MAX_OLD_SPACE_MB = 128;

export class SpreadsheetSecurityError extends Error {
  constructor(message, statusCode = 422) {
    super(message);
    this.name = 'SpreadsheetSecurityError';
    this.statusCode = statusCode;
  }
}

export function colIndexToLetter(index) {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function formatCellValue(cell) {
  if (!cell || typeof cell !== 'object') return '';
  let text = '';
  if (typeof cell.w === 'string' && cell.w.trim()) {
    text = cell.w;
  } else if (cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
    text = cell.v.toISOString().slice(0, 10);
  } else if (cell.v !== undefined && cell.v !== null) {
    text = String(cell.v);
  }
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > MAX_CELL_TEXT_LENGTH
    ? `${trimmed.slice(0, MAX_CELL_TEXT_LENGTH)}…`
    : trimmed;
}

function isZipBuffer(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) || (buffer[2] === 0x05 && buffer[3] === 0x06))
  );
}

function isOle2Buffer(buffer) {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  );
}

export function inspectXlsxZipContainer(buffer) {
  if (!isZipBuffer(buffer)) {
    throw new SpreadsheetSecurityError('Malformed OOXML ZIP container header.', 422);
  }

  // Locate End of Central Directory (0x06054b50) within max 64 KB comment window
  const minOffset = Math.max(0, buffer.length - 65557);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      const commentLen = buffer.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buffer.length) {
        eocdOffset = i;
        break;
      }
    }
  }

  if (eocdOffset === -1) {
    throw new SpreadsheetSecurityError('Malformed or truncated OOXML ZIP archive (missing EOCD).', 422);
  }

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const cdDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new SpreadsheetSecurityError('Multi-disk OOXML archives are not supported.', 422);
  }
  if (
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new SpreadsheetSecurityError('ZIP64 OOXML archives are not permitted.', 422);
  }
  if (totalEntries === 0 || totalEntries > MAX_ZIP_ENTRIES) {
    throw new SpreadsheetSecurityError(
      `Spreadsheet archive entry count (${totalEntries}) exceeds allowed limit of ${MAX_ZIP_ENTRIES}.`,
      422
    );
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new SpreadsheetSecurityError('Corrupt OOXML central directory offsets.', 422);
  }

  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (cursor + 46 > cdOffset + cdSize) {
      throw new SpreadsheetSecurityError('Truncated OOXML central directory entry.', 422);
    }
    const sig = buffer.readUInt32LE(cursor);
    if (sig !== 0x02014b50) {
      throw new SpreadsheetSecurityError('Invalid OOXML central directory signature.', 422);
    }

    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const recordEnd = cursor + 46 + fileNameLen + extraLen + commentLen;
    if (recordEnd > cdOffset + cdSize) {
      throw new SpreadsheetSecurityError('Corrupt OOXML central directory record length.', 422);
    }

    const entryName = buffer.subarray(cursor + 46, cursor + 46 + fileNameLen).toString('utf8');
    if (entryName.includes('..') || entryName.startsWith('/')) {
      throw new SpreadsheetSecurityError('Spreadsheet archive contains unsafe entry paths.', 422);
    }
    if (
      /(?:^|\/)vbaProject\.bin$/i.test(entryName) ||
      /^xl\/(?:macrosheets|dialogsheets|activeX)\//i.test(entryName)
    ) {
      throw new SpreadsheetSecurityError(
        'Macro-enabled or embedded VBA spreadsheets are not permitted.',
        415
      );
    }

    if (
      localHeaderOffset + 30 > cdOffset ||
      buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new SpreadsheetSecurityError('Corrupt OOXML local file header.', 422);
    }

    totalUncompressed += uncompressedSize;
    if (uncompressedSize > MAX_ZIP_UNCOMPRESSED_BYTES || totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new SpreadsheetSecurityError(
        `Spreadsheet uncompressed size exceeds safety cap (${Math.round(
          MAX_ZIP_UNCOMPRESSED_BYTES / (1024 * 1024)
        )} MB).`,
        422
      );
    }

    if (
      uncompressedSize > 64 * 1024 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > MAX_ZIP_COMPRESSION_RATIO)
    ) {
      throw new SpreadsheetSecurityError(
        'Spreadsheet archive rejected due to excessive compression ratio (ZIP bomb protection).',
        422
      );
    }

    cursor = recordEnd;
  }

  return { entryCount: totalEntries, totalUncompressedBytes: totalUncompressed };
}

export function parseDelimitedTextToRows(rawText) {
  const cleaned = rawText.replace(/^\uFEFF/, '');
  const rows = [];
  let currentRow = [];
  let field = '';
  let inQuotes = false;

  const pushCell = (val) => {
    if (currentRow.length >= MAX_PARSED_COLS) {
      if (val.trim()) {
        throw new SpreadsheetSecurityError(
          `CSV spreadsheet exceeds maximum ${MAX_PARSED_COLS} columns per row.`,
          422
        );
      }
      return;
    }
    const trimmed = val.trim();
    currentRow.push(
      trimmed.length > MAX_CELL_TEXT_LENGTH
        ? `${trimmed.slice(0, MAX_CELL_TEXT_LENGTH)}…`
        : trimmed
    );
  };

  const pushRow = () => {
    if (currentRow.some((c) => c !== '')) {
      if (rows.length >= MAX_PARSED_ROWS) {
        throw new SpreadsheetSecurityError(
          `CSV spreadsheet exceeds maximum ${MAX_PARSED_ROWS} populated rows.`,
          422
        );
      }
      rows.push(currentRow);
    }
    currentRow = [];
  };

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      pushCell(field);
      field = '';
    } else if (ch === '\r') {
      if (cleaned[i + 1] === '\n') i += 1;
      pushCell(field);
      field = '';
      pushRow();
    } else if (ch === '\n') {
      pushCell(field);
      field = '';
      pushRow();
    } else {
      field += ch;
    }
  }

  if (inQuotes) {
    throw new SpreadsheetSecurityError('Malformed CSV file: unterminated quoted cell.', 422);
  }
  if (field.length > 0 || currentRow.length > 0) {
    pushCell(field);
    pushRow();
  }

  let nonEmptyCells = 0;
  for (const row of rows) {
    for (const c of row) {
      if (c !== '') nonEmptyCells += 1;
    }
  }
  if (nonEmptyCells > MAX_CELLS_PER_SHEET) {
    throw new SpreadsheetSecurityError(
      `CSV spreadsheet exceeds maximum ${MAX_CELLS_PER_SHEET} populated cells.`,
      422
    );
  }

  return rows;
}

function buildSheetOutput(sheetName, rows) {
  const cellLines = [`=== SHEET: ${sheetName} ===`];
  rows.forEach((row, rIdx) => {
    const cells = row
      .map((val, cIdx) => (val ? `${colIndexToLetter(cIdx)}${rIdx + 1}: ${val}` : null))
      .filter(Boolean);
    if (cells.length > 0) {
      cellLines.push(`Row ${rIdx + 1} | ${cells.join(' | ')}`);
    }
  });
  return cellLines.join('\n');
}

export function parseSpreadsheetHardened(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    throw new SpreadsheetSecurityError('Uploaded spreadsheet file is empty.', 400);
  }
  if (buffer.byteLength > MAX_SPREADSHEET_BYTES) {
    throw new SpreadsheetSecurityError(
      `Spreadsheet file exceeds maximum ${Math.round(MAX_SPREADSHEET_BYTES / (1024 * 1024))} MB limit.`,
      413
    );
  }

  const docName = typeof options.documentName === 'string' ? options.documentName : '';
  const mimeType = typeof options.mimeType === 'string' ? options.mimeType.toLowerCase() : '';
  const looksCsv =
    (mimeType === 'text/csv' || /\.csv$/i.test(docName) || (!isZipBuffer(buffer) && !isOle2Buffer(buffer) && mimeType.includes('csv'))) &&
    !isZipBuffer(buffer) &&
    !isOle2Buffer(buffer);

  if (looksCsv) {
    const text = buffer.toString('utf8');
    if (text.includes('\u0000')) {
      throw new SpreadsheetSecurityError('CSV file contains binary NUL bytes.', 415);
    }
    const rows = parseDelimitedTextToRows(text);
    if (rows.length === 0) {
      return { structuredText: '', sheetPreview: [] };
    }
    const maxColCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const padded = rows.map((r) => {
      const next = r.slice();
      while (next.length < maxColCount) next.push('');
      return next;
    });
    return {
      structuredText: buildSheetOutput('CSV_Quote', padded),
      sheetPreview: [
        {
          sheetName: 'CSV_Quote',
          rows: padded.slice(0, MAX_PREVIEW_ROWS),
        },
      ],
    };
  }

  if (isZipBuffer(buffer)) {
    inspectXlsxZipContainer(buffer);
  } else if (!isOle2Buffer(buffer)) {
    // Plain UTF-8 text without CSV filename extension (e.g. direct Buffer invocation on raw CSV)
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
    if (sample.includes(0)) {
      throw new SpreadsheetSecurityError('Unsupported or corrupt binary spreadsheet format.', 422);
    }
    const rows = parseDelimitedTextToRows(buffer.toString('utf8'));
    if (rows.length === 0) {
      return { structuredText: '', sheetPreview: [] };
    }
    const maxColCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const padded = rows.map((r) => {
      const next = r.slice();
      while (next.length < maxColCount) next.push('');
      return next;
    });
    return {
      structuredText: buildSheetOutput('Sheet1', padded),
      sheetPreview: [
        {
          sheetName: 'Sheet1',
          rows: padded.slice(0, MAX_PREVIEW_ROWS),
        },
      ],
    };
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      cellNF: false,
      cellDates: true,
      bookVBA: false,
      sheetRows: MAX_PARSED_ROWS + 2,
    });
  } catch (err) {
    throw new SpreadsheetSecurityError(
      `Unable to parse spreadsheet file: ${err instanceof Error ? err.message : 'Invalid format'}`,
      422
    );
  }

  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) {
    throw new SpreadsheetSecurityError('Spreadsheet workbook contains no readable worksheets.', 422);
  }
  if (workbook.SheetNames.length > MAX_WORKSHEETS) {
    throw new SpreadsheetSecurityError(
      `Spreadsheet contains ${workbook.SheetNames.length} worksheets, exceeding limit of ${MAX_WORKSHEETS}.`,
      422
    );
  }

  const sheetPreview = [];
  const textBlocks = [];
  let totalPopulatedCells = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const cellKeys = Object.keys(sheet).filter((k) => !k.startsWith('!'));
    if (cellKeys.length > MAX_CELLS_PER_SHEET * 2) {
      throw new SpreadsheetSecurityError(
        `Worksheet "${sheetName}" exceeds maximum cell complexity (${MAX_CELLS_PER_SHEET} cells).`,
        422
      );
    }

    const rowMap = new Map();
    let maxRowIdx = -1;
    let maxColIdx = -1;
    let sheetPopulatedCells = 0;

    for (const key of cellKeys) {
      const val = formatCellValue(sheet[key]);
      if (!val) continue;
      const decoded = XLSX.utils.decode_cell(key);
      if (decoded.r >= MAX_PARSED_ROWS) {
        throw new SpreadsheetSecurityError(
          `Worksheet "${sheetName}" exceeds maximum ${MAX_PARSED_ROWS} rows per sheet.`,
          422
        );
      }
      if (decoded.c >= MAX_PARSED_COLS) {
        throw new SpreadsheetSecurityError(
          `Worksheet "${sheetName}" exceeds maximum ${MAX_PARSED_COLS} columns per sheet.`,
          422
        );
      }

      sheetPopulatedCells += 1;
      totalPopulatedCells += 1;
      if (sheetPopulatedCells > MAX_CELLS_PER_SHEET) {
        throw new SpreadsheetSecurityError(
          `Worksheet "${sheetName}" exceeds maximum ${MAX_CELLS_PER_SHEET} populated cells.`,
          422
        );
      }
      if (totalPopulatedCells > MAX_TOTAL_CELLS) {
        throw new SpreadsheetSecurityError(
          `Workbook exceeds maximum ${MAX_TOTAL_CELLS} total populated cells.`,
          422
        );
      }

      if (decoded.r > maxRowIdx) maxRowIdx = decoded.r;
      if (decoded.c > maxColIdx) maxColIdx = decoded.c;

      let colsForRow = rowMap.get(decoded.r);
      if (!colsForRow) {
        colsForRow = new Map();
        rowMap.set(decoded.r, colsForRow);
      }
      colsForRow.set(decoded.c, val);
    }

    if (sheetPopulatedCells === 0 || maxColIdx < 0 || maxRowIdx < 0) continue;

    const colCount = maxColIdx + 1;
    const sortedRowIndices = Array.from(rowMap.keys()).sort((a, b) => a - b);
    const nonEmptyRows = sortedRowIndices.map((rIdx) => {
      const arr = new Array(colCount).fill('');
      const colsForRow = rowMap.get(rIdx);
      if (colsForRow) {
        for (const [cIdx, val] of colsForRow.entries()) {
          arr[cIdx] = val;
        }
      }
      return arr;
    });

    if (sheetPreview.length < MAX_PREVIEW_SHEETS) {
      sheetPreview.push({
        sheetName,
        rows: nonEmptyRows.slice(0, MAX_PREVIEW_ROWS),
      });
    }

    textBlocks.push(buildSheetOutput(sheetName, nonEmptyRows));
  }

  return {
    structuredText: textBlocks.join('\n\n'),
    sheetPreview,
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const chunks = [];
  let totalChars = 0;
  const maxStdinChars = 16 * 1024 * 1024;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    totalChars += chunk.length;
    if (totalChars > maxStdinChars) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          statusCode: 413,
          message: 'Spreadsheet worker payload exceeded 16 MB limit.',
        })
      );
      process.exit(1);
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(chunks.join(''));
      const buf = Buffer.from(String(payload.base64 || ''), 'base64');
      const result = parseSpreadsheetHardened(buf, {
        documentName: payload.documentName,
        mimeType: payload.mimeType,
      });
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (err) {
      const statusCode =
        err instanceof SpreadsheetSecurityError && typeof err.statusCode === 'number'
          ? err.statusCode
          : 422;
      const message = err instanceof Error ? err.message : 'Unable to parse spreadsheet file.';
      process.stdout.write(JSON.stringify({ ok: false, statusCode, message }));
      process.exitCode = 0;
    }
  });
}
