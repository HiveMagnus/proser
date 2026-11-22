import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const run = promisify(execFile);
/** Runs actual parser/import/logger lifecycle. Deliberately unreachable local
 * DB/provider addresses ensure these read-only commands cannot call services. */
describe("CLI help/version process lifecycle", () => {
  test.each([
    ["--help", "Create a new book"],
    ["--version", "1.0.0"],
    ["revise", "--help", "--user-id"],
    ["document:operation", "--help", "--user-id"],
  ])("read-only command %s exits successfully", async (...values) => {
    const expected = values.pop()!,
      args = values;
    const logDir = await mkdtemp(path.join(tmpdir(), "proser-cli-help-"));
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        ["--import", "tsx", "src/cli/index.ts", ...args],
        {
          cwd: path.resolve(__dirname, "../../.."),
          timeout: 15000,
          env: {
            ...process.env,
            NODE_ENV: "development",
            NODE_OPTIONS: "",
            DATABASE_URL:
              "postgresql://fixture:fixture@127.0.0.1:1/proser_cli_no_connect",
            REDIS_URL: "redis://127.0.0.1:1",
            VLLM_BASE_URL: "http://127.0.0.1:1",
            PROSER_LOG_DIR: logDir,
          },
        },
      );
      expect(stdout).toContain(expected);
      expect(stderr).not.toContain("sonic boom");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});
