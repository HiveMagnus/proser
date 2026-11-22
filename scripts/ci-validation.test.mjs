import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { suites } from "./classify-ci-changes.mjs";
import {
  acceptanceErrors,
  compatibleValidation,
  findTagValidation,
} from "./ci-validation.mjs";

const sha = "a".repeat(40);
const context = { sha, repository: "example/Proser", runId: "456" };
const goodRun = () => ({
  id: 123,
  head_sha: sha,
  head_repository: { full_name: context.repository },
  path: ".github/workflows/verify.yml",
  event: "push",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
});
const goodJobs = () =>
  ["Changes and documentation", ...suites, "CI acceptance"].map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
  }));
const env = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/tags/canvas-release",
  GITHUB_SHA: sha,
  GITHUB_REPOSITORY: context.repository,
  GITHUB_RUN_ID: context.runId,
};

test("reuse requires the exact main push commit, workflow, repository and full successful checks", () => {
  assert.equal(compatibleValidation(goodRun(), goodJobs(), context), true);
  for (const change of [
    { id: 456 },
    { head_sha: "b".repeat(40) },
    { head_repository: { full_name: "someone/fork" } },
    { path: ".github/workflows/other.yml" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { status: "queued" },
    { status: "in_progress" },
    ...["failure", "cancelled", "skipped", null].map((conclusion) => ({
      conclusion,
    })),
  ])
    assert.equal(
      compatibleValidation({ ...goodRun(), ...change }, goodJobs(), context),
      false,
      JSON.stringify(change),
    );
  for (const name of [
    "Changes and documentation",
    ...suites,
    "CI acceptance",
  ]) {
    for (const conclusion of ["failure", "cancelled", "skipped", null]) {
      assert.equal(
        compatibleValidation(
          goodRun(),
          goodJobs().map((j) => (j.name === name ? { ...j, conclusion } : j)),
          context,
        ),
        false,
        `${name}: ${conclusion}`,
      );
    }
    assert.equal(
      compatibleValidation(
        goodRun(),
        goodJobs().filter((j) => j.name !== name),
        context,
      ),
      false,
      name,
    );
    assert.equal(
      compatibleValidation(
        goodRun(),
        [...goodJobs(), goodJobs().find((j) => j.name === name)],
        context,
      ),
      false,
      `duplicate ${name}`,
    );
  }
});

test("missing, failed, pending, incompatible and unavailable evidence falls back to full validation", () => {
  for (const runs of [
    [],
    [{ ...goodRun(), conclusion: "failure" }],
    [{ ...goodRun(), status: "in_progress" }],
    [{ ...goodRun(), head_sha: "b".repeat(40) }],
  ]) {
    assert.equal(
      findTagValidation(env, (path) =>
        path.includes("/jobs?")
          ? { jobs: goodJobs(), total_count: goodJobs().length }
          : { workflow_runs: runs },
      ),
      null,
    );
  }
  for (const api of [
    () => {
      throw new Error("403");
    },
    () => ({}),
    (path) =>
      path.includes("/jobs?")
        ? { jobs: [], total_count: 0 }
        : { workflow_runs: [goodRun()] },
  ])
    assert.equal(findTagValidation(env, api), null);
  assert.equal(
    findTagValidation(env, (path) =>
      path.includes("/jobs?")
        ? { jobs: goodJobs(), total_count: goodJobs().length + 1 }
        : { workflow_runs: [goodRun()] },
    ),
    null,
  );
  assert.equal(
    findTagValidation(env, (path) =>
      path.includes("/jobs?")
        ? { jobs: goodJobs(), total_count: goodJobs().length }
        : {
            workflow_runs: [{ ...goodRun(), conclusion: "failure" }, goodRun()],
          },
    ),
    null,
  );
  const calls = [];
  assert.equal(
    findTagValidation(env, (path) => {
      calls.push(path);
      return path.includes("/jobs?")
        ? { jobs: goodJobs(), total_count: goodJobs().length }
        : { workflow_runs: [goodRun()] };
    }),
    "https://github.com/example/Proser/actions/runs/123",
  );
  assert.match(
    calls[0],
    new RegExp(`head_sha=${sha}&event=push&branch=main&per_page=1`),
  );
  assert.match(calls[1], /filter=latest/);
  for (const change of [
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_SHA: "" },
    { GITHUB_REPOSITORY: "../bad" },
  ]) {
    assert.equal(
      findTagValidation({ ...env, ...change }, () => {
        assert.fail("must not query");
      }),
      null,
    );
  }
});

