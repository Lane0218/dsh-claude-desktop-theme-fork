// Fork build: same esbuild pipeline as scripts/build.mjs, without the tsc
// declaration pass (a linked local install only consumes lib/index.js and
// lib/client.js, never lib/types).
import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BASELINE_MODULES } from './lib/platform.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await rm(join(root, 'lib'), { recursive: true, force: true });
await mkdir('lib', { recursive: true });
await mkdir('artifacts/build', { recursive: true });

const baseline = BASELINE_MODULES;
const host = {
  entryPoints: ['src/host/index.ts'], outfile: 'lib/index.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node22',
  external: [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)],
};
const client = {
  entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', metafile: true,
  external: baseline, loader: { '.css': 'text' },
  define: { __CCD_PLUGIN_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(pkg.name)},\n  factory(require) {\n    const module = { exports: {} };\n    const exports = module.exports;` },
  footer: { js: '\n    return module.exports;\n  }\n});' },
  plugins: [{
    name: 'check-shared-module-requests',
    setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-/ }, args => {
        if (!baseline.includes(args.path)) {
          return { errors: [{ text: `Dynamic DSH packages are type-only; use ctx/slots instead: ${args.path}` }] };
        }
        return undefined;
      });
      builder.onEnd(async result => {
        if (result.errors.length > 0 || result.metafile === undefined) return;
        const requests = Object.values(result.metafile.outputs)
          .flatMap(output => output.imports).filter(item => item.external);
        for (const request of requests) {
          if (!baseline.includes(request.path)) {
            throw new Error(`Undeclared DSH module request: ${request.path}`);
          }
        }
        await writeFile(join(root, 'artifacts/build/client-meta.json'), JSON.stringify(result.metafile, null, 2));
      });
    },
  }],
};

await Promise.all([build(host), build(client)]);
console.log('Built lib/index.js and lib/client.js (fork, declarations skipped).');
