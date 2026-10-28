// PV footage: frame-stepped capture from the debug build (node tools/build.mjs --debug; serve dist on :8765).
// node tools/trailer_capture.mjs <outDir> <shot,shot,...>   → <outDir>/<shot>/0000.jpg … (1920x1080, 30 fps of game time)
import { open } from './pw.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = process.argv[2];
const shots = (process.argv[3] || 'exterior').split(',');
const FPS = 30, W = 1920, H = 1080, EYE = 1.65, EVZ = 5.3;
const h = await open('http://localhost:8765/local.html?lang=ja', { outDir: out, width: W, height: H });
const ev = (fn, a) => h.page.evaluate(fn, a);
h.page.on('pageerror', (e) => console.log('PAGEERROR', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')));
h.page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_TUNNEL')) console.log('CONSOLE', m.text()); });
const adv = (t) => h.page.evaluate((t) => window.__p3.advance(t), t);
const cam = (pos, yaw, pitch = 0, fov = 0) => ev(([p, y, pi, f]) => window.__p3.cam(p, y, pi, f), [pos, yaw, pitch, fov]);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const yawTo = (from, to) => Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
const pitchTo = (from, to) => Math.atan2(to[1] - from[1], Math.hypot(to[0] - from[0], to[2] - from[2]));
const clean = (hud = false) => ev((hud) => {
  const g = window.__p3.game; g.ui.showHud(hud); g.ui.fadeInstant(0); g.ui.bigLine(null);
  for (const id of ['#toast', '#caption', '#chapter']) { const e = document.querySelector(id); if (e) e.hidden = true; }
  const f = document.querySelector('#flash'); if (f) f.style.display = 'none';
  document.querySelector('#app').classList.remove('jolt');
}, hud);
// Frames come straight from the WebGL canvas (fast). The HTML layer (HUD, cards, panel) is snapshotted separately as a
// transparent PNG whenever it changes, and the editor lays it over the frames listed in <shot>/meta.json.
let curUi = null;
async function snapUi(name) {
  await h.sleep(900); // let CSS transitions settle
  await ev(() => { document.querySelector('#gl').style.visibility = 'hidden'; for (const e of [document.documentElement, document.body, document.querySelector('#app')]) e.style.background = 'transparent'; });
  const file = `${out}/ui_${name}.png`;
  await h.page.screenshot({ path: file, omitBackground: true, timeout: 180000 });
  await ev(() => { document.querySelector('#gl').style.visibility = ''; for (const e of [document.documentElement, document.body, document.querySelector('#app')]) e.style.background = ''; });
  curUi = `ui_${name}.png`;
}
async function film(name, n, perFrame, uiMap = null) {
  const dir = `${out}/${name}`; mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const meta = [];
  curUi = null;
  for (let i = 0; i < n; i++) {
    const plan = (perFrame && (await perFrame(i, i / FPS))) || {};
    const once = () => ev(async ([dt, plan]) => {
      const g = window.__p3.game;
      if (plan.cam) window.__p3.cam(...plan.cam);
      if (plan.player) { g.pos = plan.player[0]; g.yaw = plan.player[1]; g.lookPitch = plan.player[2] ?? 0; }
      const url = await window.__p3.step(dt);
      return { url, m: { fade: Number(document.querySelector('#fade').style.opacity || 0), lunge: !!(g.caretaker?.lunging || g.caretakerBed?.lunging || g.fx.sil?.lunging), sil: g.fx.silState, warn: !!g.save?.warningArmed } };
    }, [1 / FPS, plan]);
    let r = null;
    for (let tries = 0; !r && tries < 3; tries++) {
      r = await Promise.race([once(), new Promise((res) => setTimeout(() => res(null), 60000))]);
      if (!r) { console.log(name, 'frame', i, 'step timed out, retrying'); await ev(() => { window.__p3.game.dbgGrab = null; window.__p3.game.dbgBudget = 0; }); }
    }
    if (!r) throw new Error(`${name}: frame ${i} never rendered`);
    writeFileSync(`${dir}/${String(i).padStart(4, '0')}.jpg`, Buffer.from(r.url.split(',')[1], 'base64'));
    r.m.ui = curUi; meta.push(r.m);
  }
  if (uiMap) for (let i = 0; i < meta.length; i++) meta[i].ui = uiMap(i);
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta));
  console.log(name, n, 'frames', ((Date.now() - t0) / 1000).toFixed(0) + 's');
}

