/** One reentrant queue covers reach, stock tools, and session cleanup. */
import { AsyncLocalStorage } from "node:async_hooks";

export class OperationQueue {
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

type Tool = { handler: (input: unknown, extra: { signal?: AbortSignal }) => Promise<unknown> };

/** The same pinned SDK registry is already used by upstream reach and tabs. */
export function serializeTools(server: unknown, queue: OperationQueue): void {
  const registry = (server as { _registeredTools?: Record<string, Tool> })._registeredTools;
  if (!registry) throw new Error("Pinned MCP tool registry is unavailable");
  for (const tool of Object.values(registry)) {
    const handler = tool.handler;
    tool.handler = (input, extra) => queue.run(() => handler(input, extra), extra.signal);
  }
}
