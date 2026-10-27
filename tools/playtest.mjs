// Scripted end-to-end playtest of every branch in spec §8/§9 (headless Chromium + SwiftShader).
// node tools/playtest.mjs <outDir> [url]
import { open } from './pw.mjs';
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const url = process.argv[3] || 'http://localhost:8765/local.html';
const h = await open(url, { outDir: out });
const EVZ = 5.3;
const report = [];
const log = (k, v) => { report.push([k, v]); console.log(k, typeof v === 'string' ? v : JSON.stringify(v)); };
const slotZ = (s) => -5.525 + (s - 1) * 1.35;
const answer = () => h.page.evaluate(() => window.__p3.answer());
const puzzle = (f) => h.page.evaluate((f) => window.__p3.game.puzzleFor(f), f);
const clickSel = async (sel) => { await h.page.click(sel); await h.sleep(250); };
async function aim(px, pz, tx, tz, id) {
  if (tx === null) await h.tp(px, pz, tz); else await h.face(px, pz, tx, tz);
  const s = await h.waitFor((s) => (id ? s.target === id || (id.endsWith('*') && s.target && s.target.startsWith(id.slice(0, -1))) : true), 15000, 'target ' + id);
  log('aim ' + id, s.target);
}
const press = async (id, k = 'Space') => { await h.key(k); };
const ui = (name) => h.waitFor((s) => s.ui.includes(name), 8000, 'ui ' + name);
const noUi = () => h.waitFor((s) => s.ui.length === 0, 8000, 'no ui');

async function intro() {
  await h.waitFor((s) => s.mode === 'world' && s.phase === 'INTRO', 40000, 'intro world');
  await h.shot('02_outside');
  await h.key('KeyW', 1200);
  let s = await h.st(); log('walked', { z: s.pos[2] });
  // 1F: call the car
  await aim(1.22, 2.85, null, Math.PI, 'call');
  await h.shot('03_1F_call');
  await h.key('Space'); await h.waitFor((s) => s.doors === 'open', 6000, 'doors open 1F');
  await aim(-0.5, 5.9, -0.85, 6.74, 'panel');
  await h.key('Space'); await ui('panel');
  await h.shot('04_panel_normal');
  await h.key('Digit5');
  await h.waitFor((s) => s.floor === 5 && s.doors === 'open' && s.mode === 'world', 45000, 'arrive 5F');
  await h.shot('05_5F_arrival');
  // bike 517
  await aim(-5.7, 5.5, -7.4, 5.5, 'bike517');
  await h.key('Space'); await ui('dialog'); await h.shot('06_517_dialog');
  await h.key('Space'); await h.waitFor((s) => s.bike === 'held', 8000, 'held');
  log('bike', (await h.st()).bike);
  // pay
  await aim(-4.6, 4.35, null, Math.PI, 'terminal');
  await h.key('Space'); await ui('dialog'); await h.sleep(300); await h.shot('07_receipt');
  await h.key('Space'); await noUi();
  // call → blackout
  await aim(1.22, 2.85, null, Math.PI, 'call');
  await h.key('Space');
  await h.waitFor((s) => s.phase === 'BLACKOUT' && s.doors === 'open' && s.mode === 'world', 9000, 'blackout doors open');
  await h.shot('08_blackout_emergency');
  await h.tp(-0.5, 5.0, Math.PI);
  await h.waitFor((s) => s.phase === 'LOCKED' && s.mode === 'world', 9000, 'locked');
  // panel is dead and does not count as wrong
  await aim(-0.5, 5.9, -0.85, 6.74, 'panel');
  await h.key('Space'); await ui('panel'); await h.key('Digit3'); await h.sleep(300); await h.shot('09_panel_dead'); await h.key('Escape'); await noUi();
  log('after dead panel', await h.st());
  // rail
  await aim(0.0, 5.4, null, -Math.PI / 2, 'rail');
  await h.key('Space'); await ui('dialog'); await h.shot('10_rail'); await h.key('Space');
  await h.waitFor((s) => s.bike === 'docked', 8000, 'docked');
  // reader via tools menu (道具 → 精算済票 → 使う → Space on the reader)
  await aim(-0.2, 5.9, -0.18, 6.75, 'reader');
  await h.key('KeyI'); await ui('tools');
  await h.page.click('[data-item="receipt"]'); await h.sleep(200);
  await h.shot('11_tools');
  await h.page.click('[data-use]'); await noUi();
  log('held', await h.st());
  await h.key('Space'); await h.sleep(1500);
  log('after reader', await h.st());
  await h.waitFor((s) => s.ui.includes('dialog'), 8000, 'rules dialog');
  await h.shot('12_rules');
  await h.key('Space');
  await h.waitFor((s) => s.phase === 'EXPLORE' && s.doors === 'open' && s.mode === 'world', 9000, 'explore 5F');
}

