/** Explicit operator-only mint/recovery. Never changes service/fence state. */
import "dotenv/config";
import { readFile, open, constants, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { databaseService } from "../dist/lib/database/index.js";
import { mintReleaseCanary } from "../dist/operations/releaseCanary.js";
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const required = (name) => {
  const value = option(name);
  if (!value) throw new Error(`Required ${name}`);
  return value;
};
async function main() {
  if (!process.argv.includes("--apply"))
    throw new Error(
      "Mint requires explicit --apply after seeding the disposable owned book and reviewing the exact close proof.",
    );
  const proofFile = path.resolve(required("--proof-file")),
    output = path.resolve(required("--out"));
  const proofHandle = await open(
    proofFile,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let bytes;
  try {
    const info = await proofHandle.stat();
    if (
      !info.isFile() ||
      info.size > 32768 ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error("Proof requires an owner-only regular file.");
    bytes = await proofHandle.readFile();
  } finally {
    await proofHandle.close();
  }
  const proof = JSON.parse(bytes.toString("utf8")),
    proofSha = createHash("sha256").update(bytes).digest("hex");
  if (proofSha !== required("--proof-sha"))
    throw new Error("Exact close proof bytes changed.");
  if (proof.environment === "production") {
    const installed = await readFile("REVISION", "utf8");
    if (installed.trim() !== proof.candidateSha)
      throw new Error(
        "Production canary requires the exact installed reviewed candidate REVISION. The native producer verifies clean candidate bytes before installation.",
      );
  }
  const sql = await readFile("deploy/document-authority/enforcement.sql");
  if (
    createHash("sha256").update(sql).digest("hex") !== proof.enforcementSqlSha
  )
    throw new Error("Exact reviewed enforcement SQL changed.");
  await databaseService.connect();
  const grant = await mintReleaseCanary({
    admissionId: required("--admission-id"),
    userId: Number(required("--user-id")),
    bookId: Number(required("--book-id")),
    expiresAt: required("--expires-at"),
    proof,
    proofSha,
    operator: os.userInfo().username,
  });
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const parent = await stat(path.dirname(output));
  if (parent.mode & 0o077 || parent.uid !== process.getuid?.())
    throw new Error("Grant directory must be owner-only.");
  const content = JSON.stringify(grant, null, 2) + "\n";
  try {
    const file = await open(
      output,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const file = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (
        info.mode & 0o077 ||
        info.uid !== process.getuid?.() ||
        (await file.readFile("utf8")) !== content
      )
        throw new Error(
          "Existing grant differs from the exact recovered admission.",
        );
    } finally {
      await file.close();
    }
  }
  process.stdout.write(
    JSON.stringify({
      record: output,
      admissionId: grant.admissionId,
      bookId: grant.bookId,
      userId: grant.userId,
      expiresAt: grant.expiresAt,
    }) + "\n",
  );
}
main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Controlled canary failed"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => databaseService.disconnect());
