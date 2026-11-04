// Close-up screenshots of v2 moments with the game clock frozen (screenshots are slow under SwiftShader).
// node tools/v2_visuals.mjs <outDir> [what,...]   what: dup | walk | hands | panel
import { open } from './pw.mjs';
const [out, whatArg] = process.argv.slice(2);
const what = (whatArg || 'dup,walk,hands,panel').split(',');
const h = await open('http://localhost:8765/local.html?lang=ja', { outDir: out });
const ev = (fn, a) => h.page.evaluate(fn, a);
const freeze = (on) => ev((on) => window.__p3.freeze(on), on);
const advance = (s) => ev((s) => window.__p3.advance(s), s);
const snap = async (name) => { await freeze(true); await h.shot(name); };
const jump = (f) => ev((f) => { const g = window.__p3.game; g.enc.reset(); g.save.cleared = {}; for (const x of [8, 5, 3]) if (x > f) g.save.cleared[String(x)] = true; window.__p3.jump(f); }, f);
await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
await ev(() => { window.__p3.setMaxDt(0.5); window.__p3.seed(310517); window.__p3.game.enc.choiceScale = 20; });
await h.key('Space');
await h.waitFor((s) => s.mode === 'world' && s.phase === 'INTRO', 40000, 'intro');
await ev(() => window.__p3.game.loadCaretaker());
try {
  if (what.includes('dup')) {
    await jump(7); await h.sleep(1500);
    console.log('dup', await ev(() => { const w = window.__p3.game.world; return { vis: w.dupBike.root.visible, pos: w.dupBike.root.position, scrawl: w.scrawlNode.visible }; }));
    await freeze(true); await advance(1.2); await h.shot('dup_1_from_car');
    await ev(() => window.__p3.tp(0, 0.5, 0)); await advance(0.6); await h.shot('dup_2_mid');
    console.log('dup after', await ev(() => { const w = window.__p3.game.world; return { vis: w.dupBike.root.visible, scrawl: w.scrawlNode.visible }; }));
    await ev(() => window.__p3.tp(0, 0.5, Math.PI)); await advance(3.5);
    await ev(() => window.__p3.tp(0, -2.0, 0)); await advance(0.8); await h.shot('dup_3_scrawl');
    console.log('dup gone', await ev(() => { const w = window.__p3.game.world; return { vis: w.dupBike.root.visible, scrawl: w.scrawlNode.visible }; }));
    await freeze(false);
  }
  if (what.includes('walk')) {
    await jump(5);
    await h.page.waitForFunction(() => window.__p3.game.caretaker?.walking, null, { timeout: 60000 });
    await freeze(true);
    for (let i = 0; i < 4; i++) { await advance(0.5); await h.shot('walk_' + i); }
    await freeze(false);
    await h.waitFor((s) => s.choice, 60000, 'choice');
    await freeze(true); await advance(3.5); await h.shot('walk_head_turned');
    await freeze(false);
  }
  if (what.includes('hands')) {
    await jump(4); await h.sleep(800);
    await ev(() => { const g = window.__p3.game; g.pos = [-0.5, 1.65, 5.9]; });
    await ev(async () => { const g = window.__p3.game; g.openPanelFromWorld(); for (const d of window.__p3.answer()) g.panelDigit(d); g.panelOpen(); });
    await h.page.waitForFunction(() => window.__p3.game.world.handprints.every((n) => n.visible), null, { timeout: 60000 });
    await freeze(true); await advance(0.4); await h.shot('hands_doors');
    await freeze(false);
  }
  if (what.includes('floors')) {
    for (const f of [10, 6, 2]) { await jump(f); await h.sleep(1200); await freeze(true); await ev(() => window.__p3.tp(0.2, 2.5, 0)); await advance(1.0); await h.shot('floor_' + f); await freeze(false); }
  }
  if (what.includes('panel')) {
    await ev(() => { const g = window.__p3.game; g.save.flags.authenticated = false; g.save.phase = 'INTRO'; g.setFloor(1); g.world.setPanelPower('normal'); window.__p3.tp(-0.5, 5.9, Math.PI * 0.9); g.openPanelFromWorld(); });
    await h.sleep(800); await h.shot('panel_normal_10');
  }
} catch (e) { console.log('FAIL', e.message); await h.shot('zz_fail'); }
console.log('console', h.logs.slice(0, 10));
await h.browser.close();
