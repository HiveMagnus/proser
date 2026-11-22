import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { suites, findTagValidation } from "./ci-validation.mjs";
export { suites } from "./ci-validation.mjs";

// Markdown outside these author-facing locations may be a runtime prompt, skill,
// fixture or vendored input. Unknown paths must retain complete verification.
export function isDocumentationPath(path) {
  return (
    /^[^/]+\.md$/.test(path) ||
    /^(?:ProserAuthor|ProserFactory)\/[^/]+\.md$/.test(path) ||
    /^(?:docs|ProserAuthor\/docs|ProserFactory\/docs)\/.+\.md$/s.test(path)
  );
}

const browser = [
  "authenticated-document-browser",
  "authenticated-quick-draft-webkit",
];
const all = (reason) => plan(suites, reason);
function plan(selected, reason, documents = [], documentationOnly = false) {
  return {
    full: selected.length === suites.length,
    documentationOnly,
    reason,
    documents,
    ...Object.fromEntries(
      suites.map((suite) => [suite, selected.includes(suite)]),
    ),
  };
}

// Keep this map deliberately small. Anything outside known implementation trees
// (including root tools, configuration, locks, prompts and fixtures) runs all jobs.
export function affectedSuites(path) {
  if (
    /(?:^|\/)(?:[^/]*lock[^/]*|package\.json|prompts?|fixtures?|__fixtures__)(?:\/|$)/i.test(
      path,
    )
  )
    return suites;
  if (/(?:prompt|fixture)/i.test(path)) return suites;
  if (/^ProserFactory\/src\/documents\//.test(path)) return suites;
  if (/^ProserFactory\/src\/cli\//.test(path)) return ["factory"];
  if (/^ProserFactory\/src\//.test(path))
    return ["factory", "contracts-and-canvas", "document-tools", ...browser];
  if (/^ProserAuthor\/apps\/web\/src\//.test(path))
    return ["author", "contracts-and-canvas", ...browser];
  if (/^document-tools\//.test(path))
    return ["document-tools", "contracts-and-canvas"];
  return suites;
}

export function classifyRecords(records) {
  const documentationOnly =
    records.length > 0 &&
    records.every(
      ({ path, oldMode, newMode }) =>
        isDocumentationPath(path) &&
        [oldMode, newMode].every((mode) => ["000000", "100644"].includes(mode)),
    );
  if (documentationOnly)
    return plan(
      [],
      "Only author-facing Markdown changed.",
      records
        .filter(({ newMode }) => newMode !== "000000")
        .map(({ path }) => path),
      true,
    );
  if (
    !records.length ||
    records.some(
      ({ path, oldMode, newMode }) =>
        isDocumentationPath(path) ||
        ![oldMode, newMode].every((mode) =>
          ["000000", "100644", "100755"].includes(mode),
        ),
    )
  ) {
    return all(
      "Mixed documentation, special file modes or an empty diff require the full suite.",
    );
  }
  const selected = new Set(records.flatMap(({ path }) => affectedSuites(path)));
  return plan(
    suites.filter((suite) => selected.has(suite)),
    "Affected components selected by the explicit dependency map.",
  );
}

export function classifyEvent(eventName, event, cwd = process.cwd()) {
  const full = all;
  if (!["push", "pull_request"].includes(eventName)) {
    return full("Manual or unrecognized events require the full suite.");
  }
  let base =
    eventName === "push" ? event.before : event.pull_request?.base?.sha;
  const head =
    eventName === "push" ? event.after : event.pull_request?.head?.sha;
  const valid = (sha) => /^[a-f0-9]{40}$/.test(sha ?? "") && !/^0+$/.test(sha);
  if (!valid(base) || !valid(head)) {
    return full(
      "Missing comparison commits, including new branches, require the full suite.",
    );
  }
  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    if (eventName === "pull_request") {
      base = git(["merge-base", base, head]).trim();
    }
    // Disabling rename detection checks both sides of moves: a source file moved
    // into docs is still a code change. NUL delimiters preserve unusual filenames.
    const fields = git([
      "diff",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "-z",
      base,
      head,
      "--",
    ]).split("\0");
    fields.pop();
    if (fields.length % 2 !== 0) throw new Error("Malformed Git diff");
    const records = [];
    for (let index = 0; index < fields.length; index += 2) {
      const metadata = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ [AMDT]$/.exec(
        fields[index],
      );
      if (!metadata || !fields[index + 1])
        throw new Error("Unsupported Git diff record");
      records.push({
        oldMode: metadata[1],
        newMode: metadata[2],
        path: fields[index + 1],
      });
    }
    const result = classifyRecords(records);
    if (
      !result.documentationOnly &&
      (event.ref === "refs/heads/main" || event.ref?.startsWith("refs/tags/"))
    ) {
      return full("Main and release tags require full integration acceptance.");
    }
    return result;
  } catch {
    return full(
      "Comparison history is unavailable or the diff cannot be read; run the full suite.",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  let result = classifyEvent(process.env.GITHUB_EVENT_NAME, event);
  if (
    process.env.GITHUB_EVENT_NAME === "push" &&
    event.ref?.startsWith("refs/tags/")
  ) {
    const evidence = findTagValidation(process.env);
    if (evidence)
      result = {
        ...plan([], `Exact full main validation reused: ${evidence}`),
        reused: evidence,
      };
    else
      result = all(
        "Release tag has no compatible successful full validation; run every suite.",
      );
  }
  writeFileSync(process.argv[2], JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      ["full", "documentationOnly", "reused", ...suites]
        .map((key) => `${key}=${result[key] ?? ""}\n`)
        .join(""),
    );
  }
  console.log(result.reason);
  const summary = `${result.reason}\n\n${suites.map((suite) => `- ${suite}: ${result[suite] ? "selected" : result.reused ? "reused full validation" : "intentionally unselected"}`).join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
