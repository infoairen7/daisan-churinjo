// Renders the store / OGP images from the real game (debug build on localhost:8765), then lays out the title on top.
// node tools/capture_media.mjs <outDir>   → raw_*.png (game frames), ogp.jpg (1200x630), thumb_1280x720.jpg, face_1280x720.jpg
import { open } from './pw.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const out = process.argv[2] || 'media/raw';
const parts = (process.argv[3] || 'elevator,figure,face,compose').split(',');
const want = (p) => parts.includes(p);
const W = 1600, H = 900;
if (want('elevator') || want('figure') || want('face')) {
const h = await open('http://localhost:8765/local.html?lang=ja', { outDir: out, width: W, height: H });
const ev = (fn, a) => h.page.evaluate(fn, a);
const adv = (t) => h.page.evaluate((t) => window.__p3.advance(t), t);
const hideUi = () => ev(() => { const g = window.__p3.game; g.ui.showHud(false); g.ui.bikeCard(null); for (const id of ['#toast', '#caption']) { const e = document.querySelector(id); if (e) e.hidden = true; } document.querySelector('#dpad')?.setAttribute('hidden', ''); });
await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
await ev(() => { const g = window.__p3.game; g.settings.quality = 'high'; g.settings.caretakerHi = true; g.applySettings(); window.__p3.noAdapt(); window.__p3.setMaxDt(0.5); });
await h.key('Space');
await h.waitFor((s) => s.mode === 'world', 90000, 'world');
await h.page.waitForFunction(() => !!window.__p3.game.caretakerTpl, null, { timeout: 120000 });

// A: 5F, the lit car seen from the dark floor
if (want('elevator')) {
  await ev(() => window.__p3.jump(5)); await h.sleep(2500);
  await h.tp(0.35, 0.9, Math.PI + 0.06); await h.sleep(1500); await hideUi(); await h.sleep(400);
  await h.page.screenshot({ path: `${out}/raw_elevator.png` });
}

// B: 2F, the figure at the end of the aisle
if (want('figure')) {
await ev(() => window.__p3.jump(2)); await h.sleep(1500);
await h.tp(0, 3.4, Math.PI);
await h.page.waitForFunction(() => window.__p3.fx().silState === 'shown', null, { timeout: 120000 });
await ev(() => window.__p3.freeze(true));
await h.tp(-0.35, 2.2, 0.03); await adv(0.05); await hideUi(); await adv(0.05);
await h.page.screenshot({ path: `${out}/raw_figure.png` });
await ev(() => window.__p3.freeze(false));
}

// C: the caretaker's face (failure) for an alternative, scarier thumbnail
if (want('face')) {
await ev(() => window.__p3.jump(4)); await h.sleep(1500);
await ev(() => window.__p3.game.openPanelFromWorld());
const a = await ev(() => window.__p3.answer());
const wrong = a.map((d) => (d === 5 ? 4 : d + 1));
for (let k = 0; k < 2; k++) { for (const d of wrong) await h.key('Digit' + d, 40); await h.page.click('[data-open]'); await h.sleep(500); if (k === 0) await h.page.click('[data-clear]'); }
await h.waitFor((s) => s.doors === 'opening' && s.floor === 5, 60000, 'reveal');
await ev(() => window.__p3.freeze(true));
await adv(3.1);
for (let i = 0; i < 60 && !(await ev(() => window.__p3.game.caretaker.lunging)); i++) await adv(0.05);
await adv(0.24); await hideUi(); await ev(() => { document.querySelector('#flash').style.opacity = '0'; document.querySelector('#app').classList.remove('jolt'); });
await h.page.screenshot({ path: `${out}/raw_face.png` });
await ev(() => window.__p3.freeze(false));
}
await h.browser.close();
}

// ---- layout: title lockup + lines over the frame
const lockup = readFileSync('public/assets/ui/title_lockup.svg', 'utf8');
const b64 = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');
async function compose(bg, file, w, hh, opts = {}) {
  const k = await open('about:blank', { outDir: out, width: w, height: hh });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${w}px;height:${hh}px;overflow:hidden;background:#000;font-family:'Noto Sans CJK JP','Noto Sans JP',sans-serif}
    .bg{position:absolute;top:0;height:100%;width:${(hh * 16) / 9}px;left:${opts.shift ?? 0}px;background:url(${b64(bg)}) center/cover;filter:brightness(${opts.bright ?? 1.15}) contrast(1.05);-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 30%);mask-image:linear-gradient(90deg,transparent 0,#000 30%)}
    .shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,8,10,.92) 0%,rgba(8,8,10,.72) 34%,rgba(8,8,10,.1) 62%,rgba(8,8,10,0) 100%)}
    .vig{position:absolute;inset:0;box-shadow:inset 0 0 ${w * 0.12}px rgba(0,0,0,.8)}
    .t{position:absolute;left:${w * 0.055}px;top:50%;transform:translateY(-50%);width:${w * 0.5}px}
    .t svg{width:100%;height:auto;display:block;margin-left:-${w * 0.012}px}
    .en{color:#E9B96E;letter-spacing:.34em;font-weight:700;font-size:${w * 0.0185}px;margin:${w * 0.004}px 0 ${w * 0.024}px}
    .ja{color:#F0EBDD;font-size:${w * 0.024}px;font-weight:500;line-height:1.55;margin:0}
    .sub{color:#B9B1A5;font-size:${w * 0.0155}px;margin:${w * 0.016}px 0 0;letter-spacing:.04em}
  </style></head><body><div class="bg"></div><div class="shade"></div><div class="vig"></div>
  <div class="t">${lockup}<div class="en">BICYCLE PARKING No.3</div>
  <p class="ja">深夜23時、自転車を取りに来ただけだった。<br>2回まちがえると、管理人が来る。</p>
  <p class="sub">ブラウザで遊べる一人称ホラー謎解き　/　日本語・English</p></div></body></html>`;
  await k.page.setContent(html);
  await k.page.waitForTimeout(400);
  await k.page.screenshot({ path: file, type: 'jpeg', quality: 88 });
  await k.browser.close();
}
if (want('compose')) {
  // main: the caretaker on the right; alt: the lit elevator (no face)
  await compose(`${out}/raw_face.png`, `${out}/ogp.jpg`, 1200, 630, { shift: 1200 * 0.27, bright: 1.05 });
  await compose(`${out}/raw_face.png`, `${out}/thumb_1280x720.jpg`, 1280, 720, { shift: 1280 * 0.27, bright: 1.05 });
  await compose(`${out}/raw_elevator.png`, `${out}/ogp_alt.jpg`, 1200, 630, { shift: 1200 * 0.2, bright: 1.1 });
  await compose(`${out}/raw_elevator.png`, `${out}/thumb_alt_1280x720.jpg`, 1280, 720, { shift: 1280 * 0.2, bright: 1.1 });
}
writeFileSync(`${out}/done.txt`, 'ok');
console.log('done');
