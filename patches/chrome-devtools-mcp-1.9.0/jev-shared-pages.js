/** Shared CDP resources; each McpPage still owns its snapshot and settings. */
const entries = new Map();
const pending = new Set();

export class SharedPageLease {
    #page;
    #view;
    #callbacks;
    #entry;
    constructor(page, view, callbacks) {
        this.#page = page;
        this.#view = view;
        this.#callbacks = callbacks;
    }
    get held() { return this.#entry?.views.has(this.#view) ?? false; }
    owner() { return this.held ? this.#entry.owner : undefined; }
    async acquire() {
        if (this.held) return this.#entry.ready;
        let entry = entries.get(this.#page);
        if (entry?.closing) {
            await entry.ready;
            return this.acquire();
        }
        if (!entry) {
            entry = {
                page: this.#page, owner: this.#view, callbacks: this.#callbacks,
                views: new Set(), active: undefined, closing: false,
                viewport: this.#page.viewport(), ready: undefined,
            };
            entries.set(this.#page, entry);
            entry.ready = Promise.resolve().then(() => entry.callbacks.initialize());
        }
        entry.views.add(this.#view);
        this.#entry = entry;
        await entry.ready;
    }
    async activate() {
        const entry = this.#entry;
        if (!this.held || entry.active === this.#view) return;
        if (Object.keys(entry.active?.emulationSettings ?? {}).length ||
            Object.keys(this.#view.emulationSettings).length) {
            await this.#callbacks.restore(entry.viewport);
        }
        entry.active = this.#view;
    }
    release() {
        const entry = this.#entry;
        this.#entry = undefined;
        if (!entry) return Promise.resolve();
        entry.views.delete(this.#view);
        if (entry.views.size) return Promise.resolve();
        const cleanup = entry.ready.then(async () => {
            if (entry.views.size) return;
            entry.closing = true;
            try {
                if (Object.keys(entry.active?.emulationSettings ?? {}).length) {
                    await entry.callbacks.reset(entry.viewport);
                }
            } finally {
                await entry.callbacks.dispose();
                if (entries.get(this.#page) === entry) entries.delete(this.#page);
            }
        }).catch(error => {
            if (entries.get(this.#page) === entry) entries.delete(this.#page);
            console.error('[jev-reach] page cleanup failed:', error.message);
        });
        entry.ready = cleanup;
        pending.add(cleanup);
        void cleanup.finally(() => pending.delete(cleanup));
        return cleanup;
    }
}

export async function drainSharedPageReleases() {
    await Promise.all([...pending]);
}

/** Local diagnostics for the bounded integration test, not an HTTP endpoint. */
export function sharedPageDiagnostics() {
    return [...entries.values()].map(entry => ({
        url: entry.page.url(), owners: entry.views.size,
        consoleMessages: entry.owner.consoleCollector?.getData(true).length ?? 0,
        requests: entry.owner.networkCollector?.getData(true).length ?? 0,
    }));
}
