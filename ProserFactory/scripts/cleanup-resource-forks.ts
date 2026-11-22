#!/usr/bin/env -S node
import fs from 'fs';
import path from 'path';
const TARGET_NAMES = new Set(['._entry.md', '._metadata.json']);

function walk(dir: string, matches: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, matches);
      continue;
    }
    if (TARGET_NAMES.has(entry.name)) {
      matches.push(fullPath);
    }
  }
  return matches;
}

function main() {
  if (!process.argv[2]) throw new Error('Supply an explicit bundle directory.');
  const targetDir = path.resolve(process.argv[2]);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Target directory not found: ${targetDir}`);
  }

  const matches = walk(targetDir);
  for (const filePath of matches) {
    fs.unlinkSync(filePath);
  }

  console.log(
    JSON.stringify(
      {
        targetDir,
        deletedCount: matches.length,
        deletedFiles: matches.map((filePath) => path.relative(targetDir, filePath)),
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
