/** Shared-mode wiring stays outside the upstream entry point and Jev loop. */
import { McpServer } from "chrome-devtools-mcp/build/src/index.js";
import { zod as z } from "chrome-devtools-mcp/build/src/third_party/index.js";
import { drainSharedPageReleases } from "chrome-devtools-mcp/build/src/jev-shared-pages.js";
import { qaPreviewRemove } from "chrome-devtools-mcp/build/src/tools/qa-pointer-path.js";
import type { Page } from "puppeteer-core";
import { registerReach } from "./reach.js";
import { patchPageIdDiagnostics, patchStockNavigation } from "./tabs.js";
import { OperationQueue, serializeTools } from "./scheduler.js";
import { randomUUID } from "node:crypto";

/**
 * 创建独立 MCP 上下文，并在共享模式下接入整轮预览准入。
 * @param args 已解析的 Chrome 参数。
 * @param queue 共享单次操作与整轮占用的队列。
 * @returns 具有连接及有序清理入口的会话服务。
 */
export async function createSessionServer(args: Record<string, unknown>, queue = new OperationQueue()) {
  const server = await McpServer.from(args, {});
  registerReach(server.server, args, async prefix => {
    const context = await server.getContextForReach();
    const matches = prefix ? context.getPages().filter(page => page.pptrPage.url().startsWith(prefix)) : [];
    if (prefix && matches.length !== 1) throw new Error(`Expected one page for tab_url_prefix; found ${matches.length}`);
    const page = prefix ? matches[0]! : context.getSelectedMcpPage();
    await page.acquire();
    await page.activateEmulation();
    context.selectPage(page);
    return { page: page.pptrPage, pageId: page.id };
  });
  patchStockNavigation(server.server);
  const shared = process.env.JEV_REACH_SHARED === "1";
  const owner = randomUUID();
  let browserUsed = false;
  const qaEntries = new Map<Page, string>();
  /** 清理该连接拥有的 QA 注入入口及浏览器采集器；不关闭页面。 */
  const cleanupResources = () => queue.run(async () => {
    for (const [page, ownerId] of qaEntries) {
      await qaPreviewRemove.handler({ page: { pptrPage: page }, params: { ownerId } }, { appendResponseLine: () => {} });
      qaEntries.delete(page);
    }
    if (!browserUsed) return;
    const context = await server.getContextForReach();
    for (const page of context.getPages()) await page.release();
    await drainSharedPageReleases();
    browserUsed = false;
  });
  if (shared) {
    queue.preview.register(owner, cleanupResources);
    /**
     * 返回不访问浏览器的占用状态回包。
     * @param value 准入或清理结果。
     * @returns MCP 文本内容。
     */
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    server.server.registerTool("debug_session_acquire", {
      description: "Acquire the global preview lease before a whole test. Other chats queue FIFO; QUEUED means no browser work ran. Pass leaseToken to join the same chat's QA connection. Release in finally after QA cleanup.",
      inputSchema: { waitMs: z.number().min(0).max(30000).optional(), leaseToken: z.string().optional(),
        externalCleanup: z.boolean().optional(), activity: z.boolean().optional(), cleanupMemberId: z.string().optional() },
    }, async ({ waitMs, leaseToken, externalCleanup, activity, cleanupMemberId }, extra) => {
      const admission = await queue.preview.acquire(owner, waitMs ?? 0, leaseToken, externalCleanup, extra.signal, cleanupMemberId);
      return result(activity && admission.owned && admission.status === "HELD"
        ? { ...admission, activityId: queue.preview.beginActivity(owner) } : admission);
    });
    server.server.registerTool("debug_session_release", {
      description: "After preview and QA cleanup, release this connection's lease. Releasing the root revokes delegates; RELEASING waits for their cleanup. activityId ends only a QA activity. Waiting applicants may cancel with this tool.",
      inputSchema: { activityId: z.string().optional() },
    }, async ({ activityId }) => {
      if (activityId) { queue.preview.endActivity(owner, activityId); return result(queue.preview.status(owner)); }
      return result(await queue.preview.release(owner));
    });
    server.server.registerTool("debug_session_status", {
      description: "Read preview owner, queue position and cleanup status without browser access or lease renewal.",
      inputSchema: {},
    }, async () => { await queue.preview.sweep(); return result(queue.preview.status(owner)); });
  }
  if (process.env.JEV_REACH_SHARED === "1") {
    server.server.registerTool("release_page", {
      description: "Release this session's collectors, focus override, and snapshot for a page without closing the tab. Other sessions keep their leases.",
      inputSchema: { pageId: z.number().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ pageId }) => {
      const context = await server.getContextForReach();
      const page = pageId === undefined ? context.getSelectedMcpPage() : context.getPageById(pageId);
      await page.release();
      return { content: [{ type: "text", text: `Released page ${page.id} for this session.` }] };
    });
  }
  patchPageIdDiagnostics(server.server);
  serializeTools(server.server, queue, shared ? owner : undefined, async (name, input) => {
    browserUsed = true;
    if (name === "qa_preview_install") {
      const params = input as { pageId?: number; ownerId: string };
      const context = await server.getContextForReach();
      const page = params.pageId === undefined ? context.getSelectedMcpPage() : context.getPageById(params.pageId);
      qaEntries.set(page.pptrPage, params.ownerId);
    }
  });
  return {
    server: server.server,
    connect: (transport: unknown) => server.connect(transport),
    close: async () => {
      if (shared) await queue.preview.release(owner, true);
      if (shared) await cleanupResources();
      await queue.run(async () => {
        await server.close(); await drainSharedPageReleases(); browserUsed = false;
      });
    },
  };
}
