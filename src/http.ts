/** Stateful loopback MCP sessions share one browser and the operation queue. */
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { OperationQueue } from "./scheduler.js";
import type { ServiceOptions, BackendIdentity } from "./service-config.js";
export { extractServiceArgs, type ServiceOptions } from "./service-config.js";

type SessionServer = { connect(transport: unknown): Promise<void>; close(): Promise<void> };
type Session = { server: SessionServer; transport: StreamableHTTPServerTransport; lastSeen: number; busy: number; closing: boolean };

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_048_576) throw new Error("MCP request exceeds 1 MiB");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 创建本机共享 MCP 服务，协议请求不占用预览名额。
 * @param options 服务端口与连接回收参数。
 * @param createSession 创建具有自身有序清理入口的会话。
 * @param closeBackend 全部会话结束后清理浏览器连接。
 * @param identity 用于入口复用校验的版本和配置标识。
 * @param onIdle 达到无会话期限时的退出回调。
 * @returns HTTP 地址、状态及关闭入口。
 */
export async function startHttpService(
  options: ServiceOptions,
  createSession: (queue: OperationQueue) => Promise<SessionServer>,
  closeBackend: () => Promise<void>,
  identity?: BackendIdentity,
  onIdle?: () => void,
) {
  const queue = new OperationQueue();
  const sessions = new Map<string, Session>();
  let starting = 0;
  let stopped = false;
  let idleSince = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;

  const drop = async (id: string) => {
    const session = sessions.get(id);
    if (!session || session.closing) return;
    session.closing = true;
    sessions.delete(id);
    if (!sessions.size) idleSince = Date.now();
    await session.server.close();
  };
  const dropInBackground = (id: string) => {
    void drop(id).catch(error => console.error("[jev-reach] session cleanup failed", error));
  };

  const listener = createServer(async (request, response) => {
    const fail = (status: number, message: string) => {
      if (response.headersSent) return;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };
    // Loopback binding plus Host/Origin checks prevent browser-origin requests.
    const host = request.headers.host;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!host || !allowed.has(host)) { fail(403, "Invalid Host"); return; }
    if (request.headers.origin && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(request.headers.origin)) {
      fail(403, "Invalid Origin"); return;
    }
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ready", sessions: sessions.size, pending: queue.pending,
        preview: queue.preview.status(""), ...(identity ? { identity } : {}) }));
      return;
    }
    if (request.url !== "/mcp") { fail(404, "Unknown endpoint"); return; }
    if (stopped) { fail(503, "Service is stopping"); return; }
    if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) { fail(405, "Unsupported method"); return; }
    let session: Session | undefined;
    let reserved = false;
    let created = false;
    try {
      const body = request.method === "POST" ? await readJson(request) : undefined;
      const idHeader = request.headers["mcp-session-id"];
      if (idHeader !== undefined) {
        if (typeof idHeader !== "string" || !sessions.has(idHeader)) { fail(404, "Unknown MCP session"); return; }
        session = sessions.get(idHeader)!;
      } else {
        if (request.method !== "POST" || !isInitializeRequest(body)) { fail(400, "Initialize a session first"); return; }
        if (sessions.size + starting >= options.maxSessions) { fail(503, "Session limit reached"); return; }
        starting++;
        reserved = true;
        const server = await createSession(queue);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => {
            sessions.set(id, session!);
            if (reserved) { starting--; reserved = false; }
          },
          onsessionclosed: dropInBackground,
        });
        session = { server, transport, lastSeen: Date.now(), busy: 0, closing: false };
        created = true;
        await server.connect(transport);
        const sdkClose = transport.onclose;
        transport.onclose = () => {
          sdkClose?.();
          if (transport.sessionId) dropInBackground(transport.sessionId);
        };
      }
      session.lastSeen = Date.now();
      if (request.method === "POST") session.busy++;
      try { await session.transport.handleRequest(request, response, body); }
      finally { if (request.method === "POST") session.busy--; session.lastSeen = Date.now(); }
      if (created && !session.transport.sessionId) await session!.server.close();
    } catch (error) {
      if (created && session) {
        if (session.transport.sessionId) await drop(session.transport.sessionId);
        else await session!.server.close();
      }
      fail(400, error instanceof Error ? error.message : String(error));
    } finally {
      if (reserved) starting--;
    }
  });
  let port = options.port;
  // Bind the exclusive service endpoint before any browser connection is made.
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      listener.off("error", reject);
      resolve();
    });
  });
  port = (listener.address() as { port: number }).port;

  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    clearInterval(timer);
    queue.preview.close();
    closing = (async () => {
      await Promise.all([...sessions.keys()].map(drop));
      await queue.run(closeBackend);
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    })();
    return closing;
  };
  const intervals = [options.sessionIdleMs, options.serviceIdleMs].filter(value => value > 0);
  if (intervals.length) {
    timer = setInterval(() => {
      const now = Date.now();
      if (options.sessionIdleMs) for (const [id, session] of sessions) {
        if (!session.busy && now - session.lastSeen >= options.sessionIdleMs) dropInBackground(id);
      }
      if (options.serviceIdleMs && !sessions.size && !starting && now - idleSince >= options.serviceIdleMs) {
        // A disconnected client's stalled CDP request cannot keep the CLI
        // backend alive forever. Its shutdown owner supplies a grace deadline.
        if (onIdle) onIdle();
        else void close().catch(error => console.error("[jev-reach] idle shutdown failed", error));
      }
    }, Math.max(25, Math.min(1000, ...intervals)));
    timer.unref();
  }
  return { url: `http://127.0.0.1:${port}/mcp`, port, sessions, queue, close };
}
