/** Verify the entire patch set before writing any dependency file. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from './devtools-patch-transforms.mjs';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('chrome-devtools-mcp/package.json'));
const patchRoot = fileURLToPath(new URL('../patches/chrome-devtools-mcp-1.9.0/', import.meta.url));
const manifest = JSON.parse(await readFile(join(patchRoot, 'manifest.json'), 'utf8'));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
if (version !== manifest.version) throw new Error(`Unsupported Chrome MCP ${version}; expected ${manifest.version}`);
const rollback = process.argv.includes('--rollback');
const check = process.argv.includes('--check');
const hash = value => createHash('sha256').update(value).digest('hex');
const backupRoot = join(root, '.jev-reach-originals');
const plans = [];
for (const entry of manifest.files) {
  const target = join(root, entry.path);
  let current;
  try { current = await readFile(target); }
  catch (error) { if (error.code !== 'ENOENT' || !entry.payload || entry.originalSha256) throw error; }
  const digest = current ? hash(current) : undefined;
  const isPatched = digest === entry.patchedSha256 || (entry.previousPatchedSha256s ?? []).includes(digest);
  if (digest !== entry.originalSha256 && !isPatched) throw new Error(`Dependency drift: ${entry.path}`);
  const backup = join(backupRoot, entry.path);
  let original;
  if (entry.originalSha256) {
    try { original = await readFile(backup); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original && hash(original) !== entry.originalSha256) throw new Error(`Backup drift: ${entry.path}`);
    if (!original && isPatched) throw new Error(`Backup missing: ${entry.path}`);
    original ??= current;
  }
  let patched = entry.payload ? await readFile(join(patchRoot, entry.payload)) : Buffer.from(transform(entry.path, original.toString('utf8')));
  if (hash(patched) !== entry.patchedSha256) throw new Error(`Patch payload drift: ${entry.path}`);
  if (check && digest !== entry.patchedSha256) throw new Error(`Patch not applied: ${entry.path}`);
  plans.push({ target, backup, original, current, next: rollback ? original : patched });
}
if (!check) {
  for (const plan of plans) {
    if (plan.original) {
      await mkdir(dirname(plan.backup), { recursive: true, mode: 0o700 });
      try { await writeFile(plan.backup, plan.original, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    // Added helper files become inert after restoring their importing modules.
    if (!plan.next || plan.current?.equals(plan.next)) continue;
    const temporary = `${plan.target}.jev-reach-${process.pid}.tmp`;
    await writeFile(temporary, plan.next, { flag: 'wx' });
    await rename(temporary, plan.target);
    if (hash(await readFile(plan.target)) !== hash(plan.next)) throw new Error(`Write verification failed: ${plan.target}`);
  }
}
console.log(JSON.stringify({ status: check ? 'VERIFIED' : rollback ? 'RESTORED' : 'PATCHED', version, files: plans.length }));
