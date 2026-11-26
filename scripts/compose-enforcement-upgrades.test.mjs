import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const enforcementPath =
  "ProserFactory/deploy/document-authority/enforcement.sql";
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function upgradableDigests() {
  const source = readFileSync(
    "scripts/initialize-compose-database.mjs",
    "utf8",
  );
  const block =
    /const UPGRADABLE_ENFORCEMENT = new Map\(\[([\s\S]*?)\]\);/.exec(source);
  assert(block, "UPGRADABLE_ENFORCEMENT map not found");
  return new Set(block[1].match(/[0-9a-f]{64}/g) ?? []);
}

test("every released enforcement digest can be upgraded in place", (t) => {
  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    t.skip("release tags need a full clone");
    return;
  }
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  assert(tags.length > 0, "no release tags found; fetch tags before testing");
  const current = sha256(readFileSync(enforcementPath));
  const upgradable = upgradableDigests();
  const stranded = [];
  for (const tag of tags) {
    let released;
    try {
      released = execFileSync("git", ["show", `${tag}:${enforcementPath}`], {
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue; // The tag predates Compose enforcement.
    }
    const digest = sha256(released);
    if (digest !== current && !upgradable.has(digest))
      stranded.push(`${tag} ${digest}`);
  }
  assert.deepEqual(
    stranded,
    [],
    "add these digests to UPGRADABLE_ENFORCEMENT (after reviewing the upgrade)",
  );
});

test("the current enforcement digest is listed for the next release", () => {
  const current = sha256(readFileSync(enforcementPath));
  assert(
    upgradableDigests().has(current),
    "list the current enforcement.sql digest in UPGRADABLE_ENFORCEMENT",
  );
});
