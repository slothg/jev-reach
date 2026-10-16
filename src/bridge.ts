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
import type { JSONRPCMessage, JSONRPCRequest, RequestId } from "@modelcontextprotocol/sdk/types.js";
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
let initialize: JSONRPCRequest | undefined;
let protocolVersion: string | undefined;
let initialized = false;
let lastActivity = Date.now();
let lifecycle: Promise<void> | undefined;
let needsDiscovery = false;
const clientRequests = new Set<RequestId>();
const serverRequests = new Set<RequestId>();
const discoveries = new Set<RequestId>();
const internalPrefix = `jev-reach-bridge:${randomUUID()}:`;
let internalId = 0;
const internal = new Map<RequestId, {
  resolve(result: Record<string, unknown>): void;
  reject(error: Error): void;
}>();

async function disconnect(): Promise<void> {
  await http?.terminateSession();
  await http?.close();
  http = undefined;
}

async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  setTimeout(() => process.exit(code), 5000).unref();
  for (const pending of internal.values()) pending.reject(new Error("Bridge is closing"));
  await disconnect().catch(error => console.error("[jev-reach] bridge session cleanup failed", error.message));
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

/** Internal RPCs never escape onto the client's STDIO connection. */
async function request(method: string, params?: JSONRPCRequest["params"]): Promise<Record<string, unknown>> {
  const id = internalPrefix + internalId++;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      internal.set(id, { resolve, reject });
      timer = setTimeout(() => reject(new Error(`Bridge ${method} timed out`)), 5000);
      void http!.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }).catch(reject);
    });
  } finally { clearTimeout(timer); internal.delete(id); }
}

function idle(): boolean {
  return initialized && !clientRequests.size && !serverRequests.size && Date.now() - lastActivity >= options.sessionIdleMs;
}

async function maintain(): Promise<void> {
  if (idle()) {
    try {
      const result = await request("tools/call", { name: "debug_session_status", arguments: {} });
      const content = result.content as { type?: string; text?: string }[] | undefined;
      const status = JSON.parse(content?.find(item => item.type === "text")?.text ?? "null") as {
        status?: string; owned?: boolean; position?: number; cleanupFailure?: unknown;
      } | null;
      // Unknown/failed admission state must retain the connection and its cleanup responsibility.
      if (!result.isError && status && ["IDLE", "HELD", "RELEASING"].includes(status.status ?? "") &&
          status.owned === false && status.position === 0 && status.cleanupFailure === null && idle() && !closing) {
        await disconnect();
        needsDiscovery = true;
        console.error("[jev-reach] idle HTTP session released; STDIO remains available");
        return;
      }
    } catch (error) { console.error("[jev-reach] idle session retained", error); }
  }
  if (!closing && http?.sessionId) await request("ping");
}

function keepSessionAlive(): void {
  if (heartbeat || !options.sessionIdleMs) return;
  heartbeat = setInterval(() => {
    if (closing || lifecycle || !http?.sessionId) return;
    lifecycle = maintain().catch(error => {
      console.error("[jev-reach] bridge heartbeat failed", error);
      void shutdown(1);
    }).finally(() => { lifecycle = undefined; });
  }, Math.max(25, Math.min(300_000, options.sessionIdleMs / 3)));
  heartbeat.unref();
}

async function connectHttp(): Promise<void> {
  await ensureBackend();
  if (closing) throw new Error("Bridge is closing");
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  http = transport;
  transport.onerror = error => console.error("[jev-reach] HTTP transport error", error.message);
  transport.onmessage = message => {
    if (http !== transport || closing) return;
    if (!("method" in message)) {
      if (message.id === undefined) return;
      const pending = internal.get(message.id);
      if (pending) {
        if ("error" in message) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (typeof message.id === "string" && message.id.startsWith(internalPrefix)) return;
      clientRequests.delete(message.id);
      if (discoveries.delete(message.id) && "result" in message && !message.result.isError) needsDiscovery = false;
      if ("result" in message && message.id === initialize?.id && typeof message.result.protocolVersion === "string") {
        protocolVersion = message.result.protocolVersion;
        transport.setProtocolVersion(protocolVersion);
        keepSessionAlive();
      }
    } else if (message.method === "ping" && "id" in message) {
      void transport.send({ jsonrpc: "2.0", id: message.id, result: {} }).catch(() => void shutdown(1));
      return;
    } else if ("id" in message) serverRequests.add(message.id);
    else if (message.method === "notifications/cancelled") {
      serverRequests.delete(message.params?.requestId as RequestId);
    }
    lastActivity = Date.now();
    void stdio.send(message).catch(error => { console.error("[jev-reach] STDIO transport error", error); void shutdown(1); });
  };
  await transport.start();
}

async function resume(): Promise<void> {
  await connectHttp();
  const result = await request("initialize", initialize!.params);
  if (result.protocolVersion !== protocolVersion) throw new Error("Backend protocol changed; reconnect the MCP client");
  http!.setProtocolVersion(protocolVersion!);
  await http!.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

async function forward(message: JSONRPCMessage): Promise<void> {
  if (closing) return;
  if ("method" in message && message.method === "ping") {
    if ("id" in message) await stdio.send({ jsonrpc: "2.0", id: message.id, result: {} }).catch(() => void shutdown(1));
    return;
  }
  lastActivity = Date.now();
  if ("method" in message && "id" in message) {
    clientRequests.add(message.id);
    if (message.method === "initialize") initialize = message;
  }
  try {
    if (lifecycle) await lifecycle;
    if (!http || lifecycle) {
      lifecycle ??= resume().finally(() => { lifecycle = undefined; });
      await lifecycle;
    }
    if (closing) return;
    if ("method" in message && message.method === "tools/call" && "id" in message) {
      const name = message.params?.name;
      if (needsDiscovery && name !== "list_pages" && !["debug_session_acquire", "debug_session_release", "debug_session_status"].includes(String(name))) {
        clientRequests.delete(message.id);
        await stdio.send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text",
          text: "IDLE_SESSION_RECREATED: This idle connection has a new backend session. This tool was not executed. Call list_pages and obtain fresh page IDs and snapshots before retrying." }] } });
        return;
      }
      if (name === "list_pages") discoveries.add(message.id);
    }
    await http!.send(message);
    if (!("method" in message)) { if (message.id !== undefined) serverRequests.delete(message.id); }
    else if (message.method === "notifications/initialized") initialized = true;
    else if (message.method === "notifications/cancelled") {
      clientRequests.delete(message.params?.requestId as RequestId);
      discoveries.delete(message.params?.requestId as RequestId);
    }
  }
  catch (error) {
    if (closing) return;
    if ("method" in message && "id" in message) {
      await stdio.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Shared backend failed: ${String(error)}. Reconnect the MCP client.` } });
    }
    console.error("[jev-reach] bridge forwarding failed", error);
    await shutdown(1);
  }
}

try {
  await connectHttp();
  stdio.onmessage = message => { void forward(message); };
  stdio.onerror = error => { console.error("[jev-reach] STDIO transport error", error); void shutdown(1); };
  await stdio.start();
} catch (error) {
  console.error("[jev-reach] bridge startup failed", error);
  await shutdown(1);
}
