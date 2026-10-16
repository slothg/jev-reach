/** Acceptance of normal MCP startup with one shared browser backend. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InitializeRequestSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { startFixture, textOf } from './helpers.mjs';
import { startHttpService } from '../dist/http.js';
import { backendIdentity } from '../dist/service-config.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Bridge lifecycle condition timed out');
    await delay(25);
  }
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const guard = createServer();
  try { await new Promise((resolve, reject) => { guard.once('error', reject); guard.listen(port === 65535 ? 65534 : port + 1, '127.0.0.1', resolve); }); }
  finally { await new Promise(resolve => server.close(resolve)); }
  await new Promise(resolve => guard.close(resolve));
  return port;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, textOf(result));
  return result;
}

test('concurrent normal MCP starters forward roots and share one idle-reclaimable backend', { timeout: 35000 }, async () => {
  await mkdir('.test-artifacts', { recursive: true });
  const artifacts = await mkdtemp(resolve('.test-artifacts/bridge-'));
  const logs = join(artifacts, 'logs');
  const roots = [join(artifacts, 'a'), join(artifacts, 'b')];
  await Promise.all(roots.map(root => mkdir(root)));
  const site = await startFixture();
  const port = await freePort();
  const clients = [];
  const endpoint = `http://127.0.0.1:${port}`;
  async function health() { return (await fetch(endpoint + '/health')).json(); }
  async function connect(index) {
    const client = new Client({ name: `bridge-${index}`, version: '1' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ name: String(index), uri: pathToFileURL(roots[index]).href }] }));
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['dist/bridge.js', '--port', String(port), '--session-idle-ms', '0', '--service-idle-ms', '200', '--isolated', '--headless', '--no-usage-statistics', '--no-performance-crux'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, JEV_KEY_FILE: '/nonexistent/bridge-test/key', JEV_REACH_LOG_DIR: logs }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += chunk; });
    clients.push(client);
    try { await client.connect(transport); }
    catch (error) { throw new Error(`${error}; ${stderr}`); }
    return client;
  }
  try {
    const [a, b] = await Promise.all([connect(0), connect(1)]);
    assert.equal((await health()).sessions, 2);
    await delay(400);
    assert.equal((await health()).sessions, 2, 'disabling session expiry retains live HTTP connections');
    const names = (await a.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('reach') && names.includes('release_page') && names.includes('qa_pointer_path'));
    const backendLog = await readFile(join(logs, `backend-${port}.stderr.log`), 'utf8');
    assert.equal([...backendLog.matchAll(/ready at http:/g)].length, 1, 'only one backend process is launched');
    assert.ok(!backendLog.includes('EADDRINUSE'), 'startup is serialized before backend spawn');
    await call(a, 'new_page', { url: site.url + '/checkout.html' });
    const idsA = [...textOf(await call(a, 'list_pages')).matchAll(/(?:^|\n)(\d+):/g)].map(match => Number(match[1]));
    const idsB = [...textOf(await call(b, 'list_pages')).matchAll(/(?:^|\n)(\d+):/g)].map(match => Number(match[1]));
    await call(a, 'take_screenshot', { pageId: idsA[0], filePath: join(roots[0], 'allowed.png') });
    await access(join(roots[0], 'allowed.png'));
    const denied = await b.callTool({ name: 'take_screenshot', arguments: { pageId: idsB[0], filePath: join(roots[0], 'denied.png') } });
    assert.equal(denied.isError, true, 'backend roots requests must reach the correct STDIO client');
    await a.close(); clients.splice(clients.indexOf(a), 1);
    await waitFor(async () => (await health()).sessions === 1);
    await call(b, 'evaluate_script', { pageId: idsB[0], function: '() => document.title' });
    await b.close(); clients.splice(clients.indexOf(b), 1);
    await waitFor(async () => { try { await health(); return false; } catch { return true; } });
    console.log(`Evidence: ${artifacts}; one backend, two STDIO clients, roots forwarding and idle shutdown passed.`);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await site.close();
    await waitFor(async () => { try { await health(); return false; } catch { return true; } });
  }
});

/** Exercise the real bridge and HTTP reaper without importing or launching Chrome. */
async function idleFixture(t, sessionIdleMs = 240) {
  const port = await freePort();
  const options = { port, sessionIdleMs, serviceIdleMs: 0, maxSessions: 2 };
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const states = [], clients = [], errors = [];
  const fixture = { states, clients, errors, failResume: false, failDiscovery: false, statusOverride: undefined, rootsHandler: undefined };
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const http = await startHttpService(options, async queue => {
    const owner = `idle-fixture-${states.length}`;
    const server = new McpServer({ name: owner, version: '1' });
    const state = { server, pageId: states.length + 100, actions: 0, closed: false, waiting: false, cancelled: false, statusChecks: 0 };
    states.push(state);
    queue.preview.register(owner, async () => {});
    server.registerTool('debug_session_status', {}, async () => {
      state.statusChecks++;
      await queue.preview.sweep();
      return result(fixture.statusOverride ?? queue.preview.status(owner));
    });
    server.registerTool('debug_session_acquire', {}, async () => result(await queue.preview.acquire(owner)));
    server.registerTool('debug_session_release', {}, async () => result(await queue.preview.release(owner)));
    server.registerTool('list_pages', {}, async () => fixture.failDiscovery
      ? { isError: true, content: [{ type: 'text', text: 'Discovery failed' }] }
      : result({ pageId: state.pageId, roots: (await server.server.listRoots()).roots }));
    server.registerTool('evaluate_script', { inputSchema: { pageId: z.number() } }, async ({ pageId }) => {
      if (pageId !== state.pageId) return { isError: true, content: [{ type: 'text', text: 'PAGE_ID_UNAVAILABLE' }] };
      state.actions++;
      return result({ pageId });
    });
    server.registerTool('wait', { inputSchema: { duration: z.number() } }, async ({ duration }, extra) => {
      state.waiting = true;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, duration);
        extra.signal.addEventListener('abort', () => { state.cancelled = true; clearTimeout(timer); resolve(); }, { once: true });
      });
      state.waiting = false;
      return result({ finished: true });
    });
    if (fixture.failResume) server.server.setRequestHandler(InitializeRequestSchema, () => ({
      protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: owner, version: '1' },
    }));
    return { connect: transport => {
      // SDK drops unassociated pushes until its standalone GET stream exists.
      const streams = transport._webStandardTransport;
      state.pushReady = () => streams._streamMapping.has(streams._standaloneSseStreamId);
      return server.connect(transport);
    }, close: async () => {
      state.closed = true;
      await queue.preview.release(owner, true);
      await server.close();
    } };
  }, async () => {}, backendIdentity(version, options, []));
  fixture.http = http;
  fixture.connect = async name => {
    const client = new Client({ name, version: '1' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      await fixture.rootsHandler?.();
      return { roots: [{ name, uri: `file:///bridge-fixture/${name}` }] };
    });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['dist/bridge.js', '--port', String(port), '--session-idle-ms', String(sessionIdleMs), '--service-idle-ms', '0', '--max-sessions', '2'],
      stderr: 'pipe' });
    transport.stderr?.on('data', chunk => errors.push(String(chunk)));
    clients.push(client);
    try { await client.connect(transport); }
    catch (error) { throw new Error(`${error}\n${errors.join('')}`); }
    return client;
  };
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await http.close(); });
  return fixture;
}

