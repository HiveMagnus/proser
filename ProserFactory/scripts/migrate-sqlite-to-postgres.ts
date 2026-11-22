import 'dotenv/config';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Client } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import {
  buildCutoverTableReport,
  finalizeCutoverReport,
  stableStringify,
  type CutoverColumn,
  type CutoverReport,
} from '../src/lib/migration/cutoverReport';

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  primary_key_ordinal: number | null;
  datetime_precision: number | null;
}

interface TableInfo {
  table_name: string;
}

interface ForeignKeyInfo {
  constraint_name: string;
  child_table: string;
  parent_table: string;
  child_columns: string[];
  parent_columns: string[];
  match_type: 'f' | 'p' | 's';
}

interface CheckConstraintInfo {
  table_name: string;
  constraint_name: string;
  expression: string;
}

interface ReceiptRow {
  operation_id: string;
  source_sha256: string;
  postgres_checkpoint_sha256: string;
  source_report_hash: string;
  target_report_hash: string;
  report: CutoverReport;
  evidence_signature: string;
}

const sqlitePath = resolve(process.env.SQLITE_DATABASE_PATH ?? 'data/proser.db');
const postgresUrl = process.env.DATABASE_URL;
const evidencePath = process.env.MIGRATION_EVIDENCE_PATH
  ? resolve(process.env.MIGRATION_EVIDENCE_PATH)
  : undefined;
const verifyExistingTarget = process.env.VERIFY_EXISTING_TARGET === '1';
const replaceExistingTarget = process.env.REPLACE_EXISTING_TARGET === '1';
const reportOnly = process.env.CUTOVER_REPORT_ONLY === '1';
const operationId = process.env.CUTOVER_OPERATION_ID;
const keyRotationId = process.env.CUTOVER_KEY_ROTATION_ID;
const expectedSourceSha256 = process.env.SQLITE_SOURCE_SHA256;
const checkpointPath = process.env.POSTGRES_CHECKPOINT_PATH
  ? resolve(process.env.POSTGRES_CHECKPOINT_PATH)
  : undefined;
const expectedCheckpointSha256 = process.env.POSTGRES_CHECKPOINT_SHA256;
const expectedReportHash = process.env.EXPECTED_SOURCE_REPORT_SHA256;
const signingKey = process.env.MIGRATION_EVIDENCE_SIGNING_KEY;

if (!postgresUrl?.startsWith('postgres')) {
  throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function requireSha256(name: string, value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${name} must be an explicit SHA-256 digest`);
  }
  return value.toLowerCase();
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk: Buffer) => hash.update(chunk));
  await once(stream, 'end');
  return hash.digest('hex');
}

function copyText(value: unknown, column: ColumnInfo): string {
  if (value === null || value === undefined) return String.raw`\N`;
  if (column.data_type === 'boolean') {
    return value === true || value === 1 || value === '1' || value === 'true' ? 't' : 'f';
  }
  if (Buffer.isBuffer(value)) return String.raw`\x${value.toString('hex')}`;
  return String(value)
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('\t', String.raw`\t`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\r', String.raw`\r`);
}

async function columnsFor(postgres: Client, table: string): Promise<ColumnInfo[]> {
  const columns = await postgres.query<ColumnInfo>(
    `
      SELECT
        columns.column_name,
        columns.data_type,
        columns.is_nullable,
        columns.datetime_precision,
        primary_keys.ordinality::int AS primary_key_ordinal
      FROM information_schema.columns AS columns
      LEFT JOIN LATERAL (
        SELECT keys.ordinality
        FROM pg_constraint
        CROSS JOIN LATERAL unnest(pg_constraint.conkey) WITH ORDINALITY AS keys(attnum, ordinality)
        WHERE pg_constraint.contype = 'p'
          AND pg_constraint.conrelid = format('%I.%I', columns.table_schema, columns.table_name)::regclass
          AND keys.attnum = (
            SELECT pg_attribute.attnum
            FROM pg_attribute
            WHERE pg_attribute.attrelid = pg_constraint.conrelid
              AND pg_attribute.attname = columns.column_name
          )
      ) AS primary_keys ON true
      WHERE columns.table_schema = 'public' AND columns.table_name = $1
      ORDER BY columns.ordinal_position
    `,
    [table],
  );
  return columns.rows;
}

function reportColumns(columns: ColumnInfo[]): CutoverColumn[] {
  return columns.map((column) => ({
    name: column.column_name,
    dataType: column.data_type,
    nullable: column.is_nullable === 'YES',
    primaryKeyOrdinal: column.primary_key_ordinal ?? undefined,
    temporalPrecision: column.datetime_precision ?? undefined,
  }));
}

async function buildReports(
  sqlite: Database.Database,
  postgres: Client,
  tables: TableInfo[],
  sourceTables: Set<string>,
): Promise<{ source: CutoverReport; target: CutoverReport }> {
  const sourceReports: Record<string, ReturnType<typeof buildCutoverTableReport>> = {};
  const targetReports: Record<string, ReturnType<typeof buildCutoverTableReport>> = {};
  for (const { table_name: table } of tables) {
    const columns = await columnsFor(postgres, table);
    const names = columns.map((column) => quoteIdentifier(column.column_name)).join(', ');
    const sourceRows = sourceTables.has(table)
      ? sqlite.prepare(`SELECT ${names} FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>
      : [];
    const targetRows = (await postgres.query<Record<string, unknown>>(
      `SELECT ${names} FROM ${quoteIdentifier(table)}`,
    )).rows;
    sourceReports[table] = buildCutoverTableReport(reportColumns(columns), sourceRows);
    targetReports[table] = buildCutoverTableReport(reportColumns(columns), targetRows);
  }
  return {
    source: finalizeCutoverReport(sourceReports),
    target: finalizeCutoverReport(targetReports),
  };
}

