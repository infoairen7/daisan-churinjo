// Build the game.
//   node tools/build.mjs                    → dist/   claude.ai artifact page (index.html without <html>/<head>/<body>,
//                                                     models as base64 JSON because that host does not serve .glb)
//                                                     + dist/local.html, the same page as a full document for local play
//   node tools/build.mjs --target web       → docs/   GitHub Pages / any static host: full HTML with OGP tags, GLB models
//   --debug        keep the test hooks (window.__p3) that tools/playtest*.mjs drive; never ship this
//   --dev          no minify, inline source maps
//   --share-url U  the public page that "Post on X" links to (default: the GitHub Pages address below)
//   --out DIR      output folder
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

let esbuild;
try { esbuild = await import('esbuild'); } catch { esbuild = await import('/opt/npm-tools/node_modules/esbuild/lib/main.js'); }

const DEFAULT_SHARE_URL = 'https://infoairen7.github.io/daisan-churinjo/';
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dev = args.includes('--dev');
const debug = args.includes('--debug');
const target = get('--target', 'artifact');
const web = target === 'web';
const out = get('--out', web ? 'docs' : 'dist');
const shareUrl = get('--share-url', DEFAULT_SHARE_URL);
const entry = get('--entry', null);
mkdirSync(out, { recursive: true });

const define = {
  __DEBUG__: debug ? 'true' : 'false',
  __SHARE_URL__: JSON.stringify(shareUrl),
  __MODEL_EXT__: JSON.stringify(web ? 'glb' : 'json'),
};

if (entry) { // auxiliary bundles (smoke tests)
  await esbuild.build({ entryPoints: [entry], outfile: get('--out', 'dist/aux.js'), bundle: true, format: 'iife', target: ['es2020'], sourcemap: dev ? 'inline' : false, logLevel: 'warning', define });
  process.exit(0);
}
execSync('node tools/gen_ui_assets.mjs', { stdio: 'inherit' });
const r = await esbuild.build({
  entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife', target: ['es2020', 'safari15'],
  minify: !dev, sourcemap: dev ? 'inline' : false, legalComments: 'none', logLevel: 'warning', charset: 'utf8', define,
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const page = readFileSync('public/page.template.html', 'utf8').replace('/*__GAME_JS__*/', () => js);

const TITLE = '第３駐輪場 / Bicycle Parking No.3';
const DESC_JA = '深夜23時、5階に停めた自転車を取りに来ただけだった。停電、閉じ込められたエレベーター、駐輪車を数える照合票。2回間違えると管理人が来る。ブラウザで遊べる一人称ホラー謎解き。';
const DESC_EN = '11 p.m. You only came back for your bike. A power cut, a locked elevator, and a checklist that makes you count the parked bicycles. Get it wrong twice and the caretaker comes.';

if (web) {
  // split the template: everything before the app markup belongs in <head>
  const cut = page.indexOf('<div id="app">');
  const headPart = page.slice(0, cut).replace(/<title>[^<]*<\/title>/, '');
  const bodyPart = page.slice(cut);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const img = shareUrl + 'ogp.jpg';
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    `<title>${TITLE}</title>`,
    `<meta name="description" content="${esc(DESC_JA)}">`,
    '<meta name="theme-color" content="#151619">',
    '<link rel="icon" href="favicon.svg" type="image/svg+xml">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="第３駐輪場">',
    `<meta property="og:title" content="${TITLE}">`,
    `<meta property="og:description" content="${esc(DESC_JA + ' / ' + DESC_EN)}">`,
    `<meta property="og:url" content="${shareUrl}">`,
    `<meta property="og:image" content="${img}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="第３駐輪場 — 非常灯だけが点く深夜の駐輪場 / Bicycle Parking No.3">',
    '<meta property="og:locale" content="ja_JP">',
    '<meta property="og:locale:alternate" content="en_US">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${TITLE}">`,
    `<meta name="twitter:description" content="${esc(DESC_JA)}">`,
    `<meta name="twitter:image" content="${img}">`,
  ].join('\n');
  writeFileSync(`${out}/index.html`, `<!doctype html>\n<html lang="ja">\n<head>\n${head}\n${headPart.trim()}\n</head>\n<body>\n${bodyPart}\n</body>\n</html>\n`);
  writeFileSync(`${out}/.nojekyll`, '');
  cpSync('public/favicon.svg', `${out}/favicon.svg`);
  if (existsSync('media/ogp.jpg')) cpSync('media/ogp.jpg', `${out}/ogp.jpg`);
} else {
  writeFileSync(`${out}/index.html`, page);
  writeFileSync(`${out}/local.html`, `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n${page}\n</body></html>`);
}
rmSync(`${out}/assets/audio`, { recursive: true, force: true }); cpSync('public/assets/audio', `${out}/assets/audio`, { recursive: true });
rmSync(`${out}/assets/music`, { recursive: true, force: true }); cpSync('public/assets/music', `${out}/assets/music`, { recursive: true });
rmSync(`${out}/assets/models`, { recursive: true, force: true }); mkdirSync(`${out}/assets/models`, { recursive: true });
for (const f of readdirSync('public/assets/models')) {
  if (!f.endsWith('.glb')) continue;
  const name = f.replace(/\.glb$/, '');
  if (web) cpSync(`public/assets/models/${f}`, `${out}/assets/models/${f}`);
  else writeFileSync(`${out}/assets/models/${name}.json`, JSON.stringify({ format: 'glb-base64', name, data: readFileSync(`public/assets/models/${f}`).toString('base64') }));
}
if (existsSync(`${out}/assets/ui`)) rmSync(`${out}/assets/ui`, { recursive: true, force: true });
console.log(`${out}/index.html ${(page.length / 1024).toFixed(0)} KB (js ${(js.length / 1024).toFixed(0)} KB)${debug ? '  [DEBUG hooks]' : ''}  target=${target}`);
