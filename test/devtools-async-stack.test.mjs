/** Check the pinned async-stack patch and its upstream-drift boundary only. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {transform} from '../scripts/devtools-patch-transforms.mjs';

test('the pinned patch disables async stacks before creating the debugger target', async () => {
  const require=createRequire(import.meta.url);
  const root=dirname(require.resolve('chrome-devtools-mcp/package.json'));
  const path='build/src/devtools/DevtoolsUtils.js';
  const manifest=JSON.parse(await readFile(new URL('../patches/chrome-devtools-mcp-1.9.0/manifest.json',import.meta.url),'utf8'));
  const entry=manifest.files.find(file=>file.path===path);
  assert.ok(entry);
  const hash=source=>createHash('sha256').update(source).digest('hex');
  let original;
  try { original=await readFile(join(root,'.jev-reach-originals',path),'utf8'); }
  catch (error) { if(error.code!=='ENOENT')throw error;original=await readFile(join(root,path),'utf8'); }
  assert.equal(hash(original),entry.originalSha256);
  const patched=transform(path,original);
  assert.equal(hash(patched),entry.patchedSha256);
  const disable='universe.settings.resolve(DevTools.SDKSettings.disableAsyncStackTracesSettingDescriptor).set(true);';
  assert.equal(patched.split(disable).length,2);
  assert.ok(patched.indexOf(disable)<patched.indexOf('targetManager.createTarget('));
  assert.ok(patched.includes('const sourceMaps = options?.sourceMaps ?? true;'));
  assert.throws(()=>transform(path,original.replace('    const sourceMaps = options?.sourceMaps ?? true;','')),/Patch anchor changed/);
});
