// Visual review captures (desktop + phone layouts) using the debug floor jump.
import { open } from './pw.mjs';
const out = process.argv[2];
const which = process.argv[3] || 'desktop';
const sizes = { desktop: [1280, 720, false], phoneL: [844, 390, true], phoneP: [390, 844, true] };
const [W, H, touch] = sizes[which];
const h = await open('http://localhost:8765/local.html', { outDir: out, width: W, height: H, touch });
const ready = () => h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
try {
  await ready();
  await h.page.evaluate(() => window.__p3.setMaxDt(0.5));
  await h.sleep(1000);
  await h.shot(which + '_00_title');
  if (touch) await h.page.tap('[data-act="new"]'); else await h.key('Space');
  await h.waitFor((s) => s.mode === 'world', 60000, 'world');
  await h.sleep(800); await h.shot(which + '_01_outside');
  await h.page.evaluate(() => window.__p3.jump(5));
  await h.sleep(1500);
  await h.tp(0, 3.2, 0); await h.sleep(1200); await h.shot(which + '_02_5F_aisle');
  await h.tp(-1.6, 1.5, Math.PI / 2 - 0.35); await h.sleep(1200); await h.shot(which + '_03_5F_rowA');
  await h.tp(1.6, 0.5, -Math.PI / 2 + 0.4); await h.sleep(1200); await h.shot(which + '_04_5F_rowB');
  await h.tp(0, -5.5, Math.PI); await h.sleep(1200); await h.shot(which + '_05_5F_toEV');
  await h.tp(-0.5, 5.9, Math.atan2(0.35, -0.84)); await h.sleep(800);
  await h.page.evaluate(() => window.__p3.game.openPanelFromWorld()); await h.sleep(800);
  await h.shot(which + '_06_panel');
  await h.page.evaluate(() => window.__p3.game.ui.closeAll());
  if (touch) { await h.page.evaluate(() => { const b = window.__p3.game.puzzleFor(5).bikes[0]; window.__p3.game.inspectBike(b); }); await h.sleep(900); await h.shot(which + '_07_inspect'); await h.page.evaluate(() => window.__p3.game.ui.closeAll()); await h.page.evaluate(() => window.__p3.game.openTools('receipt')); await h.sleep(900); await h.shot(which + '_08_tools'); await h.page.evaluate(() => window.__p3.game.ui.closeAll()); }
  if (which === 'desktop') {
    await h.page.evaluate(() => window.__p3.jump(3));
    await h.sleep(1500);
    await h.tp(4.5, -3.0, 0.6); await h.sleep(1200); await h.shot(which + '_07_3F_door');
    await h.page.evaluate(() => window.__p3.jump(1));
    await h.sleep(1500);
    await h.tp(0, 1.0, 0); await h.sleep(1200); await h.shot(which + '_08_1F_exit');
    await h.page.evaluate(() => { window.__p3.game.lightOn = true; });
    await h.tp(-6.0, 3.0, Math.PI / 2); await h.sleep(1000); await h.shot(which + '_09_light');
  }
} catch (e) { console.log('ERR', e.message); await h.shot(which + '_zz'); }
console.log(h.logs.filter((l) => !l.includes('ERR_TUNNEL')).join('\n'));
await h.browser.close();
