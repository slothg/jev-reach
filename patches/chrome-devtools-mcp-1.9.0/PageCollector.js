/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { FakeIssuesManager } from '../devtools/DevtoolsUtils.js';
import { DevTools } from '../third_party/index.js';
import { createIdGenerator, stableIdSymbol, } from '../utils/id.js';
import { logger } from '../utils/logger.js';
export class UncaughtError {
    details;
    targetId;
    constructor(details, targetId) {
        this.details = details;
        this.targetId = targetId;
    }
}
export class PageCollector {
    pptrPage;
    #listeners;
    #disposed = false;
    maxNavigationSaved = 3;
    /**
     * This maps a Page to a list of navigations with a sub-list
     * of all collected resources.
     * The newer navigations come first.
     */
    storage = [[]];
    constructor(page, listeners, maxResourcesPerNavigation) {
        this.pptrPage = page;
        const idGenerator = createIdGenerator();
        const listenerMap = listeners(value => {
            if (this.#disposed) {
                this.discardResources([value]);
                return;
            }
            const withId = value;
            withId[stableIdSymbol] = idGenerator();
            this.storage[0].push(withId);
            if (maxResourcesPerNavigation !== undefined &&
                this.storage[0].length > maxResourcesPerNavigation) {
                this.discardResources(this.storage[0].splice(0, this.storage[0].length - maxResourcesPerNavigation));
            }
        });
        listenerMap['framenavigated'] = (frame) => {
            // Only split the storage on main frame navigation
            if (frame !== this.pptrPage.mainFrame()) {
                return;
            }
            this.splitAfterNavigation();
        };
        for (const [name, listener] of Object.entries(listenerMap)) {
            this.pptrPage.on(name, listener);
        }
        this.#listeners = listenerMap;
    }
    /** Release evicted resources; collectors without remote handles need no action. */
    discardResources(resources) {
    }
    dispose() {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        if (this.#listeners) {
            for (const [name, listener] of Object.entries(this.#listeners)) {
                this.pptrPage.off(name, listener);
            }
            this.#listeners = undefined;
        }
        this.discardResources(this.storage.flat());
        this.storage = [[]];
    }
    splitAfterNavigation() {
        // Add the latest navigation first
        this.storage.unshift([]);
        this.discardResources(this.storage.splice(this.maxNavigationSaved).flat());
    }
    getData(includePreservedData) {
        if (!includePreservedData) {
            return this.storage[0];
        }
        const data = [];
        for (let index = this.maxNavigationSaved; index >= 0; index--) {
            if (this.storage[index]) {
                data.push(...this.storage[index]);
            }
        }
        return data;
    }
    getIdForResource(resource) {
        return resource[stableIdSymbol] ?? -1;
    }
    getById(stableId) {
        const item = this.find(item => item[stableIdSymbol] === stableId);
        if (!item) {
            throw new Error('Request not found for selected page');
        }
        return item;
    }
    find(filter) {
        for (const navigation of this.storage) {
            const item = navigation.find(filter);
            if (item) {
                return item;
            }
        }
        return;
    }
}
export class ConsoleCollector extends PageCollector {
    static MAX_MESSAGES_PER_NAVIGATION = 10_000;
    #subscriber;
    #releasedHandles = new WeakSet();
    constructor(page, listeners, maxMessagesPerNavigation = ConsoleCollector.MAX_MESSAGES_PER_NAVIGATION) {
        super(page, listeners, maxMessagesPerNavigation);
        this.#subscriber = new PageEventSubscriber(this.pptrPage);
        this.#subscriber.subscribe();
    }
    /** Release only discarded arguments so retained messages remain inspectable. */
    discardResources(resources) {
        for (const resource of resources) {
            if (typeof resource?.args === 'function') {
                let handles;
                try {
                    handles = resource.args();
                }
                catch {
                    logger?.('Failed to read discarded console arguments');
                    continue;
                }
                for (const handle of handles) {
                    if (!handle || typeof handle.dispose !== 'function' || this.#releasedHandles.has(handle)) {
                        continue;
                    }
                    this.#releasedHandles.add(handle);
                    try {
                        void Promise.resolve(handle.dispose()).catch(() => {
                            logger?.('Failed to release discarded console argument');
                        });
                    }
                    catch {
                        logger?.('Failed to release discarded console argument');
                    }
                }
            }
            else if (resource instanceof UncaughtError && resource.details.exception?.objectId) {
                try {
                    void Promise.resolve(this.pptrPage._client().send('Runtime.releaseObject', {
                        objectId: resource.details.exception.objectId,
                    })).catch(() => {
                        logger?.('Failed to release discarded console exception');
                    });
                }
                catch {
                    logger?.('Failed to release discarded console exception');
                }
            }
        }
    }
    dispose() {
        super.dispose();
        this.#subscriber?.unsubscribe();
    }
}
class PageEventSubscriber {
    #issueManager = new FakeIssuesManager();
    #issueAggregator = new DevTools.IssueAggregator(this.#issueManager);
    #seenKeys = new Set();
    #seenIssues = new Set();
    #page;
    #session;
    #targetId;
    constructor(page) {
        this.#page = page;
        // @ts-expect-error use existing CDP client (internal Puppeteer API).
        this.#session = this.#page._client();
        // @ts-expect-error use internal Puppeteer API to get target ID
        this.#targetId = this.#session.target()._targetId;
    }
    #resetIssueAggregator() {
        this.#issueManager = new FakeIssuesManager();
        if (this.#issueAggregator) {
            this.#issueAggregator.removeEventListener("AggregatedIssueUpdated" /* DevTools.IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED */, this.#onAggregatedIssue);
        }
        this.#issueAggregator = new DevTools.IssueAggregator(this.#issueManager);
        this.#issueAggregator.addEventListener("AggregatedIssueUpdated" /* DevTools.IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED */, this.#onAggregatedIssue);
    }
    subscribe() {
        this.#resetIssueAggregator();
        this.#page.on('framenavigated', this.#onFrameNavigated);
        this.#page.on('issue', this.#onIssueAdded);
        this.#session.on('Runtime.exceptionThrown', this.#onExceptionThrown);
    }
    unsubscribe() {
        this.#seenKeys.clear();
        this.#seenIssues.clear();
        this.#page.off('framenavigated', this.#onFrameNavigated);
        this.#page.off('issue', this.#onIssueAdded);
        this.#session.off('Runtime.exceptionThrown', this.#onExceptionThrown);
        if (this.#issueAggregator) {
            this.#issueAggregator.removeEventListener("AggregatedIssueUpdated" /* DevTools.IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED */, this.#onAggregatedIssue);
        }
    }
    #onAggregatedIssue = (event) => {
        if (this.#seenIssues.has(event.data)) {
            return;
        }
        this.#seenIssues.add(event.data);
        this.#page.emit('devtoolsAggregatedIssue', event.data);
    };
    #onExceptionThrown = (event) => {
        this.#page.emit('uncaughtError', new UncaughtError(event.exceptionDetails, this.#targetId));
    };
    // On navigation, we reset issue aggregation.
    #onFrameNavigated = (frame) => {
        // Only split the storage on main frame navigation
        if (frame !== frame.page().mainFrame()) {
            return;
        }
        this.#seenKeys.clear();
        this.#seenIssues.clear();
        this.#resetIssueAggregator();
    };
    #onIssueAdded = (inspectorIssue) => {
        try {
            // @ts-expect-error The types are missmatched but they
            // are coming from CDP
            if (!DevTools.isIssueCodeSupported(inspectorIssue.code)) {
                return;
            }
            const issue = DevTools.createIssuesFromProtocolIssue(null, 
            // @ts-expect-error Protocol types diverge.
            inspectorIssue)[0];
            if (!issue) {
                logger?.('No issue mapping for for the issue: ', inspectorIssue.code);
                return;
            }
            const primaryKey = issue.primaryKey();
            if (this.#seenKeys.has(primaryKey)) {
                return;
            }
            this.#seenKeys.add(primaryKey);
            this.#issueManager.dispatchEventToListeners("IssueAdded" /* DevTools.IssuesManagerEvents.ISSUE_ADDED */, {
                issue,
                // @ts-expect-error We don't care that issues model is null
                issuesModel: null,
            });
        }
        catch (error) {
            logger?.('Error creating a new issue', error);
        }
    };
}
export class NetworkCollector extends PageCollector {
    static MAX_REQUESTS_PER_NAVIGATION = 1_000;
    constructor(page, maxRequestsPerNavigation = NetworkCollector.MAX_REQUESTS_PER_NAVIGATION, listeners = collect => {
        return {
            request: req => {
                collect(req);
            },
        };
    }) {
        super(page, listeners, maxRequestsPerNavigation);
    }
    splitAfterNavigation() {
        const requests = this.storage[0];
        const lastRequestIdx = requests.findLastIndex(request => {
            return request.frame() === this.pptrPage.mainFrame()
                ? request.isNavigationRequest()
                : false;
        });
        // Keep all requests since the last navigation request including that
        // navigation request itself.
        // Keep the reference
        if (lastRequestIdx !== -1) {
            const fromCurrentNavigation = requests.splice(lastRequestIdx);
            this.storage.unshift(fromCurrentNavigation);
        }
        else {
            this.storage.unshift([]);
        }
        this.discardResources(this.storage.splice(this.maxNavigationSaved).flat());
    }
}
//# sourceMappingURL=PageCollector.js.map
