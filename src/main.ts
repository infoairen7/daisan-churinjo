// Bootstrap: load models / sounds / UI images, then hand over to the game.
import { Renderer } from './engine/renderer';
import { loadGLB, type ModelTemplate } from './engine/gltf';
import { fetchModel } from './engine/fetchmodel';
import { AudioManager } from './game/audio';
import { Game } from './game/game';
import { UI } from './game/ui_assets.gen';
import { loadImage } from './game/canvas';
import { L, setLang, detectLang } from './game/i18n';
import { loadSettings } from './game/save';

const MODELS: [string, number][] = [
  ['floor_shell', 140], ['elevator_animated', 100], ['bicycle_city_basket', 156], ['bicycle_city_plain', 135],
  ['bicycle_sport_plain', 117], ['bicycle_folding_basket', 150], ['bicycle_folding_plain', 129], ['bicycle_rack', 44],
  ['payment_terminal', 29], ['bedroom', 56], ['outdoor_exit', 16],
];

async function boot() {
  const root = document.getElementById('app')!;
  const canvas = root.querySelector<HTMLCanvasElement>('#gl')!;
  const msg = root.querySelector<HTMLElement>('#loading .msg')!;
  // the language has to be known before the signage textures are drawn
  setLang(detectLang(loadSettings().lang));
  msg.textContent = L('読み込み中…', 'Loading…');
  const bar = root.querySelector<HTMLElement>('#loading .bar i')!;
  let renderer: Renderer;
  try { renderer = new Renderer(canvas); } catch {
    msg.textContent = L('このブラウザでは3D表示（WebGL2）を利用できません。最新のChrome・Safari・Edge・Firefoxで開いてください。', 'This browser cannot show 3D (WebGL2). Please open the game in the latest Chrome, Safari, Edge or Firefox.');
    return;
  }
  const total = MODELS.reduce((a, [, kb]) => a + kb, 0) + 3300;
  let done = 0;
  const bump = (kb: number) => { done += kb; bar.style.width = `${Math.min(100, (done / total) * 100).toFixed(0)}%`; };

  const fontReady = (async () => {
    try {
      const fonts = (document as any).fonts;
      // request the glyphs the canvas-drawn signs use (the webfont is split into unicode slices)
      const glyphs = '第３駐輪場ご利用案内自転車は各階へエレベーターで運べます料金精算機お支払いください票退場まで保管夜間管理人が巡回して出入口区画時専用入力0123456789ABOK×▲▼ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz—–·¥.,:/';
      if (fonts?.load) await Promise.race([Promise.all([fonts.load('700 40px "Noto Sans JP"', glyphs), fonts.load('400 24px "Noto Sans JP"', glyphs)]), new Promise((r) => setTimeout(r, 2500))]);
    } catch { /* fallback fonts are fine */ }
  })();

  const audio = new AudioManager();
  let audioDone = 0;
  const audioP = audio.preload('assets/audio/', (f) => { const kb = f * 3300; bump(kb - audioDone); audioDone = kb; });
  const templates: Record<string, ModelTemplate> = {};
  const modelP = Promise.all(MODELS.map(async ([name, kb]) => {
    templates[name] = await loadGLB(await fetchModel(name));
    bump(kb);
  }));
  const imgNames = ['operating_rules', 'floor_1', 'floor_2', 'floor_3', 'floor_4', 'floor_5'];
  const images: Record<string, HTMLImageElement> = {};
  const imgP = Promise.all(imgNames.map(async (n) => { images[n] = await loadImage(UI[n]); }));
  try {
    await Promise.all([modelP, imgP, audioP, fontReady]);
  } catch (e) {
    msg.textContent = L(`素材を読み込めませんでした（${(e as Error).message}）。ページを再読み込みしてください。`, `Could not load the game files (${(e as Error).message}). Please reload the page.`);
    return;
  }
  msg.textContent = L('準備中…', 'Getting ready…');
  const game = new Game(root, canvas, renderer, templates, images, audio);
  try { renderer.warmup(); } catch (e) { console.warn(e); }
  renderer.prepare(game.world.scene.root);
  root.querySelector<HTMLElement>('#loading')!.hidden = true;
  game.start();
  game.showTitle();
  // the caretaker model is only needed at the game over / normal ending: fetch it quietly now
  window.setTimeout(() => { game.loadCaretaker().catch(() => { /* retried on demand */ }); }, 2500);
  // the score streams in the background; tracks start as soon as they are decoded
  window.setTimeout(() => { audio.preloadMusic('assets/music/'); }, 600);
}

const hot = (window as any).claude?.hot;
try { hot?.snapshot?.(() => ({ v: 1 })); } catch { /* optional */ }
const start = () => { boot(); };
if (hot?.ready) hot.ready(start); else start();
