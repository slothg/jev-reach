/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { UncaughtError } from './PageCollector.js';
import { createIdGenerator, stableIdSymbol } from '../utils/id.js';
import { logger } from '../utils/logger.js';
const CHROME_EXTENSION_PREFIX = 'chrome-extension://';
// Puppeteer delivers the same ConsoleMessage to all subscribed MCP contexts.
const logOwners = new WeakMap();
const exceptionSessions = new WeakMap();
function retainLog(log) {
    logOwners.set(log, (logOwners.get(log) ?? 0) + 1);
}
function releaseLog(log) {
    const owners = logOwners.get(log);
    if (!owners) return;
    logOwners.set(log, owners - 1);
    if (owners !== 1) return;
    // Let other listeners in this Console event acquire their references first.
    queueMicrotask(() => {
        if (logOwners.get(log) !== 0) return;
        logOwners.delete(log);
        try {
            if (typeof log.args === 'function') {
                for (const handle of new Set(log.args())) {
                    void Promise.resolve().then(() => handle.dispose()).catch(error => {
                        logger?.('Failed to release worker console argument', error);
                    });
                }
            } else if (log instanceof UncaughtError) {
                const session = exceptionSessions.get(log);
                exceptionSessions.delete(log);
                const objectId = log.details.exception?.objectId;
                if (session && objectId) {
                    void session.send('Runtime.releaseObject', { objectId }).catch(error => {
                        logger?.('Failed to release worker exception', error);
                    });
                }
            }
        } catch (error) {
            logger?.('Failed to release worker console resource', error);
        }
    });
}
export class ServiceWorkerSubscriber {
    #target;
    #callback;
    #session;
    #worker;
    #closed = false;
    constructor(target, callback) {
        this.#target = target;
        this.#callback = callback;
    }
    async subscribe() {
        try {
            const session = await this.#target.createCDPSession();
            this.#session = session;
            if (this.#closed) {
                await this.unsubscribe();
                return;
            }
            await session.send('Runtime.enable');
            if (this.#closed) return;
            session.on('Runtime.exceptionThrown', this.#onExceptionThrown);
            const worker = await this.#target.worker();
            if (this.#closed) return;
            this.#worker = worker ?? undefined;
            this.#worker?.on('console', this.#onConsole);
        } catch (error) {
            await this.unsubscribe().catch(cleanupError => {
                logger?.('Failed to detach failed worker subscription', cleanupError);
            });
            throw error;
        }
    }
    async unsubscribe() {
        this.#closed = true;
        this.#worker?.off('console', this.#onConsole);
        this.#worker = undefined;
        const session = this.#session;
        this.#session = undefined;
        session?.off('Runtime.exceptionThrown', this.#onExceptionThrown);
        await session?.detach();
    }
    #onConsole = (message) => {
        this.#callback(message);
    };
    #onExceptionThrown = (event) => {
        const extensionId = extractExtensionId(this.#target.url());
        if (extensionId) {
            const error = new UncaughtError(event.exceptionDetails, extensionId);
            exceptionSessions.set(error, this.#session);
            this.#callback(error);
        }
    };
}
export class ServiceWorkerConsoleCollector {
    #storage = new Map();
    #logOrder = new Map();
    #maxLogs;
    #browser;
    #disposed = false;
    #serviceWorkerSubscribers = new Map();
    #idGenerator = createIdGenerator();
    constructor(browser, maxLogs = 30_000) {
        if (!Number.isSafeInteger(maxLogs) || maxLogs < 0) throw new RangeError('Invalid worker log limit');
        this.#browser = browser;
        this.#maxLogs = maxLogs;
    }
    async init(workers) {
        if (!this.#browser || this.#disposed) return;
        this.#browser.on('targetcreated', this.#onTargetCreated);
        this.#browser.on('targetdestroyed', this.#onTargetDestroyed);
        for (const worker of workers) void this.#onTargetCreated(worker.target);
    }
    dispose() {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#browser?.off('targetcreated', this.#onTargetCreated);
        this.#browser?.off('targetdestroyed', this.#onTargetDestroyed);
        for (const {log} of this.#logOrder.values()) releaseLog(log);
        this.#logOrder.clear();
        this.#storage.clear();
        for (const subscriber of this.#serviceWorkerSubscribers.values()) {
            void subscriber.unsubscribe().catch(error => {
                logger?.('Failed to detach worker subscription', error);
            });
        }
        this.#serviceWorkerSubscribers.clear();
    }
    #onTargetCreated = async (target) => {
        if (this.#disposed || this.#serviceWorkerSubscribers.has(target)) return;
        const origin = target.url();
        if (target.type() !== 'service_worker' || !isExtensionOrigin(origin)) return;
        const extensionId = extractExtensionId(origin);
        if (!extensionId) return;
        const subscriber = new ServiceWorkerSubscriber(target, item => this.addLog(extensionId, item));
        // Track pending subscriptions so target destruction and dispose can cancel them.
        this.#serviceWorkerSubscribers.set(target, subscriber);
        try {
            await subscriber.subscribe();
        } catch (error) {
            if (this.#serviceWorkerSubscribers.get(target) === subscriber) {
                this.#serviceWorkerSubscribers.delete(target);
            }
            logger?.('Failed to subscribe to extension worker', error);
        }
    };
    #onTargetDestroyed = async (target) => {
        const subscriber = this.#serviceWorkerSubscribers.get(target);
        this.#serviceWorkerSubscribers.delete(target);
        await subscriber?.unsubscribe().catch(error => {
            logger?.('Failed to detach destroyed worker subscription', error);
        });
    };
    addLog(extensionId, log) {
        retainLog(log);
        if (this.#disposed) {
            releaseLog(log);
            return;
        }
        const id = this.#idGenerator();
        log[stableIdSymbol] = id;
        const logs = this.#storage.get(extensionId) ?? [];
        logs.push(log);
        this.#storage.set(extensionId, logs);
        this.#logOrder.set(id, {extensionId, log});
        if (this.#logOrder.size > this.#maxLogs) {
            const [oldId, oldest] = this.#logOrder.entries().next().value;
            this.#logOrder.delete(oldId);
            const oldLogs = this.#storage.get(oldest.extensionId);
            oldLogs.shift();
            if (!oldLogs.length) this.#storage.delete(oldest.extensionId);
            releaseLog(oldest.log);
        }
    }
    getData(extensionId) {
        return this.#storage.get(extensionId) ?? [];
    }
    getById(extensionId, stableId) {
        const logs = this.#storage.get(extensionId);
        if (!logs) throw new Error('No logs found for selected extension');
        const item = logs.find(item => item[stableIdSymbol] === stableId);
        if (item) return item;
        throw new Error('Log not found for selected extension');
    }
    find(extensionId, filter) {
        return this.#storage.get(extensionId)?.find(filter);
    }
    clearLogs(extensionId) {
        for (const [id, entry] of this.#logOrder) {
            if (entry.extensionId === extensionId) {
                this.#logOrder.delete(id);
                releaseLog(entry.log);
            }
        }
        this.#storage.delete(extensionId);
    }
}
function extractExtensionId(origin) {
    if (!origin || !isExtensionOrigin(origin)) return null;
    const pathPart = origin.substring(CHROME_EXTENSION_PREFIX.length);
    const slashIndex = pathPart.indexOf('/');
    return slashIndex === -1 ? pathPart : pathPart.substring(0, slashIndex);
}
function isExtensionOrigin(origin) {
    return origin.startsWith(CHROME_EXTENSION_PREFIX);
}
