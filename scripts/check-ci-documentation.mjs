import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { isDocumentationPath } from "./classify-ci-changes.mjs";

const { full, documents } = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (full !== false || !Array.isArray(documents)) {
  throw new Error("Expected a documentation-only comparison.");
}
for (const file of documents) {
  if (!isDocumentationPath(file) || !lstatSync(file).isFile()) {
    throw new Error("Documentation checks require regular Markdown files.");
  }
}
// Batch without a shell so spaces, Unicode, glob characters and newlines in
// filenames remain literal, and large documentation changes fit argument limits.
for (let offset = 0; offset < documents.length; offset += 50) {
  const files = documents.slice(offset, offset + 50).map((file) => `./${file}`);
  execFileSync("prettier", ["--check", ...files], { stdio: "inherit" });
  execFileSync(
    process.execPath,
    ["scripts/validate-markdown-tables.mjs", ...files],
    {
      stdio: "inherit",
    },
  );
}
console.log(
  `Checked ${documents.length} changed Markdown file(s); deleted documents need no content checks.`,
);
