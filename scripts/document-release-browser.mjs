import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export function releaseAcceptanceScope(environment = process.env) {
  const focused = [
    ["quick-draft", "PROSER_RELEASE_R2_QUICK_DRAFT_ONLY"],
    ["workspace", "PROSER_RELEASE_R2_WORKSPACE_ONLY"],
    ["book-catalog", "PROSER_RELEASE_R2_BOOK_CATALOG_ONLY"],
  ].filter(([, flag]) => environment[flag] === "true");
  if (focused.length > 1)
    throw new Error("Release acceptance permits only one focused scope flag.");
  return focused[0]?.[0] ?? "complete";
}

export function releaseBrowserName(environment = process.env) {
  const name = environment.PROSER_RELEASE_BROWSER ?? "chromium";
  if (!["chromium", "webkit"].includes(name))
    throw new Error("PROSER_RELEASE_BROWSER must be chromium or webkit.");
  const scope = releaseAcceptanceScope(environment);
  if (name === "webkit" && !["quick-draft", "workspace"].includes(scope))
    throw new Error(
      "WebKit release acceptance requires focused Quick Draft or workspace scope.",
    );
  return name;
}

export function releaseBrowserLaunchEnv(name, environment = process.env) {
  // A supported GLib diagnostic backend, scoped to this browser child only.
  // Never change the host, Factory/Author environment or navigator.onLine getter.
  return name === "webkit"
    ? { ...environment, GIO_USE_NETWORK_MONITOR: "netlink" }
    : { ...environment };
}

/** One reproducible profile shared by focused operator and CI acceptance. */
export async function openReleaseBrowser(output) {
  const name = releaseBrowserName();
  const acceptanceScope = releaseAcceptanceScope();
  const require = createRequire(
    new URL("../ProserFactory/package.json", import.meta.url),
  );
  const playwright = require("playwright");
  const profile = {
    name,
    acceptanceScope,
    version: null,
    device:
      name === "webkit" ? "Playwright iPhone 13 emulation" : "desktop Chromium",
    pointerActivation:
      name === "webkit" && acceptanceScope === "quick-draft"
        ? "touch"
        : "mouse",
    inputScope:
      acceptanceScope === "workspace"
        ? "Mixed locator mouse clicks/fills, Playwright keyboard, synthetic PointerEvent and beforeinput history; no physical touch, OS IME or dictation certification"
        : acceptanceScope === "quick-draft"
          ? "Quick Draft geometry, locator taps on WebKit (mouse clicks on Chromium), Playwright keyboard typing; no physical device certification"
          : "Chromium application acceptance; individual checks retain their input scope",
    networkMonitor:
      name === "webkit"
        ? {
            environment: { GIO_USE_NETWORK_MONITOR: "netlink" },
            scope: "WebKit child process only; no host or production changes",
            documentation:
              "https://docs.gtk.org/gio/overview.html#running-gio-applications",
            navigatorGetterOverride: false,
          }
        : null,
    offlineTransitions: [],
    physicalDeviceCertification: false,
  };
  const persist = () =>
    writeFile(
      path.join(output, "browser-profile.json"),
      JSON.stringify(profile, null, 2) + "\n",
      { mode: 0o600 },
    );
  let browser;
  try {
    browser = await playwright[name].launch({
      headless: true,
      env: releaseBrowserLaunchEnv(name),
    });
    profile.version = browser.version();
    const options =
      name === "webkit"
        ? playwright.devices["iPhone 13"]
        : { viewport: { width: 1440, height: 1000 } };
    const context = await browser.newContext(options);
    const page = await context.newPage();
    profile.viewport = page.viewportSize();
    profile.userAgent = await page.evaluate(() => navigator.userAgent);
    if (name === "webkit") {
      profile.offlineTransitions.push({
        action: "initial",
        online: await page.evaluate(() => navigator.onLine),
      });
      await context.setOffline(true);
      profile.offlineTransitions.push({
        action: "context.setOffline(true)",
        online: await page.evaluate(() => navigator.onLine),
      });
      await context.setOffline(false);
      profile.offlineTransitions.push({
        action: "context.setOffline(false)",
        online: await page.evaluate(() => navigator.onLine),
      });
      assert.deepEqual(
        profile.offlineTransitions.map((state) => state.online),
        [true, false, true],
        "WebKit test profile must preserve actual online/offline/online transitions",
      );
    }
    await persist();
    return { browser, context, page, profile };
  } catch (error) {
    profile.failure = error.message;
    try {
      await persist();
    } finally {
      await browser?.close();
    }
    throw error;
  }
}