async function inspectFirstBike(floor, tag) {
  const p = await puzzle(floor);
  const b = p.bikes[0];
  const bx = b.row === 'A' ? -5.4 : 4.6, z = slotZ(b.slot);
  const px = b.row === 'A' ? -3.85 : 3.35;
  await aim(px, z, bx, z, 'bike:' + b.id);
  await h.shot(tag + '_aisle');
  await h.key('Space'); await h.page.waitForSelector('#bike-card.is-in', { timeout: 15000 }); await h.sleep(300); await h.shot(tag + '_inspect');
  const memo = await h.page.evaluate((f) => (window.__p3.game.save.memo[String(f)] || []).map((e) => e.id), floor); log('memo ' + floor, memo);
}

async function openPanel() {
  await aim(-0.5, 5.9, -0.85, 6.74, 'panel');
  await h.key('Space'); await ui('panel');
}
async function enter(digits) { for (const d of digits) await h.key('Digit' + d, 40); await clickSel('[data-open]'); }
const wrongOf = (a) => a.map((d) => (d === 5 ? 4 : d + 1));

async function solveFloor(floor, tag) {
  await openPanel();
  const a = await answer();
  await h.shot(tag + '_panel');
  await enter(a);
  await h.waitFor((s) => s.floor === floor - 1 && s.doors === 'open' && s.mode === 'world', 90000, 'descend to ' + (floor - 1));
}