test('idle bridge reclaims only idle clients and resumes once with fresh discovery', { timeout: 10000 }, async t => {
  const fixture = await idleFixture(t, 400);
  const { states, http } = fixture;
  const a = await fixture.connect('active');
  const b = await fixture.connect('idle');
  const originalA = JSON.parse(textOf(await call(a, 'list_pages'))).pageId;
  const originalB = states[1].pageId;
  await waitFor(async () => { await a.listTools(); return states[1].closed; });
  assert.equal(http.sessions.size, 1);
  assert.equal(states[0].closed, false);
  await b.ping();
  assert.equal(states.length, 2, 'host ping must not wake a sleeping HTTP session');
  const [tools, again, blocked] = await Promise.all([b.listTools(), b.listTools(), b.callTool({ name: 'evaluate_script', arguments: { pageId: originalB } })]);
  assert.ok(tools.tools.length && again.tools.length);
  assert.equal(states.length, 3, 'concurrent calls share one resumed session');
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /IDLE_SESSION_RECREATED/);
  assert.equal(states[2].actions, 0, 'the triggering page action must not execute');
  fixture.failDiscovery = true;
  assert.equal((await b.callTool({ name: 'list_pages' })).isError, true);
  assert.equal((await b.callTool({ name: 'evaluate_script', arguments: { pageId: originalB } })).isError, true);
  fixture.failDiscovery = false;
  const fresh = JSON.parse(textOf(await call(b, 'list_pages')));
  assert.equal(fresh.roots[0].name, 'idle', 'resumed backend roots requests reach the same STDIO client');
  assert.notEqual(fresh.pageId, originalB);
  assert.match(textOf(await b.callTool({ name: 'evaluate_script', arguments: { pageId: originalB } })), /PAGE_ID_UNAVAILABLE/);
  await call(b, 'evaluate_script', { pageId: fresh.pageId });
  await call(a, 'evaluate_script', { pageId: originalA });
  assert.equal(states[0].actions, 1, 'another client keeps its original context');
  assert.equal(states[2].actions, 1);
});