function needs(selected = suites) {
  return {
    changes: {
      result: "success",
      outputs: {
        documentationOnly: "false",
        ...Object.fromEntries(
          suites.map((s) => [s, String(selected.includes(s))]),
        ),
      },
    },
    ...Object.fromEntries(
      suites.map((s) => [
        s,
        { result: selected.includes(s) ? "success" : "skipped" },
      ]),
    ),
  };
}

test("acceptance rejects failure, cancellation, missing results and unexpected skips for each selected suite", () => {
  assert.deepEqual(acceptanceErrors(needs()), []);
  assert.deepEqual(acceptanceErrors(needs(["factory"])), []);
  for (const suite of suites)
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      const n = needs();
      n[suite] = { result };
      assert.notEqual(acceptanceErrors(n).length, 0, `${suite}: ${result}`);
    }
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    const n = needs();
    n.changes.result = result;
    assert.notEqual(acceptanceErrors(n).length, 0);
  }
  const missing = needs();
  delete missing.changes.outputs.factory;
  assert.notEqual(acceptanceErrors(missing).length, 0);
  assert.notEqual(acceptanceErrors(needs([])).length, 0);
  const docs = needs([]);
  docs.changes.outputs.documentationOnly = "true";
  assert.deepEqual(acceptanceErrors(docs), []);
  const reused = needs([]);
  reused.changes.outputs.reused =
    "https://github.com/example/Proser/actions/runs/123";
  assert.deepEqual(acceptanceErrors(reused), []);
  const unexpected = needs(["factory"]);
  unexpected.author.result = "cancelled";
  assert.notEqual(acceptanceErrors(unexpected).length, 0);
});

test("workflow retains branch pushes, PRs, cancellation, unconditional installation and browser repetitions", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/verify.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /on:\n  push:\n  pull_request:\n  workflow_dispatch:/);
  assert.match(
    workflow,
    /group: verify-\$\{\{ github.ref \}\}\n  cancel-in-progress: true/,
  );
  assert.match(workflow, /inputs.performance/);
  assert.match(workflow, /test:canvas-mobile -- --repeat 3/);
  assert.match(workflow, /Run seven authenticated WebKit workspace checks/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  assert.doesNotMatch(workflow, /if:.*cache.*hit/);
  assert.match(workflow, /load: true\n          push: false/);
});

test("classification cannot seed a log-only npm cache before dependency installation", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/verify.yml", import.meta.url),
    "utf8",
  );
  const changes = workflow.slice(
    workflow.indexOf("\n  changes:\n"),
    workflow.indexOf("\n  factory:\n"),
  );
  const cacheIndex = changes.indexOf("      - name: Cache npm downloads");
  assert.ok(changes.indexOf("      - id: changes") >= 0);
  assert.ok(cacheIndex > changes.indexOf("      - id: changes"));
  assert.match(
    changes.slice(cacheIndex),
    /Cache npm downloads\n        if: steps.changes.outputs.documentationOnly == 'true'/,
  );
  assert.match(changes, /npm --prefix ProserFactory ci/);
  const keys = workflow
    .split("\n")
    .filter((line) => line.includes("key:") && line.includes("-npm-"));
  assert.equal(keys.length, 6);
  for (const key of keys) assert.match(key, /-npm-v2-/);
});
