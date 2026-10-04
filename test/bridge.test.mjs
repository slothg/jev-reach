/** Acceptance of normal MCP startup with one shared browser backend. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startFixture, textOf } from './helpers.mjs';

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
      args: ['dist/bridge.js', '--port', String(port), '--session-idle-ms', '180', '--service-idle-ms', '200', '--isolated', '--headless', '--no-usage-statistics', '--no-performance-crux'],
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
    assert.equal((await health()).sessions, 2, 'live STDIO sessions retain their HTTP connection');
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
