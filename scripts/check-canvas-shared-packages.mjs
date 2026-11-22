import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export async function installedCanvasPackages() {
  const factory = createRequire(
    new URL("../ProserFactory/package.json", import.meta.url),
  );
  const author = createRequire(
    new URL("../ProserAuthor/packages/editor/package.json", import.meta.url),
  );
  const expected = JSON.parse(
    await readFile(
      new URL(
        "../ProserFactory/docs/canvas-dependencies.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const packages = [];
  for (const [kind, require] of [
    ["engine", author],
    ["codec", factory],
  ]) {
    const pin = expected.packages[kind];
    const directory = dirname(require.resolve(`${pin.name}/package.json`));
    const manifest = JSON.parse(
      await readFile(resolve(directory, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, pin.name);
    assert.equal(manifest.version, pin.version);
    assert.equal(manifest.license, "MIT");
    assert.equal(
      manifest.repository.url,
      "git+https://github.com/ChefTaco/canvas-word.git",
    );
    if (kind === "engine") {
      const build = JSON.parse(
        await readFile(resolve(directory, "dist/build-manifest.json"), "utf8"),
      );
      assert.equal(build.version, pin.version);
      for (const output of build.outputs) {
        assert.equal(
          createHash("sha256")
            .update(await readFile(resolve(directory, "dist", output.filename)))
            .digest("hex"),
          output.sha256,
        );
        assert.deepEqual(output.imports, []);
      }
    }
    packages.push({ kind, directory, manifest, pin });
  }
  return packages;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  for (const item of await installedCanvasPackages())
    console.log(
      `Verified shared ${item.manifest.name}@${item.manifest.version}`,
    );
}
