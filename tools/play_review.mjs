// Review session: play floors with real key input and capture the atmosphere beats.
import { open } from './pw.mjs';
const out = process.argv[2];
const part = process.argv[3] || 'floors';
const h = await open('http://localhost:8765/local.html', { outDir: out, width: 1280, height: 720 });
const log = (k, v) => console.log(k, typeof v === 'string' ? v : JSON.stringify(v));
const ev = (fn, arg) => h.page.evaluate(fn, arg);
try {
  await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
  await ev(() => { window.__p3.setMaxDt(0.5); window.__p3.noAdapt(); });
  await h.key('Space');
  await h.waitFor((s) => s.mode === 'world', 60000, 'intro');
  // wait for the caretaker model (needed for 2F / reveal)
  await h.page.waitForFunction(() => !!window.__p3.game.caretakerTpl, null, { timeout: 120000 }).catch(() => log('warn', 'caretaker not loaded'));
  if (part === 'floors') {
    for (const f of [5, 4, 3]) {
      await ev((f) => window.__p3.jump(f), f);
      await h.sleep(1500);
      await h.tp(0, 3.0, 0); await h.sleep(1500); await h.shot(`f${f}_a_aisle`);
      await h.tp(-1.4, -2.0, Math.PI / 2 - 0.3); await h.sleep(1500); await h.shot(`f${f}_b_rowA`);
      if (f === 3) {
        await h.face(1.2, -0.5, 6.6, -6.86); await h.sleep(1500); await h.shot('f3_c_door_before');
        await h.face(4.8, -2.6, 6.6, -6.86); await h.sleep(6000); await h.shot('f3_d_door_after');
      }
      log('floor', await h.st());
    }
    // 2F: stand facing south long enough, then turn around
    await ev(() => window.__p3.jump(2));
    await h.sleep(1500);
    await h.tp(0, 3.4, Math.PI); await h.sleep(800); await h.shot('f2_a_south');
    await h.waitFor(() => true, 1000);
    await h.page.waitForFunction(() => window.__p3.game.time > 0 && window.__p3.fx().silState === 'shown', null, { timeout: 60000 }).catch(() => log('warn', 'silhouette not shown'));
    await ev(() => window.__p3.setMaxDt(0.04));
    await h.tp(0, 3.4, 0.02); await h.shot('f2_b_turn');
    await h.sleep(500); await h.shot('f2_c_turn2');
    log('sil', await ev(() => window.__p3.fx().silState));
  }
  if (part === 'sil') {
    await ev(() => window.__p3.jump(2));
    await h.sleep(1500);
    await h.tp(0, 3.4, Math.PI);
    await h.page.waitForFunction(() => window.__p3.fx().silState === 'shown', null, { timeout: 90000 });
    await ev(() => window.__p3.freeze(true));
    const adv = (t) => h.page.evaluate((t) => window.__p3.advance(t), t);
    await h.tp(0, 3.4, 0.02); await adv(0.05); await h.shot('sil_1');
    for (let i = 0; i < 80 && !(await ev(() => window.__p3.fx().sil?.lunging)); i++) await adv(0.05);
    log('silState', await ev(() => window.__p3.fx().silState));
    for (const [i, t] of [[2, 0.2], [3, 0.15], [4, 0.1], [5, 0.08], [6, 0.06], [7, 0.06], [8, 0.1], [9, 0.1]]) { await adv(t); await h.shot('sil_' + i); }
    await ev(() => window.__p3.freeze(false));
  }
  if (part === 'stall') {
    await ev(() => window.__p3.jump(3));
    await h.sleep(1500);
    await ev(() => { const g = window.__p3.game; g.openPanelFromWorld(); });
    const a = await ev(() => window.__p3.answer());
    for (const d of a) await h.key('Digit' + d, 40);
    await h.page.click('[data-open]');
    await h.page.waitForFunction(() => window.__p3.game.world.blackout > 0.8, null, { timeout: 60000 });
    await h.sleep(800); await h.shot('s_stall');
    await h.waitFor((s) => s.floor === 2 && s.doors === 'open', 60000, '2F');
    await h.sleep(600); await h.shot('s_2F_arrive');
  }
  if (part === 'reveal') {
    await ev(() => window.__p3.jump(4));
    await h.sleep(1500);
    await ev(() => window.__p3.game.openPanelFromWorld());
    const a = await ev(() => window.__p3.answer());
    const w = a.map((d) => (d === 5 ? 4 : d + 1));
    for (let k = 0; k < 2; k++) { for (const d of w) await h.key('Digit' + d, 40); await h.page.click('[data-open]'); await h.sleep(500); if (k === 0) { await h.shot('r_warning'); await h.page.click('[data-clear]'); } }
    await h.waitFor((s) => s.doors === 'opening' && s.floor === 5, 60000, 'reveal doors');
    await ev(() => window.__p3.freeze(true));
    await h.shot('r_1_doors');
    const adv = (t) => h.page.evaluate((t) => window.__p3.advance(t), t);
    await adv(1.9); await h.shot('r_2_open');
    await adv(1.2); await h.shot('r_3_change');
    // step until the pounce starts
    for (let i = 0; i < 60 && !(await ev(() => window.__p3.game.caretaker.lunging)); i++) await adv(0.05);
    await h.shot('r_4_lunge0');
    for (const [i, t] of [[1, 0.1], [2, 0.1], [3, 0.08], [4, 0.06]]) { await adv(t); await h.shot('r_5_lunge' + i); }
    await adv(0.3); await h.shot('r_6_cut');
    await ev(() => window.__p3.freeze(false));
    await h.waitFor((s) => s.ui.includes('gameover'), 60000, 'gameover');
    await h.shot('r_7_go');
  }
  if (part === 'bed') {
    await ev(() => { window.__p3.jump(2); window.__p3.game.save.wrongTotal = 1; });
    await h.sleep(1500);
    await ev(() => window.__p3.game.openPanelFromWorld());
    const a = await ev(() => window.__p3.answer());
    for (const d of a) await h.key('Digit' + d, 40);
    await h.page.click('[data-open]');
    await h.waitFor((s) => s.floor === 1 && s.doors === 'open' && s.mode === 'world', 90000, '1F');
    await h.shot('b_1F');
    await h.tp(0, 5.4, -Math.PI / 2); await h.waitFor((s) => s.target === 'rail', 20000);
    await h.key('Space'); await h.waitFor((s) => s.ui.includes('dialog'), 8000); await h.key('Space');
    await h.waitFor((s) => s.bike === 'held', 8000);
    await h.tp(0, -5.0, 0); await h.shot('b_exit_view');
    await h.page.keyboard.down('KeyW');
    await h.waitFor((s) => s.view === 'bedroom', 90000, 'bedroom'); await h.page.keyboard.up('KeyW');
    await h.sleep(4000); await h.shot('b_2_ceiling');
    await ev(() => window.__p3.setMaxDt(0.1));
    await h.page.keyboard.down('KeyD');
    await h.page.waitForFunction(() => { if (window.__p3.game.bedZoom > 0) { window.__p3.freeze(true); return true; } return false; }, null, { timeout: 120000, polling: 'raf' });
    await h.page.keyboard.up('KeyD');
    await h.shot('b_3_eyes');
    await ev(() => window.__p3.freeze(true));
    const adv = (t) => h.page.evaluate((t) => window.__p3.advance(t), t);
    await adv(1.8); await h.shot('b_4_change');
    for (let i = 0; i < 60 && !(await ev(() => window.__p3.game.caretakerBed.lunging)); i++) await adv(0.05);
    await h.shot('b_5_lunge0');
    for (const [i, t] of [[1, 0.1], [2, 0.1], [3, 0.08], [4, 0.06]]) { await adv(t); await h.shot('b_6_lunge' + i); }
    await ev(() => window.__p3.freeze(false));
    await h.waitFor((s) => s.ui.includes('ending'), 60000, 'ending'); await h.shot('b_7_end');
  }
  log('RESULT', 'ok');
} catch (e) { log('RESULT', 'FAIL ' + e.message.slice(0, 300)); await h.shot('zz'); }
log('console', h.logs.filter((l) => !l.includes('ERR_TUNNEL')));
await h.browser.close();
