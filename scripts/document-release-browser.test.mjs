import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseBrowserName,
  releaseBrowserLaunchEnv,
  releaseAcceptanceScope,
} from "./document-release-browser.mjs";

test("default acceptance retains Chromium and rejects unknown browser selection", () => {
  assert.equal(releaseBrowserName({}), "chromium");
  for (const value of ["firefox", "webkit ", "CHROMIUM", ""])
    assert.throws(
      () => releaseBrowserName({ PROSER_RELEASE_BROWSER: value }),
      /must be chromium or webkit/,
    );
});
test("WebKit cannot silently replace the complete Chromium release corpus", () => {
  for (const flag of [undefined, "false", "1"])
    assert.throws(
      () =>
        releaseBrowserName({
          PROSER_RELEASE_BROWSER: "webkit",
          PROSER_RELEASE_R2_QUICK_DRAFT_ONLY: flag,
        }),
      /focused Quick Draft or workspace/,
    );
  assert.equal(
    releaseBrowserName({
      PROSER_RELEASE_BROWSER: "webkit",
      PROSER_RELEASE_R2_QUICK_DRAFT_ONLY: "true",
    }),
    "webkit",
  );
});
test("WebKit accepts the focused workspace without enabling catalog or full scope", () => {
  const environment = {
    PROSER_RELEASE_BROWSER: "webkit",
    PROSER_RELEASE_R2_WORKSPACE_ONLY: "true",
  };
  assert.equal(releaseBrowserName(environment), "webkit");
  assert.equal(releaseAcceptanceScope(environment), "workspace");
  assert.throws(
    () =>
      releaseBrowserName({
        PROSER_RELEASE_BROWSER: "webkit",
        PROSER_RELEASE_R2_BOOK_CATALOG_ONLY: "true",
      }),
    /focused Quick Draft or workspace/,
  );
  assert.equal(releaseAcceptanceScope({}), "complete");
});
test("ambiguous focused flags fail before selecting a browser or starting services", () => {
  const flags = [
    "PROSER_RELEASE_R2_QUICK_DRAFT_ONLY",
    "PROSER_RELEASE_R2_WORKSPACE_ONLY",
    "PROSER_RELEASE_R2_BOOK_CATALOG_ONLY",
  ];
  for (const browser of ["chromium", "webkit"])
    for (let left = 0; left < flags.length; left++)
      for (let right = left + 1; right < flags.length; right++)
        assert.throws(
          () =>
            releaseBrowserName({
              PROSER_RELEASE_BROWSER: browser,
              [flags[left]]: "true",
              [flags[right]]: "true",
            }),
          /only one focused scope/,
        );
});
test("test-only netlink selection does not mutate the parent or Chromium environment", () => {
  const environment = { PATH: "fixture-path", TEST_SETTING: "fixture" };
  assert.equal(
    releaseBrowserLaunchEnv("webkit", environment).GIO_USE_NETWORK_MONITOR,
    "netlink",
  );
  assert.equal(environment.GIO_USE_NETWORK_MONITOR, undefined);
  assert.deepEqual(
    releaseBrowserLaunchEnv("chromium", environment),
    environment,
  );
});
