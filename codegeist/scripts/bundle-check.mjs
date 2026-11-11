// Bundles both Forge entry points with esbuild, so a missing import or a broken
// export fails here instead of at `forge deploy`. It also checks that every
// `function` handler named in manifest.yml is exported by src/index.ts.
// Output goes to .bundle-check/ (ignored by git); Forge does its own bundling on deploy.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, '.bundle-check');
rmSync(outdir, { recursive: true, force: true });

const manifest = parse(readFileSync(join(root, 'manifest.yml'), 'utf8'));
const handlers = (manifest.modules.function ?? []).map((fn) => fn.handler);

const backend = await build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: join(outdir, 'backend.mjs'),
  metafile: true,
  logLevel: 'error',
});

const frontend = await build({
  entryPoints: [join(root, 'src/frontend/index.tsx')],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'esm',
  jsx: 'transform',
  outfile: join(outdir, 'frontend.js'),
  metafile: true,
  logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const backendOutput = Object.values(backend.metafile.outputs).find((output) => output.entryPoint);
const exported = new Set(backendOutput?.exports ?? []);
const missing = handlers.filter((handler) => {
  const [file, name] = handler.split('.');
  return file !== 'index' || !exported.has(name);
});

const size = (result) =>
  Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(`backend bundle:  ${(size(backend) / 1024).toFixed(0)} KiB, exports: ${[...exported].sort().join(', ')}`);
console.log(`frontend bundle: ${(size(frontend) / 1024).toFixed(0)} KiB`);

if (missing.length > 0) {
  console.error(`manifest handlers not exported by src/index.ts: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`all ${handlers.length} manifest handlers are exported.`);
