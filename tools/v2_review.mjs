// Watch the v2 scenes as a player would: frame-stepped game time, canvas frames saved as JPEGs (contact sheets are
// made afterwards), plus a full-page screenshot whenever an overlay opens. Needs the debug build on :8765.
// node tools/v2_review.mjs <outDir> <scene,...> [fps] [lang] [w] [h] [touch]
//   scenes: s8ok s8light s8run s5ok s5answer s5press s3ok s3wrong s7 s4
import { open } from './pw.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const [out, sceneArg, fpsArg, langArg, wArg, hArg, touchArg] = process.argv.slice(2);
const FPS = +(fpsArg || 4);
const lang = langArg || 'ja';
const h = await open(`http://localhost:8765/local.html?lang=${lang}`, { outDir: out, width: +(wArg || 960), height: +(hArg || 540), touch: touchArg === 'touch' });
const ev = (fn, a) => h.page.evaluate(fn, a);
const st = () => h.st();
await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
await ev((f) => { window.__p3.setMaxDt(0.5); window.__p3.seed(310517); window.__p3.noAdapt(); window.__p3.setSub(1 / f); }, FPS);
await h.key('Space');
await h.waitFor((s) => s.mode === 'world' && s.phase === 'INTRO', 40000, 'intro');
await ev(() => window.__p3.game.loadCaretaker());
await ev(() => window.__p3.freeze(true));
const jump = (f) => ev((f) => { const g = window.__p3.game; g.enc.reset(); g.save.cleared = {}; for (const x of [8, 5, 3]) if (x > f) g.save.cleared[String(x)] = true; window.__p3.jump(f); }, f);
const log = [];

