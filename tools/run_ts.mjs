// Bundle a TS entry with esbuild and run it in node (no network/npm install needed).
import { build } from '/opt/npm-tools/node_modules/esbuild/lib/main.js';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [entry, ...rest] = process.argv.slice(2);
const out = join(mkdtempSync(join(tmpdir(), 'p3-')), 'run.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
process.argv = [process.argv[0], out, ...rest];
await import(pathToFileURL(out).href);
