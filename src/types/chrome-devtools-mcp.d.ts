/**
 * Hand-written shims for chrome-devtools-mcp deep imports.
 *
 * The package ships no type declarations, so these describe only the surface
 * jev-reach touches. The dependency is pinned to an exact version and the bin
 * verifies these paths resolve at boot, so a drift here fails loudly rather
 * than at the first tool call.
 */

declare module "chrome-devtools-mcp/build/src/index.js" {
  import type { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  export class McpServer {
    readonly server: SdkMcpServer;
    static from(serverArgs: Record<string, unknown>, options?: { logFile?: unknown }): Promise<McpServer>;
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
    getContextForReach(): Promise<{
      getPages(): McpPage[];
      getSelectedMcpPage(): McpPage;
      getPageById(pageId: number): McpPage;
      selectPage(page: McpPage): void;
    }>;
  }
  export function logDisclaimers(args: Record<string, unknown>): void;
}

interface McpPage {
  id: number;
  pptrPage: import("puppeteer-core").Page;
  acquire(): Promise<void>;
  activateEmulation(): Promise<void>;
  release(): Promise<void>;
}

declare module "chrome-devtools-mcp/build/src/jev-shared-pages.js" {
  export function drainSharedPageReleases(): Promise<void>;
  export function sharedPageDiagnostics(): Array<{ url: string; owners: number; consoleMessages: number; requests: number }>;
}

declare module "chrome-devtools-mcp/build/src/tools/qa-pointer-path.js" {
  export const qaPreviewRemove: {
    handler(request: { page: { pptrPage: import("puppeteer-core").Page }; params: { ownerId: string } },
      response: { appendResponseLine: (line: string) => void }): Promise<void>;
  };
}

declare module "chrome-devtools-mcp/build/src/config/mcp-options.js" {
  export function parseArguments(version: string, argv?: string[], env?: NodeJS.ProcessEnv): Record<string, unknown>;
}

declare module "chrome-devtools-mcp/build/src/browser.js" {
  import type { Browser } from "puppeteer-core";
  export function ensureBrowserLaunched(options: Record<string, unknown>): Promise<Browser>;
  export function ensureBrowserConnected(options: Record<string, unknown>): Promise<Browser>;
  export function closeBrowser(): Promise<void>;
}

declare module "chrome-devtools-mcp/build/src/third_party/index.js" {
  export { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  export const zod: typeof import("zod");
}

declare module "chrome-devtools-mcp/build/src/version.js" {
  export const VERSION: string;
}

declare module "chrome-devtools-mcp/build/src/utils/polyfill.js" {}
