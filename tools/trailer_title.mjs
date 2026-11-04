// Title-card layers for the PV (transparent 1920x1080 PNGs): logo, and the info lines under it.
// node tools/trailer_title.mjs <outDir>
import { open } from './pw.mjs';
import { readFileSync } from 'node:fs';
const out = process.argv[2];
const lockup = readFileSync('public/assets/ui/title_lockup.svg', 'utf8');
const v2 = process.argv[3] === 'v2';
const layers = {
  logo: `<div class="logo">${lockup}<div class="en">BICYCLE PARKING No.3</div>${v2 ? '<div class="ver">Ver.2</div>' : ''}</div>`,
  info: v2
    ? `<div class="info"><p class="ja">10階建てになって、公開中　／　ブラウザで無料・日本語・English</p><p class="url">infoairen7.github.io/daisan-churinjo</p></div>`
    : `<div class="info"><p class="ja">ブラウザで無料プレイ　／　日本語・English</p><p class="url">infoairen7.github.io/daisan-churinjo</p></div>`,
};
const css = `html,body{margin:0;width:1920px;height:1080px;background:transparent;font-family:'Noto Sans CJK JP',sans-serif}
.logo{position:absolute;left:50%;top:41%;transform:translate(-50%,-50%);width:980px;text-align:center}
.logo svg{width:100%;height:auto;display:block}
.en{color:#E9B96E;letter-spacing:.5em;font-weight:700;font-size:34px;margin-top:8px;padding-left:.5em}
.ver{display:inline-block;margin-top:22px;color:#F0EBDD;border:2px solid rgba(233,185,110,.75);padding:6px 22px 8px;font-size:34px;letter-spacing:.3em;padding-left:calc(22px + .3em);font-weight:700}
.info{position:absolute;left:0;right:0;top:70%;text-align:center}
.ja{color:#F0EBDD;font-size:38px;font-weight:500;margin:0 0 22px;letter-spacing:.06em}
.url{color:#B9B1A5;font-size:30px;margin:0;letter-spacing:.08em;font-family:'Noto Sans CJK JP',monospace}`;
for (const [name, body] of Object.entries(layers)) {
  const h = await open('about:blank', { outDir: out, width: 1920, height: 1080 });
  await h.page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
  await h.page.waitForTimeout(300);
  await h.page.screenshot({ path: `${out}/title_${name}.png`, omitBackground: true });
  await h.browser.close();
}
console.log('title layers done');
