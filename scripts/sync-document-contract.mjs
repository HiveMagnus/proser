import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../ProserAuthor/package.json", import.meta.url),
);
const { format, resolveConfig } = require("prettier");
for (const [sourceName, targetName] of [
  ["model.ts", "document-model.ts"],
  ["campaign-model.ts", "revision-campaigns.ts"],
  ["plot-thread-model.ts", "plot-threads.ts"],
  ["scope-model.ts", "document-scopes.ts"],
  ["style-model.ts", "document-styles.ts"],
  ["proposal-model.ts", "document-proposals.ts"],
  ["story-proposal-model.ts", "document-story-proposals.ts"],
  ["publication-model.ts", "document-publications.ts"],
  ["capability-model.ts", "document-capabilities.ts"],
  ["comment-review-model.ts", "document-comments.ts"],
  ["search-model.ts", "document-search.ts"],
  ["passage-model.ts", "document-passages.ts"],
  ["passage-operations-model.ts", "document-passage-operations.ts"],
  ["scope-passage-model.ts", "document-passage-scopes.ts"],
]) {
  const source = new URL(
    `../ProserFactory/src/documents/${sourceName}`,
    import.meta.url,
  );
  const target = new URL(
    `../ProserAuthor/packages/contracts/src/${targetName}`,
    import.meta.url,
  );
  const formatted = await format(
    `// Generated from Factory documents/${sourceName}; edit Factory and run npm run documents:sync.\n` +
      (await readFile(source, "utf8"))
        .replace(/(['"])\.\/campaign-model\1/g, "'./revision-campaigns.js'")
        .replace(/from (['"])\.\/model\1/g, "from './document-model.js'")
        .replace(
          /from (['"])\.\/proposal-model\1/g,
          "from './document-proposals.js'",
        )
        .replace(/(['"])\.\/plot-thread-model\1/g, "'./plot-threads.js'")
        .replace(/from (['"])\.\/scope-model\1/g, "from './document-scopes.js'")
        .replace(/from (['"])\.\/style-model\1/g, "from './document-styles.js'")
        .replace(
          /from (['"])\.\/passage-operations-model\1/g,
          "from './document-passage-operations.js'",
        )
        .replace(
          /from (['"])\.\/passage-model\1/g,
          "from './document-passages.js'",
        ),
    {
      ...(await resolveConfig(target.pathname)),
      parser: "typescript",
      filepath: target.pathname,
    },
  );
  const expected = await format(formatted, {
    ...(await resolveConfig(target.pathname)),
    parser: "typescript",
    filepath: target.pathname,
  });
  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8").catch(() => "")) !== expected) {
      process.stderr.write(
        "Author document contract differs from Factory. Run npm run documents:sync.\n",
      );
      process.exitCode = 1;
    }
  } else await writeFile(target, expected);
}
