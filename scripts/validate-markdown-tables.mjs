import { readFile } from "node:fs/promises";

const files = process.argv.slice(2);
if (!files.length) {
  console.error(
    "Usage: node scripts/validate-markdown-tables.mjs <markdown-file> [...]",
  );
  process.exitCode = 2;
} else {
  const failures = [];
  const pipeCount = (line) => (line.match(/(?<!\\)\|/g) ?? []).length;
  const separator = (line) =>
    /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)\|?\s*$/.test(line);

  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    let inFence = false;
    for (let index = 0; index < lines.length - 1; index += 1) {
      if (/^\s*```/.test(lines[index])) inFence = !inFence;
      if (
        inFence ||
        !lines[index].includes("|") ||
        !separator(lines[index + 1])
      )
        continue;
      const expected = pipeCount(lines[index]);
      let row = index + 1;
      while (row < lines.length && lines[row].trim().startsWith("|")) {
        const actual = pipeCount(lines[row]);
        if (actual !== expected) {
          failures.push(
            `${file}:${row + 1}: expected ${expected} column delimiters, found ${actual}`,
          );
        }
        row += 1;
      }
      index = row - 1;
    }
  }

  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Validated Markdown tables in ${files.length} file(s).`);
  }
}
