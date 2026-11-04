// v2 scripted checks: the ten-storey night and the caretaker's three floors (headless Chromium + SwiftShader).
// node tools/playtest_v2.mjs <outDir> [part]      part: full | fails | scenes (default: full)
//   full   — 10F → 1F with every check and every encounter answered correctly (expects the secret ending)
//   fails  — each encounter answered wrongly, then 「この階から再開」 and answered correctly
//   scenes — screenshots of the new scenes only (fast)
import { open } from './pw.mjs';
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const part = process.argv[3] || 'full';
const url = process.argv[4] || 'http://localhost:8765/local.html?lang=ja';
const h = await open(url, { outDir: out });
const report = [];
const log = (k, v) => { report.push([k, v]); console.log(k, typeof v === 'string' ? v : JSON.stringify(v)); };
const slotZ = (s) => -5.525 + (s - 1) * 1.35;
const answer = () => h.page.evaluate(() => window.__p3.answer());
const puzzle = (f) => h.page.evaluate((f) => window.__p3.game.puzzleFor(f), f);
const clickSel = async (sel) => { await h.page.click(sel); await h.sleep(250); };
async function aim(px, pz, tx, tz, id) {
  if (tx === null) await h.tp(px, pz, tz); else await h.face(px, pz, tx, tz);
  const s = await h.waitFor((s) => (id ? s.target === id || (id.endsWith('*') && s.target && s.target.startsWith(id.slice(0, -1))) : true), 15000, 'target ' + id);
  return s;
}
const ui = (name, t = 8000) => h.waitFor((s) => s.ui.includes(name), t, 'ui ' + name);
const noUi = () => h.waitFor((s) => s.ui.length === 0, 8000, 'no ui');
async function openPanel() { await aim(-0.5, 5.9, -0.85, 6.74, 'panel'); await h.key('Space'); await ui('panel'); }
async function enter(digits) { for (const d of digits) await h.key('Digit' + d, 40); await clickSel('[data-open]'); }
const wrongOf = (a) => a.map((d) => (d === 5 ? 4 : d + 1));
const sayText = () => h.page.evaluate(() => document.querySelector('#say .line')?.textContent || '');
/** pick an option of the open choice by its visible label (substring) */
async function choose(labelPart) {
  await ui('choice', 60000);
  const idx = await h.page.evaluate((t) => [...document.querySelectorAll('.btn.choice')].findIndex((b) => b.textContent.includes(t)), labelPart);
  if (idx < 0) throw new Error('no option ' + labelPart);
  await h.key('Digit' + (idx + 1));
}

async function intro() {
  await h.waitFor((s) => s.mode === 'world' && s.phase === 'INTRO', 40000, 'intro world');
  await h.key('KeyW', 1200);
  await aim(1.22, 2.85, null, Math.PI, 'call');
  await h.key('Space'); await h.waitFor((s) => s.doors === 'open', 6000, 'doors open 1F');
  await aim(-0.5, 5.9, -0.85, 6.74, 'panel');
  await h.key('Space'); await ui('panel');
  await h.shot('01_panel_floors');
  await h.key('Digit5'); await h.sleep(300);
  log('press 5 on 1F', await h.page.evaluate(() => document.querySelector('.pad-msg')?.textContent));
  await h.key('Digit0'); // 10
  await h.waitFor((s) => s.floor === 10 && s.doors === 'open' && s.mode === 'world', 60000, 'arrive 10F');
  await h.shot('02_10F_arrival');
  await aim(-5.7, 5.5, -7.4, 5.5, 'bike517');
  await h.key('Space'); await ui('dialog'); await h.key('Space'); await h.waitFor((s) => s.bike === 'held', 8000, 'held');
  await aim(-4.6, 4.35, null, Math.PI, 'terminal');
  await h.key('Space'); await ui('dialog'); await h.sleep(300); await h.shot('03_receipt');
  await h.key('Space'); await h.sleep(600); await ui('dialog'); await h.sleep(300); await h.shot('04_night_rules');
  await h.key('Space'); await noUi();
  log('items', await h.page.evaluate(() => window.__p3.game.save.items));
  await aim(1.22, 2.85, null, Math.PI, 'call');
  await h.key('Space');
  await h.waitFor((s) => s.phase === 'BLACKOUT' && s.doors === 'open' && s.mode === 'world', 9000, 'blackout doors open');
  await h.tp(-0.5, 5.0, Math.PI);
  await h.waitFor((s) => s.phase === 'LOCKED' && s.mode === 'world', 9000, 'locked');
  await aim(0.0, 5.4, null, -Math.PI / 2, 'rail');
  await h.key('Space'); await ui('dialog'); await h.key('Space');
  await h.waitFor((s) => s.bike === 'docked', 8000, 'docked');
  await aim(-0.2, 5.9, -0.18, 6.75, 'reader');
  await h.key('KeyI'); await ui('tools');
  await h.page.click('[data-item="receipt"]'); await h.sleep(200);
  await h.page.click('[data-use]'); await noUi();
  await h.key('Space');
  await h.waitFor((s) => s.ui.includes('dialog'), 12000, 'rules dialog');
  await h.key('Space');
  await h.waitFor((s) => s.phase === 'EXPLORE' && s.doors === 'open' && s.mode === 'world' && s.floor === 10, 9000, 'explore 10F');
}

