/** Shared-mode wiring stays outside the upstream entry point and Jev loop. */
import { McpServer } from "chrome-devtools-mcp/build/src/index.js";
import { zod as z } from "chrome-devtools-mcp/build/src/third_party/index.js";
import { drainSharedPageReleases } from "chrome-devtools-mcp/build/src/jev-shared-pages.js";
import { registerReach } from "./reach.js";
import { patchStockNavigation } from "./tabs.js";
import { OperationQueue, serializeTools } from "./scheduler.js";

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
  serializeTools(server.server, queue);
  return {
    server: server.server,
    connect: (transport: unknown) => server.connect(transport),
    close: async () => { await server.close(); await drainSharedPageReleases(); },
  };
}
