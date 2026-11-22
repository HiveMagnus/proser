import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyEvent,
  classifyRecords,
  isDocumentationPath,
} from "./classify-ci-changes.mjs";

const record = (path, oldMode = "100644", newMode = "100644") => ({
  path,
  oldMode,
  newMode,
});

test("only author-facing Markdown paths qualify; prompts, fixtures and configuration do not", () => {
  for (const path of [
    "README.md",
    "PROSER_API.generated.md",
    "AGENTS.md",
    "ProserAuthor/README.md",
    "ProserFactory/CLI.md",
    "docs/history/Release.md",
    "ProserFactory/docs/API.md",
    "ProserAuthor/docs/Unicode 空白\n*.md",
  ])
    assert.equal(isDocumentationPath(path), true, path);
  for (const path of [
    "package.json",
    ".github/workflows/verify.yml",
    ".github/copilot-instructions.md",
    "ProserFactory/src/prompts/README.md",
    "ProserFactory/hermes/skills/test/SKILL.md",
    "ProserAuthor/packages/canvas-engine/UPSTREAM.md",
    "docs/fixture.json",
    "ProserAuthor/docs/page.mdx",
    "document-tools/README.md",
    "scripts/test.mjs",
  ])
    assert.equal(isDocumentationPath(path), false, path);
  assert.equal(
    classifyRecords([record("README.md"), record("src/code.ts")]).full,
    true,
  );
  assert.equal(classifyRecords([]).full, true);
});