async function solve(floor) {
  await openPanel();
  const a = await answer();
  await enter(a);
  log('solved ' + floor, a);
}

async function lights8(pick) {
  await h.waitFor((s) => s.floor === 8 && s.mode === 'world', 90000, 'at 8F');
  await h.shot('10_8F_arrive');
  log('8F panel', await h.page.evaluate(() => window.__p3.state().phase));
  // walk out into the aisle so it happens sooner
  await h.tp(0.2, -0.5, 0);
  await h.waitFor((s) => s.encounter === 'lights', 40000, 'lights out');
  await h.sleep(1200); await h.shot('11_8F_dark');
  await ui('choice', 20000); await h.sleep(500); await h.shot('12_8F_choice');
  await choose(pick);
}

/** the voice in the dark asks you to open your eyes: keep them closed */
async function keepClosed(pick = '閉じたまま') {
  await h.waitFor((s) => s.encounter === 'lights' && s.choice, 60000, 'voice choice');
  log('8F voice', await h.page.evaluate(() => document.querySelector('.ov-choice')?.textContent.replace(/\s+/g, ' ').slice(0, 80)));
  await choose(pick);
}

async function ride5(pick) {
  await h.waitFor((s) => s.encounter === 'ride', 90000, 'ride');
  await h.waitFor((s) => s.doors === 'open', 30000, 'ride doors');
  await h.sleep(900); await h.shot('20_5F_doorway');
  await h.waitFor(() => true, 100); await h.page.waitForFunction(() => window.__p3.game.caretaker?.walking, null, { timeout: 20000 }).catch(() => {});
  await h.sleep(700); await h.shot('20b_5F_walking');
  await h.waitFor((s) => s.doors === 'closed', 30000, 'ride doors closed');
  await h.sleep(2600); await h.shot('21_5F_inside');
  await ui('choice', 30000); await h.sleep(2500); await h.shot('22_5F_choice');
  await choose(pick);
}

async function roll3(correct) {
  await h.waitFor((s) => s.encounter === 'rollcall', 90000, 'rollcall');
  await h.waitFor((s) => s.doors === 'open', 30000, 'rollcall doors');
  await h.sleep(1500); await h.shot('30_3F_doorway');
  await ui('choice', 30000); await h.sleep(300); await h.shot('31_3F_choice');
  const said = await sayText();
  const wrongNo = !said.includes('1017');
  log('3F said', said);
  if (correct) await choose(wrongNo ? 'いいえ' : 'はい');
  else await choose(wrongNo ? 'はい' : 'いいえ');
}

