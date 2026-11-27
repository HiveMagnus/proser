import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// The image build only sees files .dockerignore lets through. A Dockerfile
// COPY whose source the ignore file excludes fails the release build, which
// no pull-request job runs, so check every COPY source against the context.

const escape = (text) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
function patternRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escape(char);
  }
  return new RegExp(`^${source}$`);
}

/** Docker's rule: the last pattern matching the path or one of its parent
 * directories decides; `!` patterns re-include. */
export function contextFilter(ignoreFile) {
  const rules = ignoreFile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const include = line.startsWith("!");
      const pattern = (include ? line.slice(1) : line)
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
      return { include, regex: patternRegex(pattern) };
    });
  return (file) => {
    const parts = file.split("/");
    const candidates = parts.map((_, index) =>
      parts.slice(0, index + 1).join("/"),
    );
    let included = true;
    for (const rule of rules)
      if (candidates.some((candidate) => rule.regex.test(candidate)))
        included = rule.include;
    return included;
  };
}

/** Source operands of COPY/ADD instructions that read the build context. */
export function contextSources(dockerfile) {
  const sources = [];
  for (const line of dockerfile.replace(/\\\n/g, " ").split("\n")) {
    const match = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line);
    if (!match) continue;
    const words = match[1].trim().split(/\s+/);
    if (words.some((word) => word.startsWith("--from="))) continue;
    const operands = words.filter((word) => !word.startsWith("--"));
    sources.push(...operands.slice(0, -1));
  }
  return sources;
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

test("every Dockerfile COPY source is in the build context", () => {
  const included = contextFilter(readFileSync(".dockerignore", "utf8"));
  const sources = contextSources(readFileSync("Dockerfile", "utf8"));
  assert(sources.length > 10, "no COPY sources found");
  const missing = sources.filter((source) => {
    const pattern = patternRegex(source.replace(/\/+$/, ""));
    const matches = tracked.filter(
      (file) =>
        pattern.test(file) || file.startsWith(`${source.replace(/\/+$/, "")}/`),
    );
    return !matches.some(included);
  });
  assert.deepEqual(missing, [], ".dockerignore excludes these COPY sources");
});

test("the context filter follows Docker's last-match rule", () => {
  const included = contextFilter(
    "**\n!scripts/\nscripts/**\n!scripts/keep.mjs\n**/node_modules/\n",
  );
  assert.equal(included("scripts/keep.mjs"), true);
  assert.equal(included("scripts/other.mjs"), false);
  assert.equal(included("README.md"), false);
  assert.equal(included("scripts/node_modules/keep.mjs"), false);
  assert.deepEqual(
    contextSources(
      "COPY a b ./x/\nCOPY --from=build /x /y\nCOPY --chown=node c \\\n  d/\n",
    ),
    ["a", "b", "c"],
  );
});

test("the runtime stage removes the base image package managers", () => {
  const stages = readFileSync("Dockerfile", "utf8")
    .replace(/\\\n/g, " ")
    .split(/^FROM\s/m);
  const runtime = stages.find((stage) => /\sAS runtime\s/.test(stage));
  assert(runtime, "no runtime stage found");
  const removal = runtime
    .split("\n")
    .find((line) => /^RUN\s+rm\s/.test(line))
    ?.split(/\s+/);
  assert(removal, "the runtime stage removes no files");
  for (const path of [
    "/usr/local/lib/node_modules",
    "/opt/yarn-v*",
    "/usr/local/bin/npm",
    "/usr/local/bin/npx",
    "/usr/local/bin/corepack",
    "/usr/local/bin/yarn",
    "/usr/local/bin/yarnpkg",
  ])
    assert(removal.includes(path), `${path} stays in the runtime image`);
  const commands = runtime
    .split("\n")
    .filter((line) => /^(RUN|CMD|ENTRYPOINT)\s/.test(line))
    .join("\n");
  assert.doesNotMatch(
    commands,
    /(^|[\s;&|"\[])(npm|npx|corepack|yarn|pnpm)[\s"\]]/,
    "the runtime stage runs a removed package manager",
  );
});
