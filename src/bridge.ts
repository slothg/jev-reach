#!/usr/bin/env node
/** A per-client STDIO transport; only the shared HTTP backend loads Chrome. */
import { readFile, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { backendIdentity, extractServiceArgs } from "./service-config.js";

process.title = "jev-reach-bridge";
const argv = process.argv.slice(2);
const service = extractServiceArgs(["--shared-http", ...argv]);
const options = service.options!;
if (!options.port) throw new Error("The STDIO bridge needs a fixed backend port; 0 is only supported by direct HTTP.");
const version = (JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const expected = backendIdentity(version, options, service.stockArgs);
const baseUrl = `http://127.0.0.1:${options.port}`;
const stdio = new StdioServerTransport();
let http: StreamableHTTPClientTransport | undefined;
let closing = false;
let heartbeat: NodeJS.Timeout | undefined;
let initializeId: string | number | undefined;
const pingId = `jev-reach-bridge:${randomUUID()}`;
let pingPending = false;

async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  setTimeout(() => process.exit(code), 5000).unref();
  await http?.terminateSession().catch(error => console.error("[jev-reach] bridge session cleanup failed", error.message));
  await http?.close();
  await stdio.close();
  process.exit(code);
}
process.stdin.on("end", () => void shutdown(0));
process.stdin.on("close", () => void shutdown(0));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void shutdown(0));

async function ready(): Promise<boolean> {
  let response: Response;
  try { response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }); }
  catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return false;
    throw error;
  }
  if (!response.ok) throw new Error(`Backend health check failed (${response.status}); refusing to replace the listener.`);
  const health = await response.json() as { status?: string; identity?: typeof expected };
  if (health.status !== "ready" || JSON.stringify(health.identity) !== JSON.stringify(expected)) {
    throw new Error("Port is occupied by another backend version/configuration; stop that service before changing its configuration.");
  }
  return true;
}

async function claimStartup(): Promise<Server | undefined> {
  const guard = createServer(socket => socket.destroy());
  const port = options.port === 65535 ? 65534 : options.port + 1;
  return new Promise((resolve, reject) => {
    guard.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(undefined);
      else reject(error);
    });
    guard.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(guard));
  });
}

async function launchBackend(): Promise<() => Error | undefined> {
  const logs = process.env.JEV_REACH_LOG_DIR ?? join(homedir(), ".agents/mcp/jev-reach/logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const output = await open(join(logs, `backend-${options.port}.stdout.log`), "a", 0o600);
  const errors = await open(join(logs, `backend-${options.port}.stderr.log`), "a", 0o600);
  let launchError: Error | undefined;
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), "--shared-http", ...argv], {
      detached: true, stdio: ["ignore", output.fd, errors.fd], env: process.env,
    });
    child.once("error", error => { launchError = error; });
    child.unref();
  } finally { await output.close(); await errors.close(); }
  return () => launchError;
}

async function ensureBackend(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!closing && Date.now() < deadline) {
    if (await ready()) return;
    const guard = await claimStartup();
    if (guard) {
      try {
        // Recheck after acquiring the startup socket: another starter may have
        // finished between the first health check and our ownership claim.
        if (await ready()) return;
        const launchError = await launchBackend();
        while (!closing && Date.now() < deadline) {
          if (launchError()) throw launchError();
          if (await ready()) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally { await new Promise<void>(resolve => guard.close(() => resolve())); }
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Backend did not become ready on ${options.port}; inspect the backend log and startup-lock port ${options.port === 65535 ? 65534 : options.port + 1}.`);
}

function keepSessionAlive(): void {
  if (heartbeat || !options.sessionIdleMs) return;
  // A live STDIO pipe owns a live session. Hard crashes stop these pings, so
  // the HTTP session still expires; ordinary EOF explicitly deletes it.
  heartbeat = setInterval(() => {
    if (closing || pingPending || !http?.sessionId) return;
    pingPending = true;
    void http.send({ jsonrpc: "2.0", id: pingId, method: "ping" }).catch(() => void shutdown(1));
  }, Math.max(25, Math.min(300_000, options.sessionIdleMs / 3)));
  heartbeat.unref();
}

async function forward(message: JSONRPCMessage): Promise<void> {
  if (closing || !http) return;
  if ("method" in message && message.method === "initialize" && "id" in message) initializeId = message.id;
  try { await http.send(message); }
  catch (error) {
    if ("method" in message && "id" in message) {
      await stdio.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Shared backend failed: ${String(error)}. Reconnect the MCP client.` } });
    }
    console.error("[jev-reach] bridge forwarding failed", error);
    await shutdown(1);
  }
}

try {
  await ensureBackend();
  http = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  http.onerror = error => console.error("[jev-reach] HTTP transport error", error.message);
  http.onmessage = message => {
    if (!("method" in message) && message.id === pingId) { pingPending = false; return; }
    if ("result" in message && message.id === initializeId && typeof message.result.protocolVersion === "string") {
      http!.setProtocolVersion(message.result.protocolVersion);
      keepSessionAlive();
    }
    void stdio.send(message).catch(error => { console.error("[jev-reach] STDIO transport error", error); void shutdown(1); });
  };
  stdio.onmessage = message => { void forward(message); };
  stdio.onerror = error => { console.error("[jev-reach] STDIO transport error", error); void shutdown(1); };
  await http.start();
  await stdio.start();
} catch (error) {
  console.error("[jev-reach] bridge startup failed", error);
  await shutdown(1);
}
