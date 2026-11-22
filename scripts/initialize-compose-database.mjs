import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Client } from "pg";

const url = new URL(process.env.DATABASE_URL);
if (
  url.protocol !== "postgresql:" ||
  url.hostname !== "postgres" ||
  url.port !== "5432" ||
  url.pathname !== "/proser" ||
  url.username !== "proser"
) {
  throw new Error(
    "Compose initialization requires the project-local PostgreSQL service.",
  );
}

const sql = await readFile("deploy/document-authority/enforcement.sql", "utf8");
const revision = (await readFile("REVISION", "utf8")).trim();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const prisma = (action) =>
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", action],
    {
      stdio: "inherit",
    },
  );

const client = new Client({ connectionString: url.href });
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(12848, 1027)");
  const {
    rows: [state],
  } = await client.query(`
    SELECT
      to_regclass('proser_compose.bootstrap') IS NOT NULL AS managed,
      EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace)
        AS existing
  `);
  if (!state.managed && state.existing) {
    throw new Error(
      "Existing databases require the reviewed Proser migration procedure.",
    );
  }
  if (!state.managed) {
    await client.query(`
      BEGIN;
      CREATE SCHEMA proser_compose;
      CREATE TABLE proser_compose.bootstrap (
        singleton boolean PRIMARY KEY CHECK (singleton),
        enforcement_sha256 text,
        evidence text
      );
      INSERT INTO proser_compose.bootstrap(singleton) VALUES (true);
      COMMIT;
    `);
  }
  const {
    rows: [bootstrap],
  } = await client.query(
    "SELECT enforcement_sha256, evidence FROM proser_compose.bootstrap WHERE singleton",
  );
  if (!bootstrap)
    throw new Error("Compose database bootstrap state is missing.");
  if (bootstrap.enforcement_sha256) {
    if (bootstrap.enforcement_sha256 !== digest(sql)) {
      throw new Error(
        "Existing databases require reviewed document enforcement changes.",
      );
    }
    const {
      rows: [activation],
    } = await client.query(
      "SELECT enabled, rehearsal_sha256 FROM proser_document_enforcement WHERE singleton",
    );
    if (
      !activation?.enabled ||
      !bootstrap.evidence ||
      activation.rehearsal_sha256 !== digest(bootstrap.evidence)
    ) {
      throw new Error("Compose document activation evidence is inconsistent.");
    }
    prisma("status");
  } else {
    prisma("deploy");
    await client.query("BEGIN");
    const {
      rows: [data],
    } = await client.query(`
      SELECT EXISTS (SELECT 1 FROM books) OR EXISTS (SELECT 1 FROM users) AS populated
    `);
    if (data.populated)
      throw new Error(
        "Initial document activation requires an empty database.",
      );
    await client.query(sql);
    const {
      rows: [guards],
    } = await client.query(`
      SELECT count(*)::int AS count
      FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE 'proser_%'
    `);
    if (!guards.count)
      throw new Error("Document enforcement did not install its guards.");
    const evidence = JSON.stringify({
      kind: "fresh-compose-bootstrap",
      revision,
      enforcementSha256: digest(sql),
      triggerCount: guards.count,
    });
    await client.query(
      `UPDATE proser_document_enforcement
       SET enabled = true, candidate_sha = $1, rehearsal_sha256 = $2, activated_at = now()
       WHERE singleton`,
      [revision, digest(evidence)],
    );
    await client.query(
      "UPDATE proser_compose.bootstrap SET enforcement_sha256 = $1, evidence = $2 WHERE singleton",
      [digest(sql), evidence],
    );
    await client.query("COMMIT");
    console.log(evidence);
  }
} finally {
  await client.end();
}
