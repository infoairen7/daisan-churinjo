// Phone-size screenshots of the v2 encounter UI (choice card, spoken line + caption over black, game over hint).
// node tools/v2_mobile_shots.mjs <outDir> [lang] [w] [h]
import { open } from './pw.mjs';
const [out, lang = 'ja', w = '844', hh = '390'] = process.argv.slice(2);
const h = await open(`http://localhost:8765/local.html?lang=${lang}`, { outDir: out, width: +w, height: +hh, touch: true });
const ev = (fn, a) => h.page.evaluate(fn, a);
await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
await ev(() => { window.__p3.setMaxDt(0.5); window.__p3.seed(310517); window.__p3.noAdapt(); });
await h.shot(`${lang}_00_title`);
await ev(() => document.querySelector('[data-act=new]').__act());
await h.waitFor((s) => s.mode === 'world' && s.phase === 'INTRO', 60000, 'intro');
await ev(() => window.__p3.game.loadCaretaker());
await ev(() => { window.__p3.freeze(true); window.__p3.setSub(0.1); });
const until = async (pred, max = 60) => { for (let t = 0; t < max; t += 0.4) { if (await ev(pred)) return true; await ev(() => window.__p3.advance(0.4)); } return false; };
const settle = async () => { await ev(() => window.__p3.freeze(false)); await h.sleep(700); await ev(() => window.__p3.freeze(true)); };
const pick = (i) => ev((i) => document.querySelectorAll('.btn.choice')[i].__act(), i);
try {
  // 8F: lights out → choice card
  await ev(() => { const g = window.__p3.game; g.enc.reset(); g.save.cleared = {}; window.__p3.jump(8); });
  await ev(() => { const g = window.__p3.game; g.pos = [0.2, 1.65, 0.6]; g.yaw = 0; g.enc.lightsOut(); });
  await until(() => !!document.querySelector('.ov-choice'), 20);
  await ev(() => window.__p3.game.enc.choiceScale = 50);
  await settle(); await h.shot(`${lang}_01_choice8`);
  await pick(1);
  // eyes closed: the spoken line and the sound caption on black
  await until(() => (document.querySelector('#caption')?.textContent || '').length > 0 && !document.querySelector('#caption').hidden, 10);
  await settle(); await h.shot(`${lang}_02_eyes_closed`);
  await until(() => !!document.querySelector('.ov-choice'), 20);
  await settle(); await h.shot(`${lang}_03_voice_choice`);
  await pick(0); // open them
  await until(() => !!document.querySelector('.ov-gameover'), 20);
  await settle(); await h.shot(`${lang}_04_gameover_hint`);
} catch (e) { console.log('FAIL', e.message); await h.shot(`${lang}_zz_fail`); }
console.log('console', h.logs.filter((l) => !l.includes('ERR_TUNNEL')).slice(0, 10));
await h.browser.close();
