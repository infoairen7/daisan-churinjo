// Targeted check of both endings + starting a new run from the ending screen (uses the debug floor jump).
import { open } from './pw.mjs';
const out = process.argv[2];
const h = await open('http://localhost:8765/local.html', { outDir: out });
const log = (k, v) => console.log(k, typeof v === 'string' ? v : JSON.stringify(v));
async function aim(px, pz, yaw, id) { await h.tp(px, pz, yaw); await h.waitFor((s) => s.target === id, 20000, 'target ' + id); }
async function solve2() {
  await h.face(-0.5, 5.9, -0.85, 6.74); await h.waitFor((s) => s.target === 'panel', 20000, 'panel target');
  await h.key('Space'); await h.waitFor((s) => s.ui.includes('panel'), 8000, 'panel');
  const a = await h.page.evaluate(() => window.__p3.answer());
  for (const d of a) await h.key('Digit' + d, 40);
  await h.page.click('[data-open]');
  await h.waitFor((s) => s.floor === 1 && s.doors === 'open' && s.mode === 'world' && s.phase === 'EXIT', 60000, 'arrive 1F');
}
async function leave() {
  await aim(0.0, 5.4, -Math.PI / 2, 'rail');
  await h.key('Space'); await h.waitFor((s) => s.ui.includes('dialog'), 8000, 'rail dialog');
  await h.key('Space'); await h.waitFor((s) => s.bike === 'held', 8000, 'undock');
  // without the bike the doorway is blocked; with it the player walks out
  await h.tp(0.0, -5.6, 0);
  await h.page.keyboard.down('KeyW');
}
try {
  await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
  await h.page.evaluate(() => window.__p3.setMaxDt(0.5));
  await h.key('Space');
  await h.waitFor((s) => s.mode === 'world', 60000, 'intro');
  await h.page.evaluate(() => { window.__p3.jump(2); window.__p3.game.save.wrongTotal = 1; });
  await h.sleep(1500);
  await solve2();
  // barrier: try to walk out while docked
  await h.tp(0.0, -5.6, 0); await h.page.keyboard.down('KeyW'); await h.sleep(4000); await h.page.keyboard.up('KeyW');
  let s = await h.st(); log('blocked without bike', { z: s.pos[2], phase: s.phase });
  await leave();
  await h.waitFor((s) => s.phase === 'NORMAL_END', 60000, 'normal end'); await h.page.keyboard.up('KeyW');
  await h.waitFor((s) => s.view === 'bedroom', 30000, 'bedroom');
  await h.sleep(3000); await h.shot('e1_bedroom');
  s = await h.st(); log('bedroom hud', { ui: s.ui });
  await h.page.keyboard.down('KeyD'); await h.sleep(6000); await h.page.keyboard.up('KeyD');
  await h.waitFor((s) => s.ui.includes('ending'), 20000, 'normal ending ui');
  await h.sleep(800); await h.shot('e2_normal_end');
  log('records', await h.page.evaluate(() => JSON.parse(localStorage.getItem('parking3.records.v1'))));
  log('save cleared', await h.page.evaluate(() => localStorage.getItem('parking3.save.v1') === null));
  await h.page.click('[data-act="new"]');
  await h.waitFor((s) => s.mode === 'world' && s.phase === 'INTRO' && s.view === 'facility', 60000, 'new run intro');
  s = await h.st(); log('new run', { wrongTotal: s.wrongTotal, hasFailed: s.hasFailed, ui: s.ui });
  await h.page.evaluate(() => window.__p3.jump(2));
  await h.sleep(1500);
  await solve2();
  await leave();
  await h.waitFor((s) => s.phase === 'SECRET_END', 60000, 'secret start');
  await h.sleep(1500); await h.shot('e3_secret_walk');
  await h.waitFor((s) => s.ui.includes('ending'), 90000, 'secret ending ui'); await h.page.keyboard.up('KeyW');
  await h.sleep(800); await h.shot('e4_secret_end');
  s = await h.st(); log('secret', { view: s.view, phase: s.phase, z: s.pos[2] });
  log('records', await h.page.evaluate(() => JSON.parse(localStorage.getItem('parking3.records.v1'))));
  log('RESULT', 'PASS');
} catch (e) { log('RESULT', 'FAIL ' + e.message.slice(0, 400)); await h.shot('ezz'); }
log('console', h.logs.filter((l) => !l.includes('ERR_TUNNEL')));
await h.browser.close();