function assertReportsMatch(source: CutoverReport, target: CutoverReport): void {
  if (source.reportHash === target.reportHash) return;
  const mismatches = Object.keys(source.tables)
    .filter((table) => stableStringify(source.tables[table]) !== stableStringify(target.tables[table]))
    .slice(0, 10);
  throw new Error(
    `PostgreSQL content does not match SQLite; differing tables: ${mismatches.join(', ')}`,
  );
}

async function resetSequences(postgres: Client, tables: TableInfo[]): Promise<void> {
  for (const { table_name: table } of tables) {
    const serialColumns = await postgres.query<{ column_name: string; sequence_name: string }>(
      `
        SELECT column_name, pg_get_serial_sequence(
          quote_ident(table_schema) || '.' || quote_ident(table_name),
          column_name
        ) AS sequence_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_default LIKE 'nextval(%'
      `,
      [table],
    );
    for (const { column_name: column, sequence_name: sequence } of serialColumns.rows) {
      if (!sequence) continue;
      const maximum = await postgres.query<{ maximum: string | null }>(
        `SELECT MAX(${quoteIdentifier(column)})::text AS maximum FROM ${quoteIdentifier(table)}`,
      );
      const value = maximum.rows[0]?.maximum;
      if (value === null || value === undefined) {
        await postgres.query('SELECT setval($1::regclass, 1, false)', [sequence]);
      } else {
        await postgres.query('SELECT setval($1::regclass, $2::bigint, true)', [sequence, value]);
      }
    }
  }
}

