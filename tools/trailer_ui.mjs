// UI layers (transparent PNGs) for the PV's gameplay shots, rebuilt with the same seed as tools/trailer_capture.mjs.
// Headless SwiftShader stalls on any screenshot after the first one, so each run takes exactly one snapshot.
// node tools/trailer_ui.mjs <framesDir> inspect_prompt|inspect_card|panel_<k>|panel_warn
import { open } from './pw.mjs';
import { writeFileSync } from 'node:fs';
const [out, state] = process.argv.slice(2);
const which = state.startsWith('inspect') ? 'inspect' : 'wrong';
const h = await open('http://localhost:8765/local.html?lang=ja', { outDir: out, width: 1920, height: 1080 });
const ev = (fn, a) => h.page.evaluate(fn, a);
const cdp = await h.page.context().newCDPSession(h.page);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
async function snap(name) {
  await h.sleep(900);
  // CSS fades run on wall-clock time; wait until they finish (slow under SwiftShader)
  await h.page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: 20000 }).catch(() => {});
  await h.sleep(600);
  await ev(() => {
    const g = window.__p3.game; g.ui.fadeInstant(0);
    for (const id of ['#toast', '#caption', '#chapter']) { const e = document.querySelector(id); if (e) e.hidden = true; }
    document.querySelector('#gl').style.visibility = 'hidden';
    for (const e of [document.documentElement, document.body, document.querySelector('#app')]) e.style.background = 'transparent';
  });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${out}/ui_${name}.png`, Buffer.from(shot.data, 'base64'));
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {});
  await ev(() => { document.querySelector('#gl').style.visibility = ''; for (const e of [document.documentElement, document.body, document.querySelector('#app')]) e.style.background = ''; });
  console.log('ui', name);
}
await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 180000 });
await ev(() => { const g = window.__p3.game; g.settings.subtitles = false; g.ui.subtitles = false; window.__p3.seed(310517); });
await h.key('Space');
await h.waitFor((s) => s.mode === 'world', 120000, 'world');
if (which === 'inspect') {
  await ev(() => window.__p3.jump(4));
  const bikes = await ev(() => window.__p3.game.puzzleFor(4).bikes.filter((b) => b.row === 'A').map((b) => [b.slot, b.id]));
  const slot = bikes.length ? bikes[Math.min(1, bikes.length - 1)][0] : 3;
  const z = -5.525 + (slot - 1) * 1.35;
  const at = (i) => { const k = i / 104; return [[lerp(-2.2, -2.75, k), 1.65, z + lerp(1.4, 0.05, ease(Math.min(1, k * 1.6)))], Math.PI / 2 - lerp(0.25, 0, Math.min(1, k * 1.6))]; };
  await ev(([p, y]) => { const g = window.__p3.game; g.pos = p; g.yaw = y; g.lookPitch = -0.12; g.ui.showHud(true); }, at(40));
  await h.sleep(2500); // let the game tick so the target prompt appears
  await ev(() => window.__p3.freeze(true));
  if (state === 'inspect_prompt') await snap('inspect_prompt');
  else { await ev((slot) => { const g = window.__p3.game; const b = g.puzzleFor(4).bikes.find((b) => b.row === 'A' && b.slot === slot); if (b) g.inspectBike(b); g.ui.showHud(true); }, slot);
  await snap('inspect_card'); }
}
if (which === 'wrong') {
  await ev(() => { const g = window.__p3.game; window.__p3.jump(4); g.pos = [0.2, 1.65, 6.0]; g.yaw = Math.PI; });
  await h.sleep(1500);
  await ev(() => { window.__p3.freeze(true); window.__p3.game.ui.showHud(true); });
  const ans = await ev(() => window.__p3.answer());
  const wrong = ans.map((d) => (d === 5 ? 4 : d + 1));
  await ev(() => window.__p3.game.openPanelFromWorld());
  const k = state === 'panel_warn' ? wrong.length : Number(state.split('_')[1]);
  for (let j = 0; j < k; j++) await ev((d) => window.__p3.game.panelDigit(d), wrong[j]);
  if (state === 'panel_warn') await ev(() => { window.__p3.game.panelOpen(); });
  await snap(state);
}
await h.browser.close();
console.log('done', which);