await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 180000 });
await ev(() => { const g = window.__p3.game; g.settings.quality = 'high'; g.settings.caretakerHi = true; g.settings.subtitles = false; g.applySettings(); g.ui.subtitles = false; window.__p3.noAdapt(); window.__p3.setMaxDt(0.5); });
await ev(() => window.__p3.seed(310517));
await h.key('Space');
await h.waitFor((s) => s.mode === 'world', 120000, 'world');
await h.page.waitForFunction(() => !!window.__p3.game.caretakerTpl, null, { timeout: 180000 });
await ev(() => window.__p3.freeze(true));

for (const shot of shots) {
  await ev(() => { const g = window.__p3.game; window.__p3.cam(null); g.lightOn = false; g.fx.shake = 0; });
  if (shot === 'exterior') {
    // the walk up to the building at night, slow push toward the lit sign
    await ev(() => { const g = window.__p3.game; g.world.setFloor(1, null); g.world.setLighting('normal'); g.world.setDoorsInstant(false); });
    await clean(); await adv(0.2);
    await film('exterior', 135, async (i) => { const k = ease(i / 134); return { cam: [[lerp(-0.3, 0.1, k), 1.55, lerp(-17.2, -12.4, k)], Math.PI - lerp(0.05, 0, k), lerp(0.09, 0.05, k), 52] }; });
  }
  if (shot === 'ride') {
    // inside the car at 1F, doors close, the indicator climbs
    await ev(() => { const g = window.__p3.game; g.world.setFloor(1, null); g.world.setLighting('normal'); g.world.setDoorsInstant(true); g.pos = [0.2, 1.65, 6.3]; g.yaw = 0; });
    await clean(); await adv(0.2);
    await ev(() => { window.__p3.game.rideUp(); });
    await film('ride', 165, async (i) => { const k = i / 164; return { cam: [[0.15, 1.6, lerp(6.45, 6.1, k)], 0.02, 0.06, 58] }; });
  }
  if (shot === 'blackout') {
    // 5F, inside the car facing the panel; power dies, emergency light comes on
    await ev(() => { const g = window.__p3.game; window.__p3.jump(5); g.world.setDoorsInstant(false); g.world.placeBikeDocked(); g.world.setLighting('normal'); g.world.setPanelPower('normal'); g.world.setPanelDisplay('5'); });
    await clean(); await adv(0.3);
    const from = [0.35, 1.55, 4.55], at = [-0.5, 1.15, 6.74];
    await film('blackout', 120, async (i) => {
      const k = i / 119;
      if (i === 24) await ev(() => { const g = window.__p3.game; g.world.setLighting('off'); g.world.setPanelPower('off'); });
      if (i === 33) await ev(() => { const g = window.__p3.game; g.save.phase = 'LOCKED'; g.save.flags.authenticated = false; g.world.setLighting('emergency'); g.fx.applyMood(); });
      const p = [lerp(from[0], 0.25, k), from[1], lerp(from[2], 4.85, k)];
      return { cam: [p, yawTo(p, at), pitchTo(p, at) * 0.6, 56] };
    });
  }
  if (shot === 'panel_on') {
    // the check panel wakes up amber in the dark car
    await ev(() => { const g = window.__p3.game; g.save.phase = 'LOCKED'; g.save.flags.authenticated = false; g.world.setLighting('emergency'); g.world.setPanelPower('off'); g.world.setDoorsInstant(false); g.fx.applyMood(); });
    await clean(); await adv(0.2);
    const at = [-0.85, 1.2, 6.74];
    await film('panel_on', 90, async (i) => {
      const k = ease(i / 89);
      if (i === 18) await ev(() => { const g = window.__p3.game; g.world.setPanelPower('auth'); g.world.setPanelDisplay('入力', '', '#E9B96E'); g.save.flags.authenticated = true; g.save.phase = 'EXPLORE'; g.world.setLighting('night'); g.fx.applyMood(); });
      const p = [lerp(0.1, -0.35, k), 1.5, lerp(5.2, 5.75, k)];
      return { cam: [p, yawTo(p, at), pitchTo(p, at) * 0.7, 50] };
    });
  }
  if (shot === 'inspect') {
    // gameplay: walking the rows on 4F, the inspection card pops up
    await ev(() => { window.__p3.jump(4); });
    await adv(0.5);
    const bikes = await ev(() => window.__p3.game.puzzleFor(4).bikes.filter((b) => b.row === 'A').map((b) => [b.slot, b.id]));
    const slot = bikes.length ? bikes[Math.min(1, bikes.length - 1)][0] : 3;
    const z = -5.525 + (slot - 1) * 1.35;
    await clean(true);
    await film('inspect', 105, async (i) => {
      const k = i / 104;
      const plan = { player: [[lerp(-2.2, -2.75, k), 1.65, z + lerp(1.4, 0.05, ease(Math.min(1, k * 1.6)))], Math.PI / 2 - lerp(0.25, 0, Math.min(1, k * 1.6)), -0.12] };
      return plan;
    }, (i) => (i < 30 ? null : i < 52 ? 'ui_inspect_prompt.png' : 'ui_inspect_card.png'));
    // UI layers, taken after the frames so no screenshot interrupts the stepping
    await ev(() => window.__p3.step(1 / 30));
    await clean(true); await snapUi('inspect_prompt');
    await ev((slot) => { const g = window.__p3.game; const b = g.puzzleFor(4).bikes.find((b) => b.row === 'A' && b.slot === slot); if (b) g.inspectBike(b); }, slot);
    await clean(true); await snapUi('inspect_card');
  }
  if (shot === 'wrong') {
    // the check panel: enter a count, OPEN → buzzer, red warning
    await ev(() => { const g = window.__p3.game; window.__p3.jump(4); g.pos = [0.2, 1.65, 6.0]; g.yaw = Math.PI; });
    await adv(0.5); await clean(true);
    const ans = await ev(() => window.__p3.answer());
    const wrong = ans.map((d) => (d === 5 ? 4 : d + 1));
    await ev(() => window.__p3.game.openPanelFromWorld());
    const openAt = 14 + wrong.length * 12 + 10;
    await film('wrong', 120, async (i) => {
      for (let j = 0; j < wrong.length; j++) if (i === 14 + j * 12) await ev((d) => window.__p3.game.panelDigit(d), wrong[j]);
      if (i === openAt) await ev(() => { window.__p3.game.panelOpen(); });
    }, (i) => { if (i >= openAt) return 'ui_panel_warn.png'; let k = 0; for (let j = 0; j < wrong.length; j++) if (i >= 14 + j * 12) k = j + 1; return `ui_panel_${k}.png`; });
    // rebuild each panel state for its UI layer
    await ev(() => { const g = window.__p3.game; g.ui.closeAll(); g.save.warningArmed = false; g.fx.setWarning(false); g.ui.setWarning(false); g.openPanelFromWorld(); });
    await ev(() => window.__p3.step(1 / 30)); await clean(true); await snapUi('panel_0');
    for (let j = 0; j < wrong.length; j++) { await ev((d) => window.__p3.game.panelDigit(d), wrong[j]); await ev(() => window.__p3.step(1 / 30)); await clean(true); await snapUi('panel_' + (j + 1)); }
    await ev(() => { window.__p3.game.panelOpen(); });
    for (let k = 0; k < 6; k++) await ev(() => window.__p3.step(1 / 30));
    await clean(true); await snapUi('panel_warn');
    await ev(() => { const g = window.__p3.game; g.ui.closeAll(); g.save.warningArmed = false; g.fx.setWarning(false); g.ui.setWarning(false); });
  }
  if (shot === 'figure') {
    // 2F: something stands at the end of the aisle; it runs at you
    await ev(() => { const g = window.__p3.game; window.__p3.jump(2); g.pos = [0.0, 1.65, 3.4]; g.yaw = Math.PI; g.lightOn = true; });
    await clean();
    for (let k = 0; k < 30 && !(await ev(() => window.__p3.fx().silState === 'shown')); k++) await adv(1);
    console.log('figure state', await ev(() => window.__p3.fx().silState));
    await film('figure', 150, async (i) => {
      const k = ease(Math.min(1, i / 34));
      return { player: [[0.0, 1.65, 3.4], Math.PI + lerp(0, -Math.PI + 0.03, k), 0.0001] };
    });
  }
  if (shot === 'door3f') {
    await ev(() => { const g = window.__p3.game; window.__p3.jump(3); g.lightOn = true; });
    await clean(); await adv(0.3);
    const at = [6.6, 1.0, -6.86];
    await film('door3f', 40, async (i) => { const k = i / 39; const p = [lerp(4.6, 5.3, k), 1.5, lerp(-2.6, -3.6, k)]; return { player: [p, yawTo(p, at), -0.06] }; });
  }
  if (shot === 'wheel') {
    await ev(() => { const g = window.__p3.game; window.__p3.jump(4); g.world.setDoorsInstant(false); g.world.placeBikeDocked(); g.fx.wheelSpin = 3.2; });
    await clean(); await adv(0.1);
    const at = [0.8, 0.35, 4.7];
    await film('wheel', 40, async (i) => { const k = i / 39; const p = [lerp(-0.4, -0.3, k), 1.35, lerp(5.9, 5.8, k)]; return { cam: [p, yawTo(p, at), pitchTo(p, at), 48] }; });
  }
  if (shot === 'reveal') {
    // failure: the car returns to 5F, the doors open on the caretaker; he changes, then leaps at the lens
    await ev(() => { const g = window.__p3.game; window.__p3.cam(null); window.__p3.jump(4); g.save.warningArmed = false; });
    await ev(() => window.__p3.freeze(false));
    await ev(() => window.__p3.game.openPanelFromWorld());
    const ans = await ev(() => window.__p3.answer());
    const wrong = ans.map((d) => (d === 5 ? 4 : d + 1));
    for (let k = 0; k < 2; k++) { for (const d of wrong) await ev((d) => window.__p3.game.panelDigit(d), d); await ev(() => { window.__p3.game.panelOpen(); }); await h.sleep(2500); if (k === 0) { await ev(() => { window.__p3.game.panelReinspect(); }); await h.sleep(2500); await ev(() => { window.__p3.game.openPanelFromWorld(); }); } }
    await h.waitFor((s) => s.floor === 5 && (s.doors === 'opening' || s.doors === 'closed') && s.mode === 'cutscene', 90000, 'back to 5F');
    await h.page.waitForFunction(() => window.__p3.game.world.doorState === 'opening', null, { timeout: 90000, polling: 'raf' });
    await ev(() => window.__p3.freeze(true));
    await clean();
    await film('reveal', 175);
  }
  if (shot === 'bedroom') {
    await ev(() => { const g = window.__p3.game; window.__p3.cam(null); g.ui.closeAll(); });
    await ev(() => { window.__p3.freeze(false); window.__p3.game.enterBedroom(); });
    await h.page.waitForFunction(() => window.__p3.game.view === 'bedroom' && window.__p3.game.caretakerBed, null, { timeout: 120000 });
    await h.sleep(500);
    await ev(() => { window.__p3.freeze(true); window.__p3.setBedT(1); const g = window.__p3.game; g.bedroom.t = 1; g.bedDone = true; g.bedZoom = 1; });
    await clean();
    await film('bedroom', 90);
  }
}
writeFileSync(`${out}/done_${shots.join('_')}.txt`, 'ok');
await h.browser.close();
console.log('done');