async function validateTargetRelationships(postgres: Client): Promise<void> {
  const requiredColumns = await postgres.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND is_nullable = 'NO'
      AND table_name NOT IN ('_prisma_migrations', '_proser_cutover_receipts')
  `);
  for (const column of requiredColumns.rows) {
    const violation = await postgres.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM ${quoteIdentifier(column.table_name)}
       WHERE ${quoteIdentifier(column.column_name)} IS NULL`,
    );
    if (Number(violation.rows[0]?.count ?? 0) > 0) {
      throw new Error(
        `Target not-null constraint failed: ${column.table_name}.${column.column_name}`,
      );
    }
  }

  const foreignKeys = await postgres.query<ForeignKeyInfo>(`
    SELECT
      fk_constraint.conname AS constraint_name,
      child.relname AS child_table,
      parent.relname AS parent_table,
      to_json(ARRAY(
        SELECT attribute.attname
        FROM unnest(fk_constraint.conkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = fk_constraint.conrelid AND attribute.attnum = key.attnum
        ORDER BY key.position
      )) AS child_columns,
      to_json(ARRAY(
        SELECT attribute.attname
        FROM unnest(fk_constraint.confkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = fk_constraint.confrelid AND attribute.attnum = key.attnum
        ORDER BY key.position
      )) AS parent_columns,
      fk_constraint.confmatchtype AS match_type
    FROM pg_constraint AS fk_constraint
    JOIN pg_class AS child ON child.oid = fk_constraint.conrelid
    JOIN pg_class AS parent ON parent.oid = fk_constraint.confrelid
    JOIN pg_namespace AS namespace ON namespace.oid = child.relnamespace
    WHERE fk_constraint.contype = 'f' AND namespace.nspname = 'public'
  `);
  for (const foreignKey of foreignKeys.rows) {
    const join = foreignKey.child_columns.map((column, index) =>
      `child.${quoteIdentifier(column)} = parent.${quoteIdentifier(foreignKey.parent_columns[index]!)}`,
    ).join(' AND ');
    const childPresent = foreignKey.match_type === 'f'
      ? foreignKey.child_columns.map((column) => `child.${quoteIdentifier(column)} IS NOT NULL`).join(' OR ')
      : foreignKey.child_columns.map((column) => `child.${quoteIdentifier(column)} IS NOT NULL`).join(' AND ');
    const missingParent = foreignKey.parent_columns
      .map((column) => `parent.${quoteIdentifier(column)} IS NULL`).join(' AND ');
    const violation = await postgres.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM ${quoteIdentifier(foreignKey.child_table)} AS child
       LEFT JOIN ${quoteIdentifier(foreignKey.parent_table)} AS parent ON ${join}
       WHERE (${childPresent}) AND (${missingParent})`,
    );
    if (Number(violation.rows[0]?.count ?? 0) > 0) {
      throw new Error(`Target foreign-key orphan check failed: ${foreignKey.constraint_name}`);
    }
  }

  const checks = await postgres.query<CheckConstraintInfo>(`
    SELECT
      relation.relname AS table_name,
      check_constraint.conname AS constraint_name,
      pg_get_expr(check_constraint.conbin, check_constraint.conrelid) AS expression
    FROM pg_constraint AS check_constraint
    JOIN pg_class AS relation ON relation.oid = check_constraint.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE check_constraint.contype = 'c' AND namespace.nspname = 'public'
  `);
  for (const check of checks.rows) {
    const violation = await postgres.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM ${quoteIdentifier(check.table_name)}
       WHERE (${check.expression}) IS FALSE`,
    );
    if (Number(violation.rows[0]?.count ?? 0) > 0) {
      throw new Error(`Target check constraint failed: ${check.constraint_name}`);
    }
  }
}

async function representativeApplicationReads(postgres: Client): Promise<void> {
  await postgres.query(`
    SELECT books.id, users.id AS owner_id
    FROM books
    JOIN users ON users.id = books.user_id
    ORDER BY books.id
    LIMIT 10
  `);
  await postgres.query(`
    SELECT scenes.id, chapters.id AS chapter_id, acts.id AS act_id, books.id AS book_id
    FROM scenes
    JOIN chapters ON chapters.id = scenes.chapter_id
    JOIN acts ON acts.id = chapters.act_id
    JOIN books ON books.id = acts.book_id
    ORDER BY scenes.id
    LIMIT 10
  `);
}

function signedEvidence(
  sourceSha256: string,
  checkpointSha256: string,
  reports: { source: CutoverReport; target: CutoverReport },
): { payload: Record<string, unknown>; signature: string } {
  if (!operationId || !/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)) {
    throw new Error('CUTOVER_OPERATION_ID must identify the approved maintenance-window operation');
  }
  if (!signingKey || Buffer.byteLength(signingKey) < 32) {
    throw new Error('MIGRATION_EVIDENCE_SIGNING_KEY must contain at least 32 bytes');
  }
  const payload = {
    version: 'proser-cutover-evidence-v2',
    operationId,
    recordedAt: new Date().toISOString(),
    sqliteSourceSha256: sourceSha256,
    postgresCheckpointSha256: checkpointSha256,
    sourceReportHash: reports.source.reportHash,
    targetReportHash: reports.target.reportHash,
    report: reports.source,
  };
  const signature = createHmac('sha256', signingKey)
    .update(stableStringify(payload))
    .digest('hex');
  return { payload, signature };
}