async function exitTo(kind) {
  await h.waitFor((s) => s.floor === 1 && s.mode === 'world', 120000, '1F');
  await aim(0.0, 5.4, null, -Math.PI / 2, 'rail');
  await h.key('Space'); await ui('dialog'); await h.key('Space'); await h.waitFor((s) => s.bike === 'held', 8000, 'undocked');
  await h.tp(0.0, -5.6, 0); await h.sleep(200);
  await h.page.keyboard.down('KeyW');
  await h.waitFor((s) => s.phase === kind, 30000, kind);
  await h.page.keyboard.up('KeyW');
}

async function gameOver(tag) {
  await h.waitFor((s) => s.ui.includes('gameover'), 40000, 'gameover ' + tag);
  await h.shot(tag + '_gameover');
  const line = await h.page.evaluate(() => document.querySelector('.go-line')?.textContent);
  const s = await h.st(); log('gameover ' + tag, { line, hasFailed: s.hasFailed, phase: s.phase, floor: s.floor });
  await h.page.click('[data-act="retry"]');
}

async function jump(floor) {
  await h.page.evaluate((f) => { const g = window.__p3.game; g.enc.reset(); g.save.cleared = {}; for (const x of [8, 5, 3]) if (x > f) g.save.cleared[String(x)] = true; window.__p3.jump(f); }, floor);
}