test("symlinks, executable Markdown and type changes keep the full suite", () => {
  for (const [oldMode, newMode] of [
    ["100644", "120000"],
    ["120000", "000000"],
    ["100644", "100755"],
  ]) {
    assert.equal(
      classifyRecords([record("README.md", oldMode, newMode)]).full,
      true,
    );
  }
  assert.deepEqual(
    classifyRecords([record("README.md", "100644", "000000")]).documents,
    [],
  );
  assert.equal(
    classifyRecords([record("README.md", "100644", "000000")]).full,
    false,
  );
});

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "proser-ci-classifier-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "ci-fixture@example.invalid");
  git("config", "user.name", "CI fixture");
  const write = (path, content = "# Documentation\n") => {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const commit = () => {
    git("add", "--all");
    git("commit", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  write("README.md");
  const base = commit();
  const push = (before, after) => classifyEvent("push", { before, after }, cwd);
  return { cwd, git, write, commit, base, push };
}

test("multi-commit pushes include code in an earlier commit", (t) => {
  const r = repository(t);
  r.write("source.ts", "export const test = 1;\n");
  r.commit();
  r.write("README.md", "# Changed docs\n");
  const head = r.commit();
  assert.equal(r.push(r.base, head).full, true);
});

test("real Git handles additions, deletions, Unicode, spaces and newline filenames", (t) => {
  const r = repository(t);
  const filename = "docs/Unicode 空 白\n*.md";
  r.write(filename);
  r.git("rm", "README.md");
  const head = r.commit();
  assert.deepEqual(r.push(r.base, head).documents, [filename]);
  assert.equal(r.push(r.base, head).full, false);
  assert.equal(r.push(head, r.base).full, false);
  assert.deepEqual(r.push(head, r.base).documents, ["README.md"]);
});

test("renames check both sides, including code disguised as documentation", (t) => {
  const r = repository(t);
  r.write("source.ts", "source\n");
  const base = r.commit();
  r.git("mv", "source.ts", "source.md");
  const head = r.commit();
  assert.equal(r.push(base, head).full, true);
  assert.equal(r.push(head, base).full, true);
  r.git("mv", "README.md", "GUIDE.md");
  const docsHead = r.commit();
  assert.equal(r.push(head, docsHead).full, false);
  assert.deepEqual(r.push(head, docsHead).documents, ["GUIDE.md"]);
});

test("real symlink and executable changes never qualify as documentation-only", (t) => {
  const r = repository(t);
  rmSync(join(r.cwd, "README.md"));
  symlinkSync("source.ts", join(r.cwd, "README.md"));
  const symlink = r.commit();
  assert.equal(r.push(r.base, symlink).full, true);
  r.git("reset", "--hard", r.base);
  r.git("update-index", "--chmod=+x", "README.md");
  r.git("commit", "-m", "executable");
  const executable = r.git("rev-parse", "HEAD");
  assert.equal(r.push(r.base, executable).full, true);
});

test("pull requests compare their merge base rather than unrelated base-branch code", (t) => {
  const r = repository(t);
  r.git("checkout", "-b", "docs");
  r.write("README.md", "# PR docs\n");
  const head = r.commit();
  r.git("checkout", "main");
  r.write("source.ts", "base branch code\n");
  const base = r.commit();
  assert.equal(
    classifyEvent(
      "pull_request",
      { pull_request: { base: { sha: base }, head: { sha: head } } },
      r.cwd,
    ).full,
    false,
  );
  r.git("checkout", "docs");
  r.write("source.ts", "PR code\n");
  const codeHead = r.commit();
  assert.equal(
    classifyEvent(
      "pull_request",
      { pull_request: { base: { sha: base }, head: { sha: codeHead } } },
      r.cwd,
    ).full,
    true,
  );
});

test("force pushes use both supplied commits even when histories diverge", (t) => {
  const r = repository(t);
  r.write("source.ts", "old branch code\n");
  const before = r.commit();
  r.git("reset", "--hard", r.base);
  r.write("README.md", "# Force pushed docs\n");
  const after = r.commit();
  assert.equal(r.push(before, after).full, true);
});

test("missing history, new branches, malformed events, empty diffs and manual runs default to full", (t) => {
  const r = repository(t);
  for (const before of [
    "0".repeat(40),
    "a".repeat(40),
    "--output=bad",
    undefined,
  ]) {
    assert.equal(r.push(before, r.base).full, true);
  }
  assert.equal(r.push(r.base, r.base).full, true);
  assert.equal(classifyEvent("workflow_dispatch", {}, r.cwd).full, true);
  assert.equal(classifyEvent("future_event", {}, r.cwd).full, true);
  assert.equal(classifyEvent("pull_request", {}, r.cwd).full, true);
});

test("workflow entry point emits the job output and retained file list", (t) => {
  const r = repository(t);
  r.write("README.md", "# Changed documentation\n");
  const head = r.commit();
  const eventPath = join(r.cwd, "event.json");
  const outputPath = join(r.cwd, "output.txt");
  const resultPath = join(r.cwd, "result.json");
  writeFileSync(eventPath, JSON.stringify({ before: r.base, after: head }));
  execFileSync(
    process.execPath,
    [
      new URL("./classify-ci-changes.mjs", import.meta.url).pathname,
      resultPath,
    ],
    {
      cwd: r.cwd,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: join(r.cwd, "summary.md"),
      },
    },
  );
  const outputs = Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  assert.equal(outputs.full, "false");
  assert.equal(outputs.documentationOnly, "true");
  assert.equal(outputs.factory, "false");
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(result.full, false);
  assert.deepEqual(result.documents, ["README.md"]);
});

test("explicit component dependency map and unions retain their integration coverage", () => {
  const selected = (paths) =>
    Object.entries(classifyRecords(paths.map((path) => record(path))))
      .filter(
        ([key, value]) =>
          value === true && !["full", "documentationOnly"].includes(key),
      )
      .map(([key]) => key);
  assert.deepEqual(selected(["ProserFactory/src/cli/index.ts"]), ["factory"]);
  assert.deepEqual(selected(["ProserFactory/src/services/service.ts"]), [
    "factory",
    "contracts-and-canvas",
    "document-tools",
    "authenticated-document-browser",
    "authenticated-quick-draft-webkit",
  ]);
  assert.deepEqual(
    selected(["ProserAuthor/apps/web/src/components/button.tsx"]),
    [
      "author",
      "contracts-and-canvas",
      "authenticated-document-browser",
      "authenticated-quick-draft-webkit",
    ],
  );
  assert.deepEqual(selected(["document-tools/render-docx.sh"]), [
    "contracts-and-canvas",
    "document-tools",
  ]);
  assert.deepEqual(
    selected([
      "ProserFactory/src/cli/index.ts",
      "ProserAuthor/apps/web/src/app/page.tsx",
    ]),
    [
      "factory",
      "author",
      "contracts-and-canvas",
      "authenticated-document-browser",
      "authenticated-quick-draft-webkit",
    ],
  );
});

test("shared contracts, locks, prompts, fixtures, CI and unknown inputs select every suite", () => {
  for (const path of [
    "ProserFactory/src/documents/model.ts",
    "ProserAuthor/packages/canvas-engine/src/index.ts",
    "ProserAuthor/packages/contracts/src/index.ts",
    "ProserFactory/package-lock.json",
    "ProserAuthor/pnpm-lock.yaml",
    "ProserAuthor/pnpm-workspace.yaml",
    "package.json",
    ".nvmrc",
    ".github/workflows/verify.yml",
    "scripts/test-canvas-browser.mjs",
    "new-system/source.ts",
    "ProserFactory/src/config/prompts.ts",
    "ProserAuthor/apps/web/src/fixtures/book.ts",
    "document-tools/validator/packages.lock.json",
    "ProserFactory/src/prompts/review.md",
    "ProserAuthor/apps/web/src/lib/prompt.ts",
    "ProserFactory/vendor/canvas-docx-codec/src/index.ts",
  ])
    assert.equal(classifyRecords([record(path)]).full, true, path);
  assert.equal(
    classifyRecords([
      record("README.md"),
      record("ProserFactory/src/cli/index.ts"),
    ]).full,
    true,
  );
});

test("component renames and deletions use both old and new dependencies", (t) => {
  const r = repository(t);
  r.write("ProserFactory/src/cli/test.ts", "export const one = 1;\n");
  const before = r.commit();
  r.git("mv", "ProserFactory/src/cli/test.ts", "CODE.md");
  const moved = r.commit();
  assert.equal(r.push(before, moved).full, true);
  r.git("reset", "--hard", before);
  r.git("rm", "ProserFactory/src/cli/test.ts");
  const deleted = r.commit();
  const result = r.push(before, deleted);
  assert.equal(result.factory, true);
  assert.equal(result.author, false);
  assert.equal(r.push(deleted, before).factory, true);
  r.git("reset", "--hard", before);
  r.git("mv", "ProserFactory/src/cli/test.ts", "ProserFactory/src/service.ts");
  const head = r.commit();
  assert.equal(r.push(before, head)["authenticated-document-browser"], true);
});

test("main and release code changes are full; development is selective; docs shortcut is retained on main", (t) => {
  const r = repository(t);
  r.write("ProserFactory/src/cli/index.ts", "export {};\n");
  const head = r.commit();
  for (const ref of [
    "refs/heads/main",
    "refs/tags/canvas-new",
    "refs/tags/v2",
  ]) {
    assert.equal(
      classifyEvent("push", { before: r.base, after: head, ref }, r.cwd).full,
      true,
    );
  }
  assert.equal(
    classifyEvent(
      "push",
      { before: r.base, after: head, ref: "refs/heads/working-without-pr" },
      r.cwd,
    ).full,
    false,
  );
  assert.equal(
    classifyEvent(
      "push",
      { before: "0".repeat(40), after: head, ref: "refs/heads/new" },
      r.cwd,
    ).full,
    true,
  );
  r.write("README.md", "# Docs\n");
  const docs = r.commit();
  assert.equal(
    classifyEvent(
      "push",
      { before: head, after: docs, ref: "refs/heads/main" },
      r.cwd,
    ).documentationOnly,
    true,
  );
  assert.equal(
    classifyEvent(
      "workflow_dispatch",
      { inputs: { performance: false } },
      r.cwd,
    ).full,
    true,
  );
});

test("PR component comparison excludes base-only changes but includes the complete PR", (t) => {
  const r = repository(t);
  r.git("checkout", "-b", "feature");
  r.write("ProserFactory/src/cli/index.ts", "export {};\n");
  const head = r.commit();
  r.git("checkout", "main");
  r.write("unknown/system.ts", "export {};\n");
  const base = r.commit();
  const result = classifyEvent(
    "pull_request",
    { pull_request: { base: { sha: base }, head: { sha: head } } },
    r.cwd,
  );
  assert.equal(result.factory, true);
  assert.equal(result.author, false);
});

test("tag CLI reuses exact full validation and runs all suites when evidence is missing", (t) => {
  const r = repository(t);
  const eventPath = join(r.cwd, "tag.json");
  const outputPath = join(r.cwd, "tag-output.txt");
  const resultPath = join(r.cwd, "tag-result.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      ref: "refs/tags/canvas-test",
      before: "0".repeat(40),
      after: r.base,
    }),
  );
  const environment = {
    ...process.env,
    PATH: `${r.cwd}:${process.env.PATH}`,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/tags/canvas-test",
    GITHUB_SHA: r.base,
    GITHUB_REPOSITORY: "example/Proser",
    GITHUB_RUN_ID: "456",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: join(r.cwd, "tag-summary.md"),
  };
  const cli = () => {
    execFileSync(
      process.execPath,
      [
        new URL("./classify-ci-changes.mjs", import.meta.url).pathname,
        resultPath,
      ],
      { cwd: r.cwd, env: environment, stdio: "pipe" },
    );
    return JSON.parse(readFileSync(resultPath, "utf8"));
  };
  writeFileSync(
    join(r.cwd, "gh"),
    `#!${process.execPath}\nprocess.exitCode=1;\n`,
    { mode: 0o755 },
  );
  const fallback = cli();
  assert.equal(fallback.full, true);
  assert.equal(fallback["authenticated-quick-draft-webkit"], true);
  const jobs = [
    "Changes and documentation",
    "factory",
    "author",
    "contracts-and-canvas",
    "document-tools",
    "authenticated-document-browser",
    "authenticated-quick-draft-webkit",
    "CI acceptance",
  ].map((name) => ({ name, status: "completed", conclusion: "success" }));
  const run = {
    id: 123,
    head_sha: r.base,
    head_repository: { full_name: "example/Proser" },
    path: ".github/workflows/verify.yml",
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  };
  writeFileSync(
    join(r.cwd, "gh"),
    `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.at(-1).includes('/jobs?') ? ${JSON.stringify({ jobs, total_count: jobs.length })} : ${JSON.stringify({ workflow_runs: [run] })}));\n`,
    { mode: 0o755 },
  );
  const reused = cli();
  assert.equal(reused.full, false);
  assert.equal(reused.documentationOnly, false);
  assert.equal(reused.factory, false);
  assert.equal(
    reused.reused,
    "https://github.com/example/Proser/actions/runs/123",
  );
  environment.GITHUB_EVENT_NAME = "workflow_dispatch";
  const manual = cli();
  assert.equal(manual.full, true);
  assert.equal(manual.reused, undefined);
});
