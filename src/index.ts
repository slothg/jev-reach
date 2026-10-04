#!/usr/bin/env node
/**
 * jev-reach: chrome-devtools-mcp plus the `reach` tool, in one process.
 *
 * Each client uses the stock server factory. STDIO remains the default;
 * optional loopback HTTP sessions share one browser and leased collectors.
 * The walk and stock tools use the same page objects and operation queue.
 */

process.title = "jev-reach";

import { readFileSync } from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractServiceArgs, startHttpService } from "./http.js";
import { backendIdentity } from "./service-config.js";

const [major, minor] = process.version.substring(1).split(".").map(Number) as [number, number];
if (major < 20 || (major === 20 && minor < 19) || (major === 22 && minor < 12)) {
  console.error(`ERROR: jev-reach needs Node 20.19+, 22.12+, or newer. Found ${process.version}.`);
  process.exit(1);
}

const OUR_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through
  }
  return "0.0.0";
})();

/** The exact chrome-devtools-mcp release whose internals this build was verified against. */
const PINNED_DEVTOOLS = "1.9.0";

const service = extractServiceArgs(process.argv.slice(2));
if (service.options) process.env.JEV_REACH_SHARED = "1";
else delete process.env.JEV_REACH_SHARED;
const compatibility = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/apply-devtools-patches.mjs", import.meta.url)), "--check"], { encoding: "utf8" });
if (compatibility.status !== 0) {
  console.error(`ERROR: fork dependency patches are missing or changed. Run npm run patch:devtools.\n${compatibility.stderr}`);
  process.exit(1);
}

// ── Boot check: the deep imports this build relies on must still resolve ───

const DEEP_IMPORTS = [
  "chrome-devtools-mcp/build/src/utils/polyfill.js",
  "chrome-devtools-mcp/build/src/index.js",
  "chrome-devtools-mcp/build/src/config/mcp-options.js",
  "chrome-devtools-mcp/build/src/browser.js",
  "chrome-devtools-mcp/build/src/third_party/index.js",
  "chrome-devtools-mcp/build/src/version.js",
] as const;

for (const spec of DEEP_IMPORTS) {
  try {
    await import(spec);
  } catch (error) {
    console.error(`ERROR: jev-reach cannot load ${spec}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`jev-reach ${OUR_VERSION} is built against chrome-devtools-mcp ${PINNED_DEVTOOLS} exactly. Reinstall jev-reach, or check that nothing overrode that dependency.`);
    process.exit(1);
  }
}

const { VERSION: DEVTOOLS_VERSION } = await import("chrome-devtools-mcp/build/src/version.js");
if (DEVTOOLS_VERSION !== PINNED_DEVTOOLS) {
  console.error(`ERROR: jev-reach ${OUR_VERSION} is verified against chrome-devtools-mcp ${PINNED_DEVTOOLS}; found ${DEVTOOLS_VERSION}. Reinstall jev-reach so the pinned version is used.`);
  process.exit(1);
}

const { logDisclaimers } = await import("chrome-devtools-mcp/build/src/index.js");
const { parseArguments } = await import("chrome-devtools-mcp/build/src/config/mcp-options.js");
const { closeBrowser } = await import("chrome-devtools-mcp/build/src/browser.js");
const { StdioServerTransport } = await import("chrome-devtools-mcp/build/src/third_party/index.js");
const { createSessionServer } = await import("./server.js");

// ── Wire-up, mirroring the stock entrypoint ─────────────────────────────────

// Upstream parser calls hideBin(), so it needs the Node and script argv prefix.
const args = parseArguments(`${OUR_VERSION} (chrome-devtools-mcp ${DEVTOOLS_VERSION})`, [...process.argv.slice(0, 2), ...service.stockArgs]);
if (service.options) {
  // The upstream global source-map loader and extension worker collectors do
  // not yet have session ownership. Fail/disable explicitly in shared mode.
  if (args.categoryExtensions) throw new Error("Shared HTTP does not yet support --category-extensions; use STDIO for extension debugging.");
  args.sourceMaps = false;
  args.usageStatistics = false;
}

if (process.env.CHROME_DEVTOOLS_MCP_CRASH_ON_UNCAUGHT !== "true") {
  process.on("unhandledRejection", (reason) => {
    console.error("[jev-reach] unhandled promise rejection", reason);
  });
}

let shuttingDown = false;
let closeServer: (() => Promise<void>) | undefined;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[jev-reach] shutting down (${reason})`);
  setTimeout(() => process.exit(0), 5_000).unref();
  await closeServer?.().catch(error => console.error("[jev-reach] server cleanup failed", error));
  await closeBrowser().catch(() => {});
  process.exit(0);
}
if (!service.options) {
  process.stdin.on("end", () => void shutdown("stdin end"));
  process.stdin.on("close", () => void shutdown("stdin close"));
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));

if (service.options) {
  process.title = "jev-reach-shared";
  const http = await startHttpService(service.options, queue => createSessionServer(args, queue), closeBrowser, backendIdentity(OUR_VERSION, service.options, service.stockArgs), () => void shutdown("idle"));
  closeServer = http.close;
  console.error(`[jev-reach] ${OUR_VERSION} ready at ${http.url}; browser collectors are shared`);
} else {
  const server = await createSessionServer(args);
  closeServer = server.close;
  await server.connect(new StdioServerTransport());
  console.error(`[jev-reach] ${OUR_VERSION} ready on chrome-devtools-mcp ${DEVTOOLS_VERSION}; tool 'reach' added`);
}
logDisclaimers(args);