try {
  await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
  await h.page.evaluate(() => { window.__p3.setMaxDt(0.5); window.__p3.seed(310517); window.__p3.game.enc.choiceScale = 12; });
  const slow = (on) => h.page.evaluate((on) => { window.__p3.game.enc.choiceScale = on ? 12 : 1; }, on);
  await h.sleep(800);
  await h.shot('00_title');
  if (part === 'full') {
    await h.key('Space'); // はじめから
    await intro();
    await solve(10);
    await h.waitFor((s) => s.floor === 9 && s.mode === 'world', 90000, '9F');
    await solve(9);
    await lights8('目を閉じる');
    await h.sleep(2500); await h.shot('13_8F_eyes_closed');
    await keepClosed();
    await h.waitFor((s) => s.mode === 'world' && s.floor === 8, 60000, 'lights back');
    await h.sleep(800); await h.face(0.2, -0.5, 0.2, 3.0); await h.sleep(600); await h.shot('14_8F_footprints');
    log('8F cleared', (await h.st()).cleared);
    await h.tp(-0.35, 5.2, 0);
    await h.waitFor((s) => s.floor === 7 && s.mode === 'world', 90000, '7F');
    await h.sleep(1500); await h.shot('15_7F_dup_bike');
    await h.face(0, 2.5, 0.25, -5.55); await h.sleep(2500); await h.shot('16_7F_dup_close');
    await h.face(0, 2.5, 0, 6); await h.sleep(800); await h.face(0, 2.5, 0.1, -6.8); await h.sleep(1200); await h.shot('17_7F_scrawl');
    await solve(7);
    await h.waitFor((s) => s.floor === 6 && s.mode === 'world', 90000, '6F');
    await solve(6);
    await ride5('うつむいて');
    await h.sleep(2000); await h.shot('23_5F_looking_down');
    await h.waitFor((s) => s.floor === 4 && s.mode === 'world', 120000, '4F');
    log('5F cleared', (await h.st()).cleared);
    await solve(4);
    await h.sleep(2600); await h.shot('25_4F_handprints');
    await roll3(true);
    await h.sleep(3000); await h.shot('32_3F_leaving');
    await h.waitFor((s) => s.floor === 2 && s.mode === 'world', 120000, '2F');
    await solve(2);
    const s = await h.st(); log('at 1F?', { floor: s.floor, wrong: s.wrongTotal, failed: s.hasFailed, cleared: s.cleared });
    await exitTo('SECRET_END');
    await h.sleep(1500); await h.shot('40_secret');
    log('RESULT', 'PASS');
  }
  if (part === 'fails') {
    await h.key('Space');
    await h.waitFor((s) => s.mode === 'world' && s.phase === 'INTRO', 40000, 'intro world');
    // 8F: the light
    await jump(8); await lights8('ライト');
    await h.sleep(900); await h.shot('50_8F_light');
    await gameOver('51_8F');
    await h.waitFor((s) => s.floor === 8 && s.mode === 'world', 15000, 'retry 8F');
    await lights8('目を閉じる');
    // the voice: open your eyes → game over
    await keepClosed('目を開ける');
    await gameOver('51b_8F_open');
    log('gameover hint', await h.page.evaluate(() => document.querySelector('.go-hint')?.textContent || ''));
    await h.waitFor((s) => s.floor === 8 && s.mode === 'world', 15000, 'retry 8F b');
    await lights8('目を閉じる');
    await slow(false);
    // the voice again: do nothing — the timer running out is keeping them closed
    await h.waitFor((s) => s.encounter === 'lights' && s.choice, 60000, 'voice choice 2');
    await h.waitFor((s) => s.mode === 'world' && s.cleared && s.cleared['8'], 60000, '8F cleared after retry');
    await slow(true);
    log('8F retry ok (timeout on the voice = survive)', true);
    // 8F: run / timeout
    await jump(8); await lights8('走る');
    await gameOver('52_8F_run');
    await h.waitFor((s) => s.floor === 8 && s.mode === 'world', 15000, 'retry 8F');
    await h.tp(0.2, -0.5, 0);
    await slow(false);
    await h.waitFor((s) => s.encounter === 'lights', 40000, 'lights out again');
    await ui('choice', 20000);
    await gameOver('53_8F_timeout');
    await slow(true);
    // 5F: answer / press / timeout
    await jump(5); await ride5('答える');
    await h.sleep(2600); await h.shot('54_5F_answer');
    await gameOver('55_5F');
    await h.waitFor((s) => s.encounter === 'ride', 15000, 'retry ride');
    await ride5('押す');
    await gameOver('56_5F_press');
    await h.waitFor((s) => s.encounter === 'ride', 15000, 'retry ride 2');
    await slow(false);
    await ui('choice', 60000);
    await gameOver('57_5F_timeout');
    await slow(true);
    await h.waitFor((s) => s.encounter === 'ride', 15000, 'retry ride 3');
    await ride5('うつむいて');
    await h.waitFor((s) => s.floor === 4 && s.mode === 'world', 120000, '4F after retry');
    // 3F: wrong answer, then right
    await jump(3); await roll3(false);
    await h.sleep(1800); await h.shot('58_3F_wrong');
    await gameOver('59_3F');
    await roll3(true);
    await h.waitFor((s) => s.floor === 2 && s.mode === 'world', 120000, '2F after retry');
    log('RESULT', 'PASS');
  }
  if (part === 'scenes') {
    await h.key('Space');
    await h.waitFor((s) => s.mode === 'world' && s.phase === 'INTRO', 40000, 'intro world');
    await jump(8); await lights8('目を閉じる'); await keepClosed();
    await h.waitFor((s) => s.mode === 'world' && s.cleared && s.cleared['8'], 60000, '8F cleared');
    await h.sleep(600); await h.face(0.2, -0.5, 0.2, 3.0); await h.sleep(600); await h.shot('14_8F_footprints');
    await jump(5); await ride5('うつむいて');
    await h.sleep(2000); await h.shot('23_5F_looking_down');
    await h.waitFor((s) => s.floor === 4 && s.mode === 'world', 120000, '4F');
    await solve(4); await h.sleep(2600); await h.shot('25_4F_handprints');
    await roll3(true);
    await h.waitFor((s) => s.floor === 2 && s.mode === 'world', 120000, '2F');
    log('RESULT', 'PASS');
  }
} catch (e) {
  log('RESULT', 'FAIL ' + e.message);
  await h.shot('zz_fail');
}
log('console', h.logs.filter((l) => !l.includes('ERR_TUNNEL')).slice(0, 30));
writeFileSync(out + '/report.json', JSON.stringify(report, null, 1));
await h.browser.close();