/** step game time, saving frames, until done(state) or maxSec. act(state, t) may drive the player / pick choices. */
async function run(name, maxSec, act, done) {
  const dir = `${out}/${name}`; mkdirSync(dir, { recursive: true });
  let lastUi = '';
  for (let i = 0; i < maxSec * FPS; i++) {
    const url = await ev((dt) => window.__p3.step(dt), 1 / FPS);
    writeFileSync(`${dir}/${String(i).padStart(4, '0')}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
    const s = await st();
    // what the HTML layer says (text only; full-page screenshots take minutes under SwiftShader)
    const uiText = await ev(() => ['#say', '#caption', '#toast', '.ov-choice', '#bigline', '.ov-gameover'].map((q) => { const e = document.querySelector(q); return e && !e.hidden && e.offsetParent !== null && (q !== '#say' || e.classList.contains('is-in')) ? q + ': ' + e.textContent.trim().replace(/\s+/g, ' ') : ''; }).filter(Boolean).join(' || '));
    if (uiText !== lastUi) { lastUi = uiText; if (uiText) log.push([name, (i / FPS).toFixed(2), uiText]); }
    if (s.ui.includes('choice') && !shotChoice.has(name) && process.env.SHOT_CHOICE) { shotChoice.add(name); await h.page.screenshot({ path: `${dir}/ui_choice.png`, timeout: 300000 }); }
    if (act) await act(s, i / FPS);
    if (done && done(s, i / FPS)) { log.push([name, 'done', i / FPS, s.phase, s.floor, s.ui]); return s; }
  }
  const s = await st(); log.push([name, 'max', maxSec, s.phase, s.floor, s.ui]); return s;
}
const shotChoice = new Set();
let picked = false;
const pick = (label) => async (s) => {
  if (picked || !s.ui.includes('choice')) return;
  const idx = await ev((t) => [...document.querySelectorAll('.btn.choice')].findIndex((b) => b.textContent.includes(t)), label);
  if (idx >= 0) { picked = true; await ev((i) => document.querySelectorAll('.btn.choice')[i].__act?.(), idx); }
};
const after = (sec, f) => async (s, t) => { if (t >= sec) await f(s, t); };
const walkOut = async (s, t) => { if (s.floor === 8 && t > 1.0 && t < 3.2 && s.mode === 'world') await ev(() => { const g = window.__p3.game; g.pos = [g.pos[0] * 0.9 + 0.02, g.pos[1], g.pos[2] - 0.55]; g.yaw = 0; }); };
const isOver = (s) => s.ui.includes('gameover');
const scenes = sceneArg.split(',');
const L = (ja, en) => (lang === 'en' ? en : ja);
try {
  for (const sc of scenes) {
    picked = false;
    if (sc.startsWith('s8')) {
      await jump(8);
      const label = sc === 's8ok' ? L('目を閉じる', 'close your eyes') : sc === 's8light' ? L('ライト', 'light') : L('走る', 'Run');
      let seen = -1;
      await run(sc, sc === 's8ok' ? 46 : 34, async (s, t) => { await walkOut(s, t); if (s.ui.includes('choice')) { if (seen < 0) seen = t; if (t - seen > 2.5) await pick(label)(s); } },
        (s, t) => isOver(s) || (sc === 's8ok' && s.cleared?.['8'] && t > 30));
    }
    if (sc.startsWith('s5')) {
      await jump(6);
      await ev(() => { const g = window.__p3.game; g.pos = [-0.5, 1.65, 5.9]; g.yaw = Math.PI; });
      await ev(() => { const g = window.__p3.game; g.openPanelFromWorld(); for (const d of window.__p3.answer()) g.panelDigit(d); g.panelOpen(); });
      const label = sc === 's5ok' ? L('うつむいて', 'Look down') : sc === 's5answer' ? L('答える', 'Answer') : L('押す', 'Press');
      let seen = -1;
      await run(sc, 70, async (s, t) => { if (s.ui.includes('choice')) { if (seen < 0) seen = t; if (t - seen > 4) await pick(label)(s); } }, (s) => isOver(s) || (s.floor === 4 && s.mode === 'world'));
    }
    if (sc.startsWith('s3')) {
      await jump(4);
      await ev(() => { const g = window.__p3.game; g.pos = [-0.5, 1.65, 5.9]; g.yaw = Math.PI; });
      await ev(() => { const g = window.__p3.game; g.openPanelFromWorld(); for (const d of window.__p3.answer()) g.panelDigit(d); g.panelOpen(); });
      let seen = -1;
      await run(sc, 80, async (s, t) => {
        if (s.ui.includes('choice')) {
          if (seen < 0) seen = t;
          if (t - seen > 3) {
            const said = await ev(() => document.querySelector('.ov-choice')?.textContent || '');
            const wrongNo = !said.includes('1017');
            const correct = sc === 's3ok';
            const yes = L('はい', 'Yes'); const no = L('いいえ', 'No');
            await pick(correct ? (wrongNo ? no : yes) : (wrongNo ? yes : no))(s);
          }
        }
      }, (s) => isOver(s) || (s.floor === 2 && s.mode === 'world'));
    }
    if (sc === 's7') {
      await jump(7);
      // look out of the car, walk towards the bike, glance away, look back
      await run(sc, 22, async (s, t) => {
        await ev((t) => {
          const g = window.__p3.game;
          if (t < 6) { g.pos = [-0.3, 1.65, 4.0 - t * 0.5]; g.yaw = 0.05; }
          else if (t < 9) { g.yaw = 0.05 + (t - 6) / 3 * 2.4; }
          else if (t < 12) { g.yaw = 2.45 - (t - 9) / 3 * 2.4; }
          else { g.pos = [0.1, 1.65, Math.max(-2.5, 1.0 - (t - 12) * 0.5)]; g.yaw = 0; }
        }, t);
      }, null);
    }
    if (sc === 's4') {
      await jump(4);
      await ev(() => { const g = window.__p3.game; g.pos = [-0.5, 1.65, 5.9]; g.yaw = Math.PI; });
      await ev(() => { const g = window.__p3.game; g.openPanelFromWorld(); for (const d of window.__p3.answer()) g.panelDigit(d); g.panelOpen(); });
      await run(sc, 22, null, (s) => s.floor === 3);
    }
    if (isOver(await st())) await ev(() => document.querySelector('[data-act="retry"]')?.click());
    await ev(() => window.__p3.step(0.5));
  }
} catch (e) { console.log('FAIL', e.message); log.push(['FAIL', e.message]); }
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
console.log(JSON.stringify(log));
console.log('console', h.logs.filter((l) => !l.includes('ERR_TUNNEL')).slice(0, 12));
await h.browser.close();
