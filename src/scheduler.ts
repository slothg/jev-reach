/** One reentrant queue covers reach, stock tools, and session cleanup. */
import { AsyncLocalStorage } from "node:async_hooks";
import { PreviewQueue } from "./preview.js";

export class OperationQueue {
  /** 在单次操作之间保持整轮预览占用。 */
  preview = new PreviewQueue();
  #tail: Promise<unknown> = Promise.resolve();
  #context = new AsyncLocalStorage<symbol>();
  #active?: symbol;
  pending = 0;

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#active && this.#context.getStore() === this.#active) {
      signal?.throwIfAborted();
      return operation();
    }
    this.pending++;
    const task = this.#tail.then(async () => {
      signal?.throwIfAborted();
      const token = Symbol("browser-operation");
      this.#active = token;
      try { return await this.#context.run(token, operation); }
      finally { this.#active = undefined; }
    }).finally(() => { this.pending--; });
    this.#tail = task.catch(() => {});
    return task;
  }
}

/** MCP 请求取消信息。 */
type ToolExtra = { /** 当前请求的取消信号。 */ signal?: AbortSignal };
type Tool = { handler: (input: unknown, extra: ToolExtra) => Promise<unknown> };

/**
 * 在现有 SDK 注册表包装浏览器工具，等待占用时不阻塞操作队列。
 * @param server 已注册工具的 MCP server。
 * @param queue 共享操作队列。
 * @param owner 共享模式下的服务端连接标识；缺省保留独立 STDIO 行为。
 * @param onBrowserUse 实际执行浏览器调用时记录资源清理责任。
 */
export function serializeTools(server: unknown, queue: OperationQueue, owner?: string, onBrowserUse?: (name: string, input: unknown) => Promise<void> | void): void {
  const registry = (server as { _registeredTools?: Record<string, Tool> })._registeredTools;
  if (!registry) throw new Error("Pinned MCP tool registry is unavailable");
  for (const [name, tool] of Object.entries(registry)) {
    if (name.startsWith("debug_session_")) continue;
    const handler = tool.handler;
    /**
     * 在实际工具执行前申请并复核占用。
     * @param input 已通过 SDK schema 校验的参数。
     * @param extra 当前请求的取消信息。
     * @returns 工具回包或明确未执行的排队状态。
     */
    tool.handler = async (input, extra) => {
      if (!owner) return queue.run(() => handler(input, extra), extra.signal);
      const cleanup = name === "qa_preview_remove" || name === "qa_page_identity" || name === "release_page";
      if (cleanup && queue.preview.status(owner).status === "RELEASING" && queue.preview.canCleanup(owner)) {
        return queue.run(async () => { await onBrowserUse?.(name, input); return handler(input, extra); }, extra.signal);
      }
      const admission = await queue.preview.acquire(owner, 30_000, undefined, false, extra.signal);
      if (!admission.owned || admission.status !== "HELD") {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(admission) }] };
      }
      const activity = queue.preview.beginActivity(owner);
      try {
        return await queue.run(async () => {
          queue.preview.assertOwner(owner);
          await onBrowserUse?.(name, input);
          return handler(input, extra);
        }, extra.signal);
      } finally { queue.preview.endActivity(owner, activity); }
    };
  }
}
