/** Exact, reviewable transformations against the pinned upstream release. */
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error(`Patch anchor changed: ${before.slice(0, 90)}`);
  return source.replace(before, after);
};

export function transform(path, source) {
  const edits = [];
  if (path === 'build/src/McpPage.js') {
    edits.push(
      ['export class McpPage {', `import { SharedPageLease } from './jev-shared-pages.js';
export class McpPage {
    #sharedLease;`],
      ["        page.on('dialog', this.#dialogHandler);", `        if (process.env.JEV_REACH_SHARED === '1') {
            this.#sharedLease = new SharedPageLease(page, this, {
                initialize: async () => { this.#initCollectors(); await this.#initResources(); },
                dispose: () => this.#disposeResources(),
                restore: async viewport => {
                    const settings = this.emulationSettings;
                    await this.emulate({ ...settings, viewport: settings.viewport ?? viewport,
                        extraHttpHeaders: settings.extraHttpHeaders ?? {} });
                    this.emulationSettings = settings;
                },
                reset: viewport => this.emulate({ viewport, extraHttpHeaders: {} }),
            });
        } else {
            this.#initCollectors();
        }
    }
    #initCollectors() {
        const page = this.pptrPage;
        page.on('dialog', this.#dialogHandler);`],
      ['    async init() {\n        await Promise.allSettled([', `    async init() {
        if (this.#sharedLease) return;
        await this.#initResources();
    }
    async acquire() {
        if (!this.#sharedLease) return;
        await this.#sharedLease.acquire();
        const owner = this.#sharedLease.owner();
        this.networkCollector = owner.networkCollector;
        this.consoleCollector = owner.consoleCollector;
    }
    async activateEmulation() { await this.#sharedLease?.activate(); }
    get hasAcquiredResources() { return !this.#sharedLease || this.#sharedLease.held; }
    async release() {
        this.textSnapshot = null;
        this.uniqueBackendNodeIdToMcpId.clear();
        const handles = this.extraHandles;
        this.extraHandles = [];
        const release = this.#sharedLease?.release();
        await Promise.allSettled(handles.map(handle => Promise.resolve().then(() => handle.dispose())));
        await release;
    }
    async #initResources() {
        await Promise.allSettled([`],
      ["        void this.pptrPage.emulateFocusedPage(true).catch(error => {", "        await this.pptrPage.emulateFocusedPage(true).catch(error => {"],
      ['        try {\n            const session = await this.pptrPage.createCDPSession();', `        let session;
        try {
            session = await this.pptrPage.createCDPSession();`],
      ["            logger?.('Failed to initialize DevTools universe', e);", `            await session?.detach().catch(cleanupError => {
                logger?.('Failed to detach failed DevTools initialization', cleanupError);
            });
            logger?.('Failed to initialize DevTools universe', e);`],
      ['        return this.#devtoolsUniverse;', `        const owner = this.#sharedLease?.owner();
        return owner ? owner.#devtoolsUniverse : this.#devtoolsUniverse;`],
      ['        return this.#dialog;', `        const owner = this.#sharedLease?.owner();
        return owner ? owner.#dialog : this.#dialog;`],
      ['    clearDialog() {\n        this.#dialog = undefined;', `    clearDialog() {
        const owner = this.#sharedLease?.owner();
        if (owner) owner.#dialog = undefined;
        this.#dialog = undefined;`],
      ['    throwIfDialogOpen() {\n        if (this.#dialog && !this.#dialog.handled) {\n            throw new Error(`A dialog is open (${this.#dialog.type()}: ${this.#dialog.message()}).`);', '    throwIfDialogOpen() {\n        const dialog = this.getDialog();\n        if (dialog && !dialog.handled) {\n            throw new Error(`A dialog is open (${dialog.type()}: ${dialog.message()}).`);'],
      ['    async getToolGroups() {', '    async getToolGroups() {\n        if (!this.hasAcquiredResources) return [];'],
      ['    dispose() {\n        this.pptrPage.off', `    dispose() {
        if (this.#sharedLease) return this.release();
        return this.#disposeResources();
    }
    async #disposeResources() {
        this.pptrPage.off`],
      ['        this.networkCollector.dispose();\n        this.consoleCollector.dispose();', '        this.networkCollector?.dispose();\n        this.consoleCollector?.dispose();'],
      ['        void devtoolsUniverse?.session.detach().catch(e => {', '        await devtoolsUniverse?.session.detach().catch(e => {'],
      ["            logger?.('Failed to detach DevTools session', e);\n        });", `            logger?.('Failed to detach DevTools session', e);
        });
        if (this.#sharedLease && !this.pptrPage.isClosed()) {
            await this.pptrPage.emulateFocusedPage(false).catch(error => {
                logger?.('Failed to restore focus emulation', error);
            });
        }`],
      ['    async getDevToolsData() {', '    async getDevToolsData() {\n        if (!this.hasAcquiredResources) return {};'],
      ['        const result = await this.pptrPage.evaluate(async (name, args, ...elements) => {', `        const elementHandles = [];
        let replacingSnapshot = false;
        try {
        const result = await this.pptrPage.evaluate(async (name, args, ...elements) => {`],
      ['        const elementHandles = [];\n        for (let i = 0; i < (result.stashed ?? 0); i++) {', '        for (let i = 0; i < (result.stashed ?? 0); i++) {'],
      ['        if (elementHandles.length) {\n            const env_2', '        if (elementHandles.length) {\n            replacingSnapshot = true;\n            const env_2'],
      ['        response.appendResponseLine(JSON.stringify(resultWithUids, null, 2));\n    }\n    async getElementByUid(uid) {', `        response.appendResponseLine(JSON.stringify(resultWithUids, null, 2));
        } catch (error) {
            await this.pptrPage.evaluate(() => {
                if (window.__dtmcp) window.__dtmcp.stashedElements = undefined;
            }).catch(cleanupError => {
                logger?.('Failed to clear third-party DOM stash', cleanupError);
            });
            if (replacingSnapshot) {
                this.extraHandles = [];
                this.textSnapshot = null;
            }
            await Promise.allSettled(elementHandles.map(handle => Promise.resolve().then(() => handle.dispose())));
            throw error;
        }
    }
    async getElementByUid(uid) {`],
    );
  } else if (path === 'build/src/devtools/DevtoolsUtils.js') {
    edits.push(
    ["import { DevTools } from '../third_party/index.js';", "import { DevTools } from '../third_party/index.js';\nimport { logger } from '../utils/logger.js';"],
    [
      '    const sourceMaps = options?.sourceMaps ?? true;',
      `    try {
    // Another inspector's async stack request also reaches the user's DevTools.
    universe.settings.resolve(DevTools.SDKSettings.disableAsyncStackTracesSettingDescriptor).set(true);
    const sourceMaps = options?.sourceMaps ?? true;`,
    ],
    ['    return { target, universe, session };\n}', `    return { target, universe, session };
    } catch (error) {
        try { universe.dispose(); }
        catch (cleanupError) { logger?.('Failed to dispose failed DevTools universe', cleanupError); }
        throw error;
    }
}`],
    );
  } else if (path === 'build/src/ToolHandler.js') {
    edits.push(['                    response.setPage(page);', '                    await page.acquire();\n                    await page.activateEmulation();\n                    response.setPage(page);']);
  } else if (path === 'build/src/tools/pages.js') {
    edits.push(
      ['        context.selectPage(page);', '        await page.acquire();\n        await page.activateEmulation();\n        context.selectPage(page);'],
      ['            const page = await context.newPage(request.params.background, request.params.isolatedContext);', '            const page = await context.newPage(request.params.background, request.params.isolatedContext);\n            await page.acquire();\n            await page.activateEmulation();'],
    );
  } else if (path === 'build/src/tools/script.js') {
    edits.push(['                const page = mcpPage.pptrPage;', '                await mcpPage.acquire();\n                await mcpPage.activateEmulation();\n                const page = mcpPage.pptrPage;']);
  } else if (path === 'build/src/index.js') {
    edits.push(['    #registerTool(tool) {', '    async getContextForReach() { return this.#getContext(); }\n    #registerTool(tool) {']);
  }
  for (const [before, after] of edits) source = replace(source, before, after);
  return source;
}