test('idle bridge protects requests until the RPC response and then expires', { timeout: 6000 }, async t => {
  const { connect, states, http } = await idleFixture(t);
  const client = await connect('long-request');
  const pending = call(client, 'wait', { duration: 750 });
  await waitFor(() => states[0].waiting);
  await delay(500);
  assert.equal(http.sessions.size, 1, 'HTTP send completion is not RPC completion');
  assert.equal(states[0].closed, false);
  await pending;
  await waitFor(() => states[0].closed);
  assert.equal(http.sessions.size, 0);
});

test('idle bridge retains backend requests and releases cancelled client requests', { timeout: 7000 }, async t => {
  const fixture = await idleFixture(t);
  const client = await fixture.connect('bidirectional');
  await waitFor(() => fixture.states[0].pushReady());
  let entered = false, finish;
  fixture.rootsHandler = async () => { entered = true; await new Promise(resolve => { finish = resolve; }); };
  const roots = fixture.states[0].server.server.listRoots().then(result => ({ result }), error => ({ error }));
  await waitFor(() => entered);
  await delay(500);
  if (fixture.states[0].closed) t.diagnostic(fixture.errors.join(''));
  assert.equal(fixture.http.sessions.size, 1, 'backend-to-client RPC also prevents suspension');
  finish();
  const rootsResult = await roots;
  if (rootsResult.error) throw rootsResult.error;
  fixture.rootsHandler = undefined;
  const abort = new AbortController();
  const pending = client.callTool({ name: 'wait', arguments: { duration: 2000 } }, undefined, { signal: abort.signal });
  const rejected = assert.rejects(pending, /abort/i);
  await waitFor(() => fixture.states[0].waiting);
  abort.abort();
  await rejected;
  await waitFor(() => fixture.states[0].cancelled);
  await waitFor(() => fixture.states[0].closed);
  assert.equal(fixture.http.sessions.size, 0, 'cancellation must not leave an orphan request ID');
});

test('idle bridge protects held and queued preview leases', { timeout: 6000 }, async t => {
  const { connect, states, http } = await idleFixture(t);
  const a = await connect('holder');
  const b = await connect('waiter');
  assert.equal(JSON.parse(textOf(await call(a, 'debug_session_acquire'))).owned, true);
  assert.equal(JSON.parse(textOf(await call(b, 'debug_session_acquire'))).position, 1);
  await delay(600);
  assert.equal(http.sessions.size, 2);
  assert.ok(states.every(state => state.statusChecks > 0 && !state.closed));
  await call(b, 'debug_session_release');
  await call(a, 'debug_session_release');
  await waitFor(() => http.sessions.size === 0);
});

test('idle bridge retains releasing, failed, and unknown admission states', { timeout: 6000 }, async t => {
  const fixture = await idleFixture(t);
  await fixture.connect('cleanup');
  for (const status of [
    { status: 'RELEASING', owned: true, position: 0, cleanupFailure: null },
    { status: 'RELEASING', owned: false, position: 0, cleanupFailure: 'cleanup failed' },
    { status: 'UNKNOWN' },
  ]) {
    fixture.statusOverride = status;
    await delay(450);
    assert.equal(fixture.http.sessions.size, 1);
  }
  fixture.statusOverride = undefined;
  await waitFor(() => fixture.http.sessions.size === 0);
});

test('idle bridge cleans a failed resume without replay or orphan sessions', { timeout: 6000 }, async t => {
  const fixture = await idleFixture(t);
  const client = await fixture.connect('failed-resume');
  await waitFor(() => fixture.states[0].closed);
  fixture.failResume = true;
  await assert.rejects(client.listTools(), /Backend protocol changed/);
  await waitFor(() => fixture.http.sessions.size === 0);
  assert.equal(fixture.states.length, 2);
  assert.ok(fixture.states.every(state => state.closed && state.actions === 0));
});

test('idle bridge honors disabled session expiry', { timeout: 5000 }, async t => {
  const { connect, http, states } = await idleFixture(t, 0);
  const client = await connect('expiry-disabled');
  await delay(500);
  await client.ping();
  assert.equal(http.sessions.size, 1);
  assert.equal(states.length, 1);
  assert.equal(states[0].closed, false);
});