try {
  await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
  await h.page.evaluate(() => window.__p3.setMaxDt(0.5));
  await h.sleep(800);
  await h.key('Space'); // はじめから
  await intro();
  await h.shot('13_5F_explore');
  await inspectFirstBike(5, '14_5F');
  // ---- run 1: wrong → warning → correct on 5F
  await openPanel();
  let a = await answer();
  if (a.length > 1) { await h.key('Digit' + a[0]); await clickSel('[data-open]'); const s = await h.st(); log('incomplete keeps state', { wrong: s.wrongTotal, warn: s.warningArmed }); await clickSel('[data-clear]'); }
  else { await clickSel('[data-open]'); const s = await h.st(); log('empty submit keeps state', { wrong: s.wrongTotal, warn: s.warningArmed }); }
  await enter(wrongOf(a)); await h.sleep(500);
  let s = await h.st(); log('after first wrong', { wrongTotal: s.wrongTotal, warningArmed: s.warningArmed, phase: s.phase });
  await h.shot('15_warning');
  await clickSel('[data-reinspect]'); await h.waitFor((s) => s.doors === 'open' && s.ui.length === 0, 6000, 'reinspect');
  s = await h.st(); log('after reinspect', { warningArmed: s.warningArmed });
  await openPanel(); a = await answer(); await enter(a);
  await h.waitFor((s) => s.floor === 4 && s.doors === 'open' && s.mode === 'world', 90000, 'descend to 4');
  s = await h.st(); log('4F after correct during warning', { wrongTotal: s.wrongTotal, warningArmed: s.warningArmed });
  await h.shot('16_4F');
  // ---- 4F: wrong, wrong → caretaker → game over
  await openPanel(); a = await answer();
  await enter(wrongOf(a)); await h.sleep(400);
  await clickSel('[data-clear]');
  await enter(wrongOf(a));
  await h.waitFor((s) => s.phase === 'FAIL_REVEAL', 5000, 'fail reveal');
  await h.waitFor((s) => s.doors === 'open' && s.floor === 5, 20000, 'reveal doors');
  await h.sleep(500); await h.shot('17_reveal_normal');
  await h.sleep(1400); await h.shot('18_reveal_terror');
  await h.waitFor((s) => s.ui.includes('gameover'), 15000, 'gameover');
  await h.shot('19_gameover');
  s = await h.st(); log('gameover', { wrongTotal: s.wrongTotal, hasFailed: s.hasFailed, phase: s.phase });
  // reload persists the failure
  const saved = await h.page.evaluate(() => JSON.parse(localStorage.getItem('parking3.save.v1')));
  log('saved after fail', { phase: saved.phase, wrongTotal: saved.wrongTotal, hasFailed: saved.hasFailed, resumeFloor: saved.resumeFloor });
  await h.page.click('[data-act="retry"]'); // この階から再開
  await h.waitFor((s) => s.floor === 4 && s.mode === 'world' && s.phase === 'EXPLORE', 8000, 'retry 4F');
  s = await h.st(); log('after retry', { floor: s.floor, wrongTotal: s.wrongTotal, warningArmed: s.warningArmed, hasFailed: s.hasFailed });
  await solveFloor(4, '20_4F');
  await inspectFirstBike(3, '21_3F');
  await solveFloor(3, '22_3F');
  await solveFloor(2, '23_2F');
  s = await h.st(); log('1F', s);
  await h.shot('24_1F');
  // undock & leave → normal ending
  await aim(0.0, 5.4, null, -Math.PI / 2, 'rail');
  await h.key('Space'); await ui('dialog'); await h.key('Space'); await h.waitFor((s) => s.bike === 'held', 8000, 'undocked');
  await h.tp(0.0, -5.6, 0); await h.sleep(200);
  await h.page.keyboard.down('KeyW'); await h.waitFor((s) => s.phase === 'NORMAL_END', 30000, 'normal end start'); await h.sleep(1200); await h.shot('25_exit_fade'); await h.page.keyboard.up('KeyW');
  await h.waitFor((s) => s.view === 'bedroom', 15000, 'bedroom');
  await h.sleep(3500); await h.shot('26_bedroom_ceiling');
  await h.page.keyboard.down('KeyD'); await h.sleep(2500); await h.shot('27_bedroom_turning'); await h.sleep(4000); await h.page.keyboard.up('KeyD');
  await h.waitFor((s) => s.ui.includes('ending'), 8000, 'normal ending');
  await h.sleep(600); await h.shot('28_normal_end');
  const rec = await h.page.evaluate(() => JSON.parse(localStorage.getItem('parking3.records.v1')));
  log('records after normal', rec);
  // ---- run 2: no mistakes → secret ending
  await clickSel('[data-act="new"]');
  await intro();
  for (const f of [5, 4, 3, 2]) await solveFloor(f, `3${6 - f}_r2_${f}F`);
  s = await h.st(); log('run2 at 1F', { wrongTotal: s.wrongTotal, hasFailed: s.hasFailed });
  await aim(0.0, 5.4, null, -Math.PI / 2, 'rail');
  await h.key('Space'); await ui('dialog'); await h.key('Space'); await h.waitFor((s) => s.bike === 'held', 8000, 'undocked');
  await h.tp(0.0, -5.6, 0); await h.sleep(200);
  await h.page.keyboard.down('KeyW'); await h.waitFor((s) => s.phase === 'SECRET_END', 30000, 'secret start'); await h.sleep(1500); await h.shot('40_secret_outside');
  await h.waitFor((s) => s.pos[2] < -15.7, 60000, 'walk to caption'); await h.page.keyboard.up('KeyW');
  await h.sleep(2500); await h.shot('41_secret_caption');
  await h.waitFor((s) => s.ui.includes('ending'), 15000, 'secret ending');
  await h.shot('42_secret_end');
  s = await h.st(); log('secret end', { view: s.view, phase: s.phase });
  log('records final', await h.page.evaluate(() => JSON.parse(localStorage.getItem('parking3.records.v1'))));
  log('RESULT', 'PASS');
} catch (e) {
  log('RESULT', 'FAIL ' + e.message);
  await h.shot('zz_fail');
}
log('console', h.logs.filter((l) => !l.includes('ERR_TUNNEL')).slice(0, 30));
writeFileSync(out + '/report.json', JSON.stringify(report, null, 1));
await h.browser.close();