function assertReceiptEvidenceStructure(
  receipt: ReceiptRow,
  evidence: Record<string, unknown>,
  signature: string,
): CutoverReport {
  const matchesReceipt = evidence.operationId === receipt.operation_id
    && evidence.sqliteSourceSha256 === receipt.source_sha256
    && evidence.postgresCheckpointSha256 === receipt.postgres_checkpoint_sha256
    && evidence.sourceReportHash === receipt.source_report_hash
    && evidence.targetReportHash === receipt.target_report_hash
    && signature === receipt.evidence_signature;
  if (!matchesReceipt) throw new Error('Signed cutover evidence does not match PostgreSQL receipt');

  const report = evidence.report as CutoverReport | undefined;
  if (!report || report.version !== 'proser-cutover-report-v2' || !report.tables) {
    throw new Error('Signed cutover evidence contains an invalid source report');
  }
  const canonicalReport = finalizeCutoverReport(report.tables);
  if (
    stableStringify(canonicalReport) !== stableStringify(report)
    || report.reportHash !== receipt.source_report_hash
    || stableStringify(report) !== stableStringify(receipt.report)
  ) {
    throw new Error('Signed cutover evidence report does not match the receipted source report');
  }
  return report;
}

async function rotateReceiptEvidenceKey(
  postgres: Client,
  receipt: ReceiptRow,
  originalEvidenceText: string,
  evidence: Record<string, unknown>,
  previousSignature: string,
): Promise<void> {
  if (!keyRotationId || !/^[A-Za-z0-9._:-]{8,200}$/.test(keyRotationId)) {
    throw new Error('CUTOVER_KEY_ROTATION_ID must identify the approved maintenance operation');
  }
  if (!evidencePath) throw new Error('MIGRATION_EVIDENCE_PATH is required');
  if (!signingKey || Buffer.byteLength(signingKey) < 32) {
    throw new Error('MIGRATION_EVIDENCE_SIGNING_KEY must contain at least 32 bytes');
  }
  for (const service of ['proser-factory.service', 'proser-worker.service']) {
    const status = spawnSync('systemctl', ['is-active', '--quiet', service], { stdio: 'ignore' });
    if (status.error || (status.status !== 0 && status.status !== 3)) {
      throw new Error(`Cutover key rotation could not verify quiescence for ${service}`);
    }
    if (status.status === 0) {
      throw new Error(`Cutover key rotation requires ${service} to be inactive`);
    }
  }
  const sourceSha256 = await fileSha256(sqlitePath);
  if (sourceSha256 !== receipt.source_sha256) {
    throw new Error('Cutover key rotation refused: SQLite source SHA-256 differs from the receipt');
  }

  await validateTargetRelationships(postgres);
  await representativeApplicationReads(postgres);

  const rotatedPayload = {
    ...evidence,
    keyRotation: {
      operationId: keyRotationId,
      rotatedAt: new Date().toISOString(),
      previousSignatureSha256: createHash('sha256').update(previousSignature).digest('hex'),
    },
  };
  const nextSignature = createHmac('sha256', signingKey)
    .update(stableStringify(rotatedPayload))
    .digest('hex');
  const archivePath = `${evidencePath}.pre-key-rotation-${keyRotationId}`;
  const pendingPath = `${evidencePath}.pending-key-rotation-${keyRotationId}`;
  const restorePath = `${evidencePath}.restore-key-rotation-${keyRotationId}`;

  await copyFile(evidencePath, archivePath, fsConstants.COPYFILE_EXCL);
  await chmod(archivePath, 0o600);
  await writeFile(
    pendingPath,
    `${JSON.stringify({ ...rotatedPayload, signature: nextSignature }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );

  let evidenceReplaced = false;
  let committed = false;
  try {
    await postgres.query('BEGIN');
    const updated = await postgres.query(
      `UPDATE "_proser_cutover_receipts"
       SET evidence_signature = $1
       WHERE operation_id = $2 AND evidence_signature = $3`,
      [nextSignature, receipt.operation_id, previousSignature],
    );
    if (updated.rowCount !== 1) {
      throw new Error('Cutover receipt changed during key rotation');
    }
    await rename(pendingPath, evidencePath);
    evidenceReplaced = true;
    await postgres.query('COMMIT');
    committed = true;
  } catch (error) {
    await postgres.query('ROLLBACK').catch(() => undefined);
    if (!committed) {
      const persisted = await postgres.query<{ evidence_signature: string }>(
        `SELECT evidence_signature FROM "_proser_cutover_receipts" WHERE operation_id = $1`,
        [receipt.operation_id],
      ).catch(() => ({ rows: [] }));
      committed = persisted.rows[0]?.evidence_signature === nextSignature;
    }
    if (evidenceReplaced && !committed) {
      await writeFile(restorePath, originalEvidenceText, { mode: 0o600, flag: 'wx' });
      await rename(restorePath, evidencePath);
    }
    throw error;
  }
  process.stdout.write(`Cutover evidence signing key rotated for operation ${keyRotationId}\n`);
}

async function verifyReceiptEvidence(postgres: Client, receipt: ReceiptRow): Promise<void> {
  if (!evidencePath) throw new Error('MIGRATION_EVIDENCE_PATH is required');
  if (!signingKey || Buffer.byteLength(signingKey) < 32) {
    throw new Error('MIGRATION_EVIDENCE_SIGNING_KEY must contain at least 32 bytes');
  }
  const originalEvidenceText = await readFile(evidencePath, 'utf8');
  const evidence = JSON.parse(originalEvidenceText) as Record<string, unknown>;
  const signature = String(evidence.signature ?? '');
  delete evidence.signature;
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error('Signed cutover evidence signature is malformed');
  }
  assertReceiptEvidenceStructure(receipt, evidence, signature);
  const expectedSignature = createHmac('sha256', signingKey)
    .update(stableStringify(evidence))
    .digest('hex');
  if (timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
    return;
  }
  if (!keyRotationId) throw new Error('Signed cutover evidence verification failed');
  await rotateReceiptEvidenceKey(postgres, receipt, originalEvidenceText, evidence, signature);
}

async function main(): Promise<void> {
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  sqlite.pragma('busy_timeout = 30000');
  const integrity = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('SQLite integrity check failed');
  }
  const foreignKeyViolations = sqlite.pragma('foreign_key_check') as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new Error(`SQLite foreign-key check found ${foreignKeyViolations.length} violation(s)`);
  }

  const postgres = new Client({ connectionString: postgresUrl });
  await postgres.connect();
  try {
    const receipt = await postgres.query<ReceiptRow>(
      `SELECT operation_id, source_sha256, postgres_checkpoint_sha256,
              source_report_hash, target_report_hash, report, evidence_signature
       FROM "_proser_cutover_receipts"
       ORDER BY recorded_at DESC LIMIT 1`,
    ).catch((error: unknown) => {
      if ((error as { code?: string }).code === '42P01' && reportOnly) {
        return { rows: [] };
      }
      throw error;
    });
    if (receipt.rows[0]) {
      await verifyReceiptEvidence(postgres, receipt.rows[0]);
      process.stdout.write(
        `PostgreSQL cutover receipt ${receipt.rows[0].operation_id} present; SQLite import skipped\n`,
      );
      return;
    }

    const targetTables = await postgres.query<TableInfo>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('_prisma_migrations', '_proser_cutover_receipts')
      ORDER BY table_name
    `);
    if (targetTables.rows.length === 0) {
      throw new Error('PostgreSQL schema is empty; run Prisma migrations before importing data');
    }
    const sourceTableRows = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const sourceTables = new Set(sourceTableRows.map((row) => row.name));
    const targetTableNames = new Set(targetTables.rows.map((row) => row.table_name));
    for (const table of [...sourceTables].filter((name) => !targetTableNames.has(name))) {
      const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number };
      if (row.count > 0) {
        throw new Error(`Source table ${table} has data but is absent from PostgreSQL`);
      }
    }

    const sourceSha256 = await fileSha256(sqlitePath);
    if (reportOnly) {
      const reports = await buildReports(sqlite, postgres, targetTables.rows, sourceTables);
      process.stdout.write(`${JSON.stringify({ sqliteSourceSha256: sourceSha256, ...reports }, null, 2)}\n`);
      return;
    }

    const requiredSourceSha256 = requireSha256('SQLITE_SOURCE_SHA256', expectedSourceSha256);
    if (sourceSha256 !== requiredSourceSha256) throw new Error('SQLite source hash changed');
    if (!checkpointPath) throw new Error('POSTGRES_CHECKPOINT_PATH is required');
    const checkpointSha256 = await fileSha256(checkpointPath);
    if (checkpointSha256 !== requireSha256('POSTGRES_CHECKPOINT_SHA256', expectedCheckpointSha256)) {
      throw new Error('PostgreSQL checkpoint hash changed');
    }
    const requiredReportHash = requireSha256('EXPECTED_SOURCE_REPORT_SHA256', expectedReportHash);

    const populatedTargets: string[] = [];
    for (const { table_name: table } of targetTables.rows) {
      const result = await postgres.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(table)}`,
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) populatedTargets.push(table);
    }
    if (populatedTargets.length > 0 && !verifyExistingTarget && !replaceExistingTarget) {
      throw new Error(
        `PostgreSQL target contains data but has no cutover receipt; fail-closed: ${populatedTargets.join(', ')}`,
      );
    }
    if (replaceExistingTarget && !verifyExistingTarget) {
      throw new Error('Destructive replacement also requires VERIFY_EXISTING_TARGET=1');
    }

    await postgres.query('BEGIN');
    try {
      if (replaceExistingTarget || populatedTargets.length === 0) {
        await postgres.query('SET LOCAL session_replication_role = replica');
        if (populatedTargets.length > 0) {
          const targetList = targetTables.rows
            .map(({ table_name }) => quoteIdentifier(table_name))
            .join(', ');
          await postgres.query(`TRUNCATE TABLE ${targetList} RESTART IDENTITY CASCADE`);
        }
        for (const { table_name: table } of targetTables.rows) {
          if (!sourceTables.has(table)) continue;
          const columns = await columnsFor(postgres, table);
          const sourceColumns = new Set(
            (sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>)
              .map((column) => column.name),
          );
          const missing = columns.filter((column) => !sourceColumns.has(column.column_name));
          if (missing.length) {
            throw new Error(`SQLite table ${table} is missing columns: ${missing.map((column) => column.column_name).join(', ')}`);
          }
          const names = columns.map((column) => quoteIdentifier(column.column_name)).join(', ');
          const copyStream = postgres.query(
            copyFrom(`COPY ${quoteIdentifier(table)} (${names}) FROM STDIN`),
          );
          let count = 0;
          for (const row of sqlite.prepare(`SELECT ${names} FROM ${quoteIdentifier(table)}`).iterate() as Iterable<Record<string, unknown>>) {
            const line = `${columns.map((column) => copyText(row[column.column_name], column)).join('\t')}\n`;
            if (!copyStream.write(line)) await once(copyStream, 'drain');
            count += 1;
          }
          copyStream.end();
          await once(copyStream, 'finish');
          process.stdout.write(`Migrated ${table}: ${count} row(s)\n`);
        }
        await resetSequences(postgres, targetTables.rows);
      }

      await postgres.query('SET LOCAL session_replication_role = origin');
      await validateTargetRelationships(postgres);
      const reports = await buildReports(sqlite, postgres, targetTables.rows, sourceTables);
      if (reports.source.reportHash !== requiredReportHash) {
        throw new Error('Expected source row/digest report does not match the current SQLite source');
      }
      assertReportsMatch(reports.source, reports.target);
      await representativeApplicationReads(postgres);
      const evidence = signedEvidence(sourceSha256, checkpointSha256, reports);
      if (!evidencePath) throw new Error('MIGRATION_EVIDENCE_PATH is required');
      const temporaryEvidencePath = `${evidencePath}.pending-${operationId}`;
      await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
      await writeFile(
        temporaryEvidencePath,
        `${JSON.stringify({ ...evidence.payload, signature: evidence.signature }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await postgres.query(
        `INSERT INTO "_proser_cutover_receipts" (
          operation_id, source_sha256, postgres_checkpoint_sha256,
          source_report_hash, target_report_hash, report, evidence_signature
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          operationId,
          sourceSha256,
          checkpointSha256,
          reports.source.reportHash,
          reports.target.reportHash,
          JSON.stringify(reports.source),
          evidence.signature,
        ],
      );
      await postgres.query('COMMIT');
      await rename(temporaryEvidencePath, evidencePath);
      process.stdout.write(
        `Migration verified and receipted: ${reports.target.totalRows} row(s) across ${Object.keys(reports.target.tables).length} table(s)\n`,
      );
    } catch (error) {
      await postgres.query('ROLLBACK');
      throw error;
    }
  } finally {
    sqlite.close();
    await postgres.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
