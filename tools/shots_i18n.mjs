// Layout review in one language: title, notice, settings, HUD + bike card, panel, notes, rules, receipt, game over, endings.
// node tools/shots_i18n.mjs <outDir> <en|ja> [desktop|phoneL|phoneP]
import { open } from './pw.mjs';
const [out, lang = 'en', size = 'desktop'] = process.argv.slice(2);
const sizes = { desktop: [1280, 720, false], phoneL: [844, 390, true], phoneP: [390, 844, true] };
const [width, height, touch] = sizes[size];
const h = await open(`http://localhost:8765/local.html?lang=${lang}`, { outDir: out, width, height, touch, locale: lang === 'en' ? 'en-US' : 'ja-JP', notice: true });
const ev = (fn, a) => h.page.evaluate(fn, a);
const tag = (n) => `${lang}_${size}_${n}`;
const log = (k, v) => console.log(k, typeof v === 'string' ? v : JSON.stringify(v));
try {
  await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
  await ev(() => { window.__p3.setMaxDt(0.5); window.__p3.noAdapt(); });
  await h.sleep(800); await h.shot(tag('01_title'));
  // content notice
  await ev(() => document.querySelector('[data-act=new]').__act());
  await h.sleep(600); await h.shot(tag('02_notice'));
  await ev(() => window.__p3.game.ui.close('dialog'));
  await ev(() => window.__p3.game.openSettings(() => {}));
  await h.sleep(1500); await h.shot(tag('03_settings'));
  await ev(() => window.__p3.game.ui.close('settings'));
  // start a run, then jump to 4F
  await ev(() => { window.__p3.game.settings.warned = true; });
  await h.key('Space'); await h.sleep(400); await h.key('Space');
  await h.waitFor((s) => s.mode === 'world', 90000, 'world');
  await ev(() => window.__p3.jump(4));
  await h.sleep(1500);
  const p = await ev(() => window.__p3.game.puzzleFor(4).bikes.map((b) => [b.row, b.slot, b.id]));
  const [row, slot] = p[0];
  const slotZ = (s) => -5.525 + (s - 1) * 1.35;
  await h.tp(row === 'A' ? -2.6 : 1.8, slotZ(slot), row === 'A' ? Math.PI / 2 : -Math.PI / 2);
  await h.sleep(700);
  await h.key('Space'); await h.sleep(900); await h.shot(tag('04_bikecard'));
  await ev(() => window.__p3.game.openMemo()); await h.sleep(500); await h.shot(tag('05_notes'));
  await ev(() => window.__p3.game.ui.close('memo'));
  await ev(() => window.__p3.game.openPanelFromWorld()); await h.sleep(1500); log('stack', await ev(() => window.__p3.game.ui.stack.map((o) => o.name))); await h.shot(tag('06_panel'));
  await ev(() => window.__p3.game.ui.close('panel'));
  await ev(() => window.__p3.game.showRules(() => {})); await h.sleep(500); await h.shot(tag('07_rules'));
  await ev(() => window.__p3.game.ui.close('dialog'));
  await ev(() => window.__p3.game.viewReceipt()); await h.sleep(500); await h.shot(tag('08_receipt'));
  await ev(() => window.__p3.game.ui.close('dialog'));
  await ev(() => { const g = window.__p3.game; g.save.resumeFloor = 4; g.save.wrongTotal = 2; g.showGameOver(); }); await h.sleep(600); await h.shot(tag('09_gameover'));
  // share text (window.open is stubbed so nothing leaves the page)
  const shared = await ev(() => { let u = ''; window.open = (x) => { u = x; return { opener: 1 }; }; window.__p3.game.share('fail'); return decodeURIComponent(u); });
  log('share', shared);
  await ev(() => { const g = window.__p3.game; g.ui.closeAll(); g.records.normal = true; g.ui.ending('normal', g.records, { onTitle() {}, onNew() {}, onShare() {} }); }); await h.sleep(600); await h.shot(tag('10_end_normal'));
  await ev(() => { const g = window.__p3.game; g.ui.closeAll(); g.ui.fadeInstant(0); g.ui.secretCaption(true); }); await h.sleep(2200); await h.shot(tag('11_secret_caption'));
  log('RESULT', 'ok');
} catch (e) { log('RESULT', 'FAIL ' + e.message.slice(0, 300)); await h.shot(tag('zz')); }
log('console', h.logs.filter((l) => !l.includes('ERR_TUNNEL')));
await h.browser.close();
