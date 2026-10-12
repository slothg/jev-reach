/** Exercise only the affected collectors and page failure paths, without Chrome. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
await import('chrome-devtools-mcp/build/src/utils/polyfill.js');
const {ServiceWorkerConsoleCollector} = await import('chrome-devtools-mcp/build/src/collectors/ServiceWorkerCollector.js');
const {McpPage} = await import('chrome-devtools-mcp/build/src/McpPage.js');
const {TextSnapshot} = await import('chrome-devtools-mcp/build/src/TextSnapshot.js');
const {DevTools} = await import('chrome-devtools-mcp/build/src/third_party/index.js');
const {createTargetUniverse, overrideDevToolsGlobals} = await import('chrome-devtools-mcp/build/src/devtools/DevtoolsUtils.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const message = (handle) => ({args: () => [handle]});
const handle = () => ({releases: 0, async dispose() {this.releases++;}});

test('worker logs have a total 30,000 limit and release evicted and cleared arguments', async () => {
  const collector = new ServiceWorkerConsoleCollector(new EventEmitter());
  const first = handle(), last = handle();
  collector.addLog('a', message(first));
  for (let i = 1; i < 30_000; i++) collector.addLog(i % 2 ? 'a' : 'b', {args: () => []});
  collector.addLog('b', message(last));
  await tick();
  assert.equal(collector.getData('a').length + collector.getData('b').length, 30_000);
  assert.equal(first.releases, 1);
  collector.clearLogs('b');
  await tick();
  assert.equal(last.releases, 1);
  collector.dispose();
  await tick();
  assert.deepEqual(collector.getData('a'), []);
  assert.deepEqual(collector.getData('b'), []);
});

test('shared worker messages remain inspectable until the final collector releases them', async () => {
  const a = new ServiceWorkerConsoleCollector(new EventEmitter(), 1);
  const b = new ServiceWorkerConsoleCollector(new EventEmitter(), 1);
  const argument = handle(), shared = message(argument);
  a.addLog('a', shared); b.addLog('a', shared);
  a.dispose(); await tick();
  assert.equal(argument.releases, 0);
  b.clearLogs('a'); await tick();
  assert.equal(argument.releases, 1);
  b.dispose(); await tick();
  assert.equal(argument.releases, 1);
  const late = handle(); b.addLog('a', message(late)); await tick();
  assert.equal(late.releases, 1);
  assert.deepEqual(b.getData('a'), []);
});

function workerFixture(enable) {
  const browser = new EventEmitter(), worker = new EventEmitter(), session = new EventEmitter();
  session.detaches = 0; session.commands = [];
  session.send = async (name, args) => {session.commands.push({name, args}); if (name === 'Runtime.enable') await enable();};
  session.detach = async () => {session.detaches++;};
  const target = {url: () => 'chrome-extension://bounded-test/worker.js', type: () => 'service_worker',
    createCDPSession: async () => session, worker: async () => worker};
  const collector = new ServiceWorkerConsoleCollector(browser);
  return {browser, worker, session, target, collector};
}

test('worker subscription timeout detaches its session and removes event listeners', async () => {
  const f = workerFixture(async () => {throw new Error('Runtime.enable timed out');});
  await f.collector.init([]);
  await f.browser.listeners('targetcreated')[0](f.target).catch(() => {});
  f.collector.dispose(); await tick();
  assert.equal(f.session.detaches, 1);
  assert.equal(f.session.listenerCount('Runtime.exceptionThrown'), 0);
  assert.equal(f.worker.listenerCount('console'), 0);
});

test('closing during worker initialization also releases the late subscription', async () => {
  let finish;
  const f = workerFixture(() => new Promise(resolve => {finish = resolve;}));
  await f.collector.init([]);
  const subscribe = f.browser.listeners('targetcreated')[0](f.target);
  await tick();
  f.collector.dispose(); finish(); await subscribe; await tick();
  assert.equal(f.session.detaches, 1);
  assert.equal(f.worker.listenerCount('console'), 0);
  assert.equal(f.session.listenerCount('Runtime.exceptionThrown'), 0);
});

test('closing before a delayed worker session arrives detaches that session once', async () => {
  const f = workerFixture(async () => {});
  let finish;
  f.target.createCDPSession = () => new Promise(resolve => {finish = resolve;});
  await f.collector.init([]);
  const subscribe = f.browser.listeners('targetcreated')[0](f.target);
  f.collector.dispose(); finish(f.session); await subscribe; await tick();
  assert.equal(f.session.detaches, 1);
  assert.equal(f.session.commands.length, 0);
  assert.equal(f.worker.listenerCount('console'), 0);
});

test('worker exception objects are released from the session that created them', async () => {
  const f = workerFixture(async () => {});
  await f.collector.init([]);
  await f.browser.listeners('targetcreated')[0](f.target);
  f.session.emit('Runtime.exceptionThrown', {exceptionDetails: {exception: {objectId: 'bounded-object'}}});
  f.collector.clearLogs('bounded-test'); await tick();
  assert.deepEqual(f.session.commands.filter(x => x.name === 'Runtime.releaseObject'),
    [{name: 'Runtime.releaseObject', args: {objectId: 'bounded-object'}}]);
  f.collector.dispose(); await tick();
  assert.equal(f.session.detaches, 1);
});

test('page initialization detaches a session when the DevTools universe fails', async () => {
  const pptrPage = new EventEmitter(), client = new EventEmitter();
  client.target = () => ({_targetId: 'bounded-target'});
  pptrPage._client = () => client;
  pptrPage.emulateFocusedPage = async () => {};
  let detaches = 0;
  pptrPage.createCDPSession = async () => ({id() {throw new Error('bounded universe failure');}, detach: async () => {detaches++;}});
  const page = new McpPage(pptrPage, 1, {});
  await page.init();
  assert.equal(detaches, 1);
  await page.dispose();
  assert.equal(detaches, 1);
});

test('an allocated DevTools universe is disposed when target creation fails', async () => {
  overrideDevToolsGlobals({loadResource: async () => ({statusCode: 404})});
  const prototype = DevTools.Foundation.Universe.Universe.prototype;
  const original = prototype.dispose;
  let disposals = 0;
  prototype.dispose = function () {disposals++; return original.call(this);};
  const session = new EventEmitter();
  session.connection = () => ({});
  session.id = () => {throw new Error('bounded target failure');};
  try {
    await assert.rejects(createTargetUniverse(session, {sourceMaps: false}), /bounded target failure/);
    assert.equal(disposals, 1);
  } finally {prototype.dispose = original;}
});

async function thirdPartyCase(mode) {
  const previousWindow = globalThis.window, previousElement = globalThis.Element;
  class Element {}
  globalThis.Element = Element;
  globalThis.window = {__dtmcp: {executeTool: async () => [new Element(), new Element()]}};
  const handles = [handle(), handle()];
  const oldHandle = handle(), inputHandle = handle();
  oldHandle[Symbol.dispose] = () => {void oldHandle.dispose();};
  const oldSnapshot = {existing: true};
  const page = {extraHandles: [oldHandle], uniqueBackendNodeIdToMcpId: new Map(), textSnapshot: oldSnapshot,
    getElementByUid: async () => inputHandle,
    pptrPage: {evaluate: async (fn, ...args) => fn(...args), evaluateHandle: async (_fn, i) => {
      if (mode === 'handle-failure' && i === 1) throw new Error('bounded handle failure');
      return handles[i];
    }}};
  const create = TextSnapshot.create;
  TextSnapshot.create = async (page, options) => {
    if (mode === 'snapshot-failure') throw new Error('bounded snapshot failure');
    page.extraHandles = options.extraHandles;
    if (mode === 'transferred-failure') throw new Error('bounded transferred failure');
    return {resolveCdpElementId: () => 'bounded-uid'};
  };
  handles.forEach(h => {h.backendNodeId = async () => 1;});
  try {
    const operation = McpPage.prototype.executeThirdPartyDeveloperTool.call(page, 'bounded', {input: {uid: 'borrowed'}},
      {includeSnapshot() {}, appendResponseLine() {}});
    if (mode === 'success') await operation;
    else await assert.rejects(operation, /bounded .* failure/);
    assert.equal(globalThis.window.__dtmcp.stashedElements, undefined);
    if (mode === 'success') {
      assert.equal(handles[0].releases, 0); assert.equal(handles[1].releases, 0);
      assert.deepEqual(page.extraHandles, handles);
      await Promise.all(page.extraHandles.map(h => h.dispose()));
    } else {
      assert.equal(handles[0].releases, 1);
      assert.equal(handles[1].releases, mode === 'handle-failure' ? 0 : 1);
      if (mode === 'handle-failure') {
        assert.deepEqual(page.extraHandles, [oldHandle]);
        assert.equal(page.textSnapshot, oldSnapshot);
      } else {
        assert.deepEqual(page.extraHandles, []);
        assert.equal(page.textSnapshot, null);
      }
    }
    assert.equal(oldHandle.releases, mode === 'handle-failure' ? 0 : 1);
    assert.equal(inputHandle.releases, 0, 'input UID handle is borrowed from the existing snapshot');
  } finally {TextSnapshot.create = create; globalThis.window = previousWindow; globalThis.Element = previousElement;}
}
for (const mode of ['handle-failure', 'snapshot-failure', 'transferred-failure', 'success']) {
  test(`third-party DOM handles: ${mode}`, () => thirdPartyCase(mode));
}
