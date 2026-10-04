/** Bounded, local-only acceptance of shared resources and session lifetimes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer as SdkServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startFixture, startMockJev, textOf, payload, KEY_VAR } from './helpers.mjs';
import { OperationQueue } from '../dist/scheduler.js';
import { startHttpService } from '../dist/http.js';
await import('chrome-devtools-mcp/build/src/utils/polyfill.js');
const { parseArguments } = await import('chrome-devtools-mcp/build/src/config/mcp-options.js');
const { closeBrowser } = await import('chrome-devtools-mcp/build/src/browser.js');
const { sharedPageDiagnostics, drainSharedPageReleases } = await import('chrome-devtools-mcp/build/src/jev-shared-pages.js');
const { createSessionServer } = await import('../dist/server.js');
const { McpPage } = await import('chrome-devtools-mcp/build/src/McpPage.js');

const options = { port: 0, sessionIdleMs: 0, serviceIdleMs: 0, maxSessions: 2 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Acceptance condition timed out');
    await delay(25);
  }
}
async function connect(url, name, root) {
  const client = new Client({ name, version: '1' }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: root ? [{ uri: pathToFileURL(root).href, name }] : [] }));
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport, close: async () => { await transport.terminateSession().catch(() => {}); await client.close(); } };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, textOf(result));
  return result;
}

test('one queue admits nested reach helpers and skips aborted waiting operations', { timeout: 5000 }, async () => {
  const queue = new OperationQueue();
  const events = [];
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const first = queue.run(async () => {
    events.push('start'); entered();
    await queue.run(async () => { events.push('nested'); });
    await delay(30);
    events.push('end');
  });
  await started;
  const abort = new AbortController();
  const cancelled = queue.run(async () => { events.push('cancelled'); }, abort.signal);
  const rejection = assert.rejects(cancelled, /aborted/i);
  abort.abort();
  const last = queue.run(async () => { events.push('next'); });
  await Promise.all([first, rejection, last]);
  assert.deepEqual(events, ['start', 'nested', 'end', 'next']);
});

test('two real Chrome clients keep state and roots separate while sharing page collectors', { timeout: 45000 }, async () => {
  process.env.JEV_REACH_SHARED = '1';
  const site = await startFixture();
  let firstDecision;
  const decisionStarted = new Promise(resolve => { firstDecision = resolve; });
  const mock = await startMockJev({
    pick: (_state, criteria) => Object.entries(criteria).find(([, value]) => value.includes('Accept all cookies'))?.[0]
      ?? Object.entries(criteria).find(([, value]) => value.includes('Settings'))?.[0] ?? 'none',
    goal: state => { firstDecision(); return state.url.endsWith('/settings.html') ? 0.95 : 0.05; },
  });
  process.env[KEY_VAR] = 'value-for-the-local-stand-in';
  process.env.TYPESAFE_BASE_URL = mock.url;
  await mkdir('.test-artifacts', { recursive: true });
  const artifacts = await mkdtemp(resolve('.test-artifacts/shared-http-'));
  const rootA = join(artifacts, 'a'), rootB = join(artifacts, 'b');
  await Promise.all([mkdir(rootA), mkdir(rootB)]);
  const args = parseArguments('shared-http-test', [process.execPath, 'shared-http-test', '--isolated', '--headless', '--no-usage-statistics', '--no-performance-crux']);
  args.sourceMaps = false;
  const http = await startHttpService(options, queue => createSessionServer(args, queue), closeBrowser);
  let a, b;
  const initialize = McpPage.prototype.init;
  const focus = new Map();
  McpPage.prototype.init = async function () {
    const page = this.pptrPage;
    if (!focus.has(page)) {
      const original = page.emulateFocusedPage;
      const calls = [];
      focus.set(page, { original, calls });
      page.emulateFocusedPage = async enabled => { await original.call(page, enabled); calls.push(enabled); };
    }
    return initialize.call(this);
  };
  try {
    await assert.rejects(startHttpService({ ...options, port: http.port }, () => { throw new Error('Must not initialize another backend'); }, async () => {}), /EADDRINUSE/);
    [a, b] = await Promise.all([connect(http.url, 'a', rootA), connect(http.url, 'b', rootB)]);
    assert.equal((await fetch(http.url, { method: 'POST', headers: { origin: 'https://example.com' } })).status, 403);
    const overLimit = await fetch(http.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'third', version: '1' } } }) });
    assert.equal(overLimit.status, 503);
    const tools = (await a.client.listTools()).tools.map(tool => tool.name);
    for (const name of ['reach', 'release_page', 'qa_pointer_path', 'qa_preview_install', 'qa_preview_remove']) assert.ok(tools.includes(name), name);
    await call(a.client, 'list_pages');
    await call(b.client, 'list_pages');
    assert.equal(sharedPageDiagnostics().length, 0, 'discovery must not create collectors');
    await call(a.client, 'new_page', { url: site.url + '/login.html' });
    const second = textOf(await call(a.client, 'new_page', { url: site.url + '/checkout.html' }));
    const listedA = textOf(await call(a.client, 'list_pages'));
    const idsA = [...listedA.matchAll(/(?:^|\n)(\d+):/g)].map(match => Number(match[1]));
    assert.equal(idsA.length, 2, second);
    const listedB = textOf(await call(b.client, 'list_pages'));
    const idsB = [...listedB.matchAll(/(?:^|\n)(\d+):/g)].map(match => Number(match[1]));
    await call(b.client, 'select_page', { pageId: idsB[0] });
    assert.equal(sharedPageDiagnostics().find(entry => entry.url.endsWith('/login.html')).owners, 2);
    assert.match(listedA, new RegExp(`${idsA[1]}:.*checkout.html.*\\[selected\\]`));
    assert.match(textOf(await call(b.client, 'list_pages')), new RegExp(`${idsB[0]}:.*login.html.*\\[selected\\]`));
    assert.match(textOf(await call(a.client, 'evaluate_script', { pageId: idsA[1], function: '() => location.pathname' })), /checkout.html/);
    assert.match(textOf(await call(b.client, 'evaluate_script', { pageId: idsB[0], function: '() => location.pathname' })), /login.html/);
    const snapshotA = textOf(await call(a.client, 'take_snapshot', { pageId: idsA[1] }));
    await call(b.client, 'take_snapshot', { pageId: idsB[1] });
    const buttonUid = snapshotA.match(/uid=([^\s]+).*button/)[1].replaceAll('"', '');
    await call(a.client, 'click', { pageId: idsA[1], uid: buttonUid });
    await call(a.client, 'emulate', { pageId: idsA[1], userAgent: 'shared-client-a' });
    await call(b.client, 'evaluate_script', { pageId: idsB[1], function: '() => navigator.userAgent' });
    assert.match(textOf(await call(a.client, 'evaluate_script', { pageId: idsA[1], function: '() => navigator.userAgent' })), /shared-client-a/);
    const bAgent = textOf(await call(b.client, 'evaluate_script', { pageId: idsB[1], function: '() => navigator.userAgent' }));
    assert.doesNotMatch(bAgent, /shared-client-a/);
    await call(a.client, 'take_screenshot', { pageId: idsA[1], filePath: join(rootA, 'a.png') });
    await access(join(rootA, 'a.png'));
    const denied = await b.client.callTool({ name: 'take_screenshot', arguments: { pageId: idsB[1], filePath: join(rootA, 'b.png') } });
    assert.equal(denied.isError, true, 'roots from session A must not authorize B');
    let finished = false;
    const walk = a.client.callTool({ name: 'reach', arguments: { goal: 'Open Settings', url: site.url + '/', max_steps: 6 } }).then(result => {
      assert.ok(!result.isError, textOf(result));
      assert.equal(payload(result).status, 'done');
      finished = true;
    });
    await Promise.race([decisionStarted, walk.then(() => { throw new Error('Reach ended before the mock decision'); })]);
    const queued = call(b.client, 'evaluate_script', { pageId: idsB[0], function: '() => location.pathname' }).then(() => assert.equal(finished, true));
    await Promise.all([walk, queued]);
    assert.ok(mock.requests.length >= 2);
    await a.close(); a = undefined;
    await waitFor(() => http.sessions.size === 1);
    await call(b.client, 'evaluate_script', { pageId: idsB[0], function: '() => document.title' });
    await call(b.client, 'release_page', { pageId: idsB[0] });
    await call(b.client, 'release_page', { pageId: idsB[1] });
    await drainSharedPageReleases();
    assert.equal(sharedPageDiagnostics().length, 0, 'the last owner releases collectors');
    for (const { calls } of focus.values()) assert.deepEqual(calls, [true, false], 'focus is enabled once and restored by the last owner');
    await call(b.client, 'evaluate_script', { pageId: idsB[0], function: '() => document.title' });
    assert.equal(sharedPageDiagnostics().length, 1, 'evaluate_script must acquire a released page');
    await call(b.client, 'release_page', { pageId: idsB[0] });
    console.log(`Evidence: ${artifacts}/a/a.png; two clients, independent roots/snapshots, shared collectors, serialized reach, release verified.`);
  } finally {
    await a?.close(); await b?.close(); await http.close();
    McpPage.prototype.init = initialize;
    for (const [page, { original }] of focus) page.emulateFocusedPage = original;
    await mock.close(); await site.close();
    delete process.env.JEV_REACH_SHARED;
  }
});

test('expired sessions close their server and an empty service shuts down', { timeout: 5000 }, async () => {
  let closedSessions = 0, closedBackend = 0;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const http = await startHttpService({ ...options, sessionIdleMs: 80, serviceIdleMs: 80 }, async () => {
    const server = new SdkServer({ name: 'idle-test', version: '1' });
    server.registerTool('wait', {}, async () => { entered(); await delay(180); return { content: [{ type: 'text', text: 'finished' }] }; });
    return { connect: transport => server.connect(transport), close: async () => { closedSessions++; await server.close(); } };
  }, async () => { closedBackend++; });
  const client = await connect(http.url, 'idle');
  try {
    const request = call(client.client, 'wait');
    await started;
    await delay(120);
    assert.equal(http.sessions.size, 1, 'an active request must not expire');
    await request;
    await waitFor(() => closedSessions === 1 && closedBackend === 1);
    assert.equal(http.sessions.size, 0);
  } finally { await client.client.close(); await http.close(); }
});

test('the shared CLI exits after service idle timeout without requiring stdin EOF', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['dist/index.js', '--shared-http', '--port', '0', '--session-idle-ms', '0', '--service-idle-ms', '1000', '--isolated', '--headless', '--no-usage-statistics', '--no-performance-crux'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  try {
    await waitFor(() => /ready at http:\/\/127\.0\.0\.1:\d+\/mcp/.test(stderr));
    const url = stderr.match(/ready at (http:\/\/127\.0\.0\.1:\d+)\/mcp/)[1];
    const health = await (await fetch(url + '/health')).json();
    assert.equal(health.status, 'ready');
    assert.equal(health.sessions, 0);
    assert.equal(health.pending, 0);
    assert.equal(health.identity.name, 'jev-reach');
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } }
});

test('the last disconnected client cannot leave a stalled CDP backend running', { timeout: 12000 }, async () => {
  const sockets = new Set();
  const blackhole = createServer();
  blackhole.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => {}); // Accept the connection, deliberately never answer CDP.
  });
  await new Promise(resolve => blackhole.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['dist/index.js', '--shared-http', '--port', '0', '--service-idle-ms', '100', '--ws-endpoint', `ws://127.0.0.1:${blackhole.address().port}/`, '--no-usage-statistics', '--no-performance-crux'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  let client;
  try {
    await waitFor(() => /ready at http:\/\/127\.0\.0\.1:\d+\/mcp/.test(stderr));
    const url = stderr.match(/ready at (http:\/\/127\.0\.0\.1:\d+)\/mcp/)[1];
    client = await connect(url + '/mcp', 'stalled-browser');
    await assert.rejects(client.client.callTool({ name: 'list_pages', arguments: {} }, undefined, { timeout: 250 }), /timed out/);
    assert.ok((await (await fetch(url + '/health')).json()).pending > 0);
    await client.close(); client = undefined;
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.match(stderr, /shutting down \(idle\)/);
  } finally {
    await client?.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => blackhole.close(resolve));
  }
});
