import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
export const suites = [
  "factory",
  "author",
  "contracts-and-canvas",
  "document-tools",
  "authenticated-document-browser",
  "authenticated-quick-draft-webkit",
];

// A main push at the exact SHA has identical tracked workflow, runtime pins,
// locks and fixture inputs. PRs/manual runs and successful partial runs cannot
// stand in for release acceptance. Never wait for or rerun another workflow.
export function compatibleValidation(run, jobs, { sha, repository, runId }) {
  const names = ["Changes and documentation", ...suites, "CI acceptance"];
  return (
    run.id !== Number(runId) &&
    run.head_sha === sha &&
    run.head_repository?.full_name === repository &&
    run.path === ".github/workflows/verify.yml" &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    names.every((name) => {
      const matches = jobs.filter((job) => job.name === name);
      return (
        matches.length === 1 &&
        matches[0].status === "completed" &&
        matches[0].conclusion === "success"
      );
    })
  );
}

export function findTagValidation(
  env,
  api = (path) =>
    JSON.parse(
      execFileSync("gh", ["api", path], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      }),
    ),
) {
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    !env.GITHUB_REF?.startsWith("refs/tags/") ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")
  )
    return null;
  const context = {
    sha: env.GITHUB_SHA,
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
  };
  try {
    const root = `repos/${context.repository}/actions`;
    const runs = api(
      `${root}/workflows/verify.yml/runs?head_sha=${context.sha}&event=push&branch=main&per_page=1`,
    ).workflow_runs;
    // Only the latest exact-commit main push may supply evidence. Never hide a
    // newer failure/cancellation behind an older successful run.
    const run = runs[0];
    if (run?.status !== "completed" || run.conclusion !== "success")
      return null;
    const response = api(
      `${root}/runs/${run.id}/jobs?filter=latest&per_page=100`,
    );
    if (
      !Array.isArray(response.jobs) ||
      response.total_count !== response.jobs.length
    )
      return null;
    if (compatibleValidation(run, response.jobs, context))
      return `https://github.com/${context.repository}/actions/runs/${run.id}`;
  } catch {
    console.log(
      "Prior validation unavailable; retaining full release validation.",
    );
  }
  return null;
}

export function acceptanceErrors(needs) {
  if (needs.changes?.result !== "success")
    return ["Changes and documentation did not succeed."];
  const outputs = needs.changes.outputs;
  if (
    !outputs ||
    suites.some((suite) => !["true", "false"].includes(outputs[suite]))
  )
    return ["Suite selection is missing or invalid."];
  if (
    suites.every((suite) => outputs[suite] === "false") &&
    outputs.documentationOnly !== "true" &&
    !outputs.reused
  )
    return ["No suites selected without documentation or reuse evidence."];
  return suites.flatMap((suite) => {
    const result = needs[suite]?.result;
    if (outputs[suite] === "true" && result !== "success")
      return [`Selected ${suite}: ${result ?? "missing"}.`];
    if (outputs[suite] === "false" && !["skipped", "success"].includes(result))
      return [`Unselected ${suite}: unexpected ${result ?? "missing"}.`];
    return [];
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const errors = acceptanceErrors(JSON.parse(process.env.CI_NEEDS));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "All selected suites passed; intentional omissions are recorded in Changes and documentation.",
    );
}
