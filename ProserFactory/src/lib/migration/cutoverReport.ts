import { createHash } from 'node:crypto';

export interface CutoverColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKeyOrdinal?: number;
  temporalPrecision?: number;
}

export interface CutoverTableReport {
  rowCount: number;
  rowDigest: string;
  primaryKeyDigest: string;
  columnDigests: Record<string, string>;
  nullCounts: Record<string, number>;
  aggregates: Record<string, string>;
}

export interface CutoverReport {
  version: 'proser-cutover-report-v2';
  tables: Record<string, CutoverTableReport>;
  totalRows: number;
  reportHash: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function normalizeDecimal(value: unknown): string {
  const raw = String(value);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return raw;
  const negative = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const normalizedInteger = integer.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/, '');
  const normalized = normalizedFraction
    ? `${normalizedInteger}.${normalizedFraction}`
    : normalizedInteger;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}

export function canonicalCutoverValue(
  value: unknown,
  dataType: string,
  temporalPrecision?: number,
): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `hex:${value.toString('hex')}`;
  const type = dataType.toLowerCase();
  if (type === 'boolean') {
    return value === true || value === 1 || value === '1' || value === 'true';
  }
  if (['smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision'].includes(type)) {
    return normalizeDecimal(value);
  }
  if (type.includes('timestamp')) {
    let date: Date;
    const raw = String(value);
    const precise = value instanceof Date
      ? undefined
      : raw.match(/^(.+?)(?:\.(\d+))([+-]\d{2}:\d{2}|Z)$/);
    if (precise && temporalPrecision !== undefined && temporalPrecision <= 3) {
      const [, base, fraction, zone] = precise;
      const fractionMilliseconds = Math.round(
        Number(`0.${fraction}`) * 1_000,
      );
      date = new Date(`${base}${zone}`);
      date = new Date(date.valueOf() + fractionMilliseconds);
    } else {
      date = value instanceof Date ? value : new Date(raw);
    }
    return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
  }
  if (type === 'date') {
    const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString().slice(0, 10);
  }
  if (type === 'json' || type === 'jsonb') {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return stableValue(parsed);
  }
  return String(value);
}

function digestLines(lines: string[]): string {
  const hash = createHash('sha256');
  for (const line of lines.sort()) {
    hash.update(String(Buffer.byteLength(line)));
    hash.update(':');
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function buildCutoverTableReport(
  columns: CutoverColumn[],
  rows: Array<Record<string, unknown>>,
): CutoverTableReport {
  const nullCounts = Object.fromEntries(columns.map((column) => [column.name, 0]));
  const aggregates: Record<string, string> = {};
  const numeric = columns.filter((column) =>
    ['smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision']
      .includes(column.dataType.toLowerCase()));
  const boolean = columns.filter((column) => column.dataType.toLowerCase() === 'boolean');
  const numericValues = new Map<string, string[]>(numeric.map((column) => [column.name, []]));
  const rowLines: string[] = [];
  const primaryKeyLines: string[] = [];
  const columnLines = new Map<string, string[]>(
    columns.map((column) => [column.name, []]),
  );
  const primaryKeys = columns
    .filter((column) => column.primaryKeyOrdinal !== undefined)
    .sort((left, right) => left.primaryKeyOrdinal! - right.primaryKeyOrdinal!);

  for (const row of rows) {
    const canonical = columns.map((column) => {
      const value = row[column.name];
      if (value === null || value === undefined) nullCounts[column.name] += 1;
      const normalized = canonicalCutoverValue(
        value,
        column.dataType,
        column.temporalPrecision,
      );
      columnLines.get(column.name)!.push(stableStringify(normalized));
      return normalized;
    });
    rowLines.push(stableStringify(canonical));
    primaryKeyLines.push(stableStringify(
      (primaryKeys.length ? primaryKeys : columns).map((column) =>
        canonicalCutoverValue(
          row[column.name],
          column.dataType,
          column.temporalPrecision,
        )),
    ));

    for (const column of numeric) {
      const value = canonicalCutoverValue(row[column.name], column.dataType);
      if (value === null) continue;
      numericValues.get(column.name)!.push(String(value));
    }
  }

  for (const column of numeric) {
    const values = numericValues.get(column.name)!.sort();
    aggregates[`sum:${column.name}`] = values.every((value) => /^-?\d+$/.test(value))
      ? String(values.reduce((sum, value) => sum + BigInt(value), 0n))
      : String(values.reduce((sum, value) => sum + Number(value), 0));
  }
  for (const column of boolean) {
    aggregates[`true:${column.name}`] = String(rows.reduce((count, row) =>
      count + (canonicalCutoverValue(
        row[column.name],
        column.dataType,
        column.temporalPrecision,
      ) === true ? 1 : 0), 0));
  }

  return {
    rowCount: rows.length,
    rowDigest: digestLines(rowLines),
    primaryKeyDigest: digestLines(primaryKeyLines),
    columnDigests: Object.fromEntries(
      columns.map((column) => [column.name, digestLines(columnLines.get(column.name)!)]),
    ),
    nullCounts,
    aggregates,
  };
}

export function finalizeCutoverReport(
  tables: Record<string, CutoverTableReport>,
): CutoverReport {
  const unsigned = {
    version: 'proser-cutover-report-v2' as const,
    tables: Object.fromEntries(Object.entries(tables).sort(([left], [right]) => left.localeCompare(right))),
    totalRows: Object.values(tables).reduce((sum, table) => sum + table.rowCount, 0),
  };
  return {
    ...unsigned,
    reportHash: createHash('sha256').update(stableStringify(unsigned)).digest('hex'),
  };
}
