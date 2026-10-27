// Canvas-drawn textures: plates, signs, floor indicators, night sky.
import { Texture } from '../engine/scene';

export const FONT = '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Meiryo", system-ui, sans-serif';

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

export function texFromCanvas(c: HTMLCanvasElement, opts: { clamp?: boolean; mipmaps?: boolean } = {}): Texture {
  const t = new Texture(c);
  t.clamp = opts.clamp ?? true;
  t.mipmaps = opts.mipmaps ?? true;
  return t;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function idPlate(text: string): HTMLCanvasElement {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#1d1d21'; g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#77716A'; g.lineWidth = 6; g.strokeRect(5, 5, 246, 118);
  g.fillStyle = '#F0EBDD'; g.font = `700 76px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 70);
  return c;
}

const SHAPE_COLORS: Record<string, string> = { red: '#B65B51', blue: '#6B94B5', cream: '#D8CBAC' };
export function colorTag(color: 'red' | 'blue' | 'cream'): HTMLCanvasElement {
  const [c, g] = canvas(128, 128);
  g.fillStyle = SHAPE_COLORS[color]; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#1B1B1B'; g.lineWidth = 9; g.lineJoin = 'round';
  g.beginPath();
  if (color === 'red') g.arc(64, 64, 32, 0, Math.PI * 2);
  else if (color === 'blue') { g.moveTo(64, 26); g.lineTo(100, 94); g.lineTo(28, 94); g.closePath(); }
  else g.rect(32, 32, 64, 64);
  g.stroke();
  return c;
}

export function floorIndicator(text: string, sub = '', color = '#E9B96E'): HTMLCanvasElement {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#0d0e10'; g.fillRect(0, 0, 256, 128);
  g.fillStyle = color; g.font = `700 84px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, sub ? 100 : 128, 68);
  if (sub) { g.font = `700 54px ${FONT}`; g.fillText(sub, 196, 66); }
  return c;
}

export function textBoard(title: string, lines: { t: string; c?: string; size?: number }[], w = 700, h = 540): HTMLCanvasElement {
  const [c, g] = canvas(w, h);
  g.fillStyle = '#242428'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#77716A'; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4);
  g.fillStyle = '#F0EBDD'; g.font = `700 36px ${FONT}`; g.textBaseline = 'top';
  g.fillText(title, 44, 40);
  let y = 110;
  for (const l of lines) {
    const s = l.size ?? 26;
    g.font = `${s > 28 ? 700 : 400} ${s}px ${FONT}`; g.fillStyle = l.c ?? '#F0EBDD';
    g.fillText(l.t, 44, y);
    y += s * 1.9;
  }
  return c;
}

/** Facility sign for the facade: triple half-wheel mark + name. */
export function facadeSign(en = false): HTMLCanvasElement {
  const [c, g] = canvas(1024, 256);
  g.fillStyle = '#17171a'; g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = '#E9B96E'; g.lineWidth = 9; g.lineCap = 'round';
  for (const r of [70, 47, 24]) { g.beginPath(); g.arc(150, 168, r, Math.PI, 0); g.stroke(); }
  g.lineWidth = 7; g.beginPath(); g.moveTo(80, 186); g.lineTo(220, 186); g.stroke();
  g.fillStyle = '#F0EBDD'; g.font = `700 112px ${FONT}`; g.textBaseline = 'middle';
  g.fillText('第３駐輪場', 280, 134);
  g.fillStyle = '#B9B1A5'; g.font = `400 34px ${FONT}`;
  g.fillText(en ? 'BICYCLE PARKING No.3  ·  OPEN 24H' : '24時間　自転車専用', 290, 214);
  return c;
}

/** English counterpart of the pack's operating_rules.png (same size and colours). */
export function rulesBoardEn(): HTMLCanvasElement {
  const [c, g] = canvas(700, 540);
  g.fillStyle = '#252428'; g.fillRect(0, 0, 700, 540);
  g.strokeStyle = '#4a474d'; g.lineWidth = 2; g.strokeRect(1, 1, 698, 538);
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#F0EBDD'; g.font = `700 34px ${FONT}`; g.fillText('Night Transport Check', 44, 72);
  g.font = `400 26px ${FONT}`;
  const steps = ['Read the conditions on the checklist', 'Enter the counts from left to right', 'Press OPEN to check'];
  steps.forEach((t, i) => { g.fillStyle = '#F0EBDD'; g.fillText(String(i + 1), 50, 138 + i * 54); g.fillText(t, 96, 138 + i * 54); });
  g.font = `400 22px ${FONT}`;
  g.fillStyle = '#B9B1A5'; g.fillText('CLOSE clears input   ·   Recheck goes back', 44, 312);
  g.fillStyle = '#D9877D'; g.fillText('A wrong answer after a warning calls the caretaker', 44, 386);
  g.fillStyle = '#E9B96E'; g.fillText('Your own bicycle and empty slots do not count', 44, 458);
  return c;
}

/** English counterpart of paid_receipt.png. */
export function receiptEn(): HTMLCanvasElement {
  const [c, g] = canvas(360, 580);
  g.fillStyle = '#E9E3D3'; g.fillRect(0, 0, 360, 580);
  g.strokeStyle = '#8f8778'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 357, 577);
  g.textBaseline = 'alphabetic'; g.fillStyle = '#2b2a2e';
  g.font = `700 25px ${FONT}`; g.fillText('Bicycle Parking No.3', 30, 58);
  g.font = `400 19px ${FONT}`; g.fillText('PAID RECEIPT', 30, 96);
  g.strokeStyle = '#9b9384'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(30, 124); g.lineTo(328, 124); g.stroke();
  g.font = `400 18px ${FONT}`;
  [['Floor', '5F'], ['Space', '517'], ['Fee', '¥200'], ['Paid at', '23:07']].forEach(([k, v], i) => { g.fillText(k, 30, 172 + i * 40); g.fillText(v, 140, 172 + i * 40); });
  g.font = `400 16px ${FONT}`;
  g.fillText('Keep this receipt until you leave.', 30, 344);
  g.fillText('Insert into the transport reader', 30, 392);
  g.fillText('and set your front wheel on the rail.', 30, 420);
  g.font = `700 34px ${FONT}`; g.fillText('PAID', 30, 522);
  g.strokeStyle = '#2b2a2e'; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath(); g.moveTo(236, 488); g.lineTo(262, 516); g.lineTo(306, 470); g.stroke();
  return c;
}

/** Night city panorama for the cylinder outside the open side walls. */
export function cityPanorama(seed = 7): HTMLCanvasElement {
  const W = 2048, H = 512;
  const [c, g] = canvas(W, H);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#05070c'); sky.addColorStop(0.55, '#0c111b'); sky.addColorStop(0.78, '#1a1d26'); sky.addColorStop(1, '#0b0c10');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  // faint haze glow near horizon
  const haze = g.createLinearGradient(0, H * 0.55, 0, H * 0.82);
  haze.addColorStop(0, 'rgba(120,90,60,0)'); haze.addColorStop(1, 'rgba(120,90,60,0.18)');
  g.fillStyle = haze; g.fillRect(0, H * 0.55, W, H * 0.3);
  const layers = [
    { base: 0.86, hMin: 0.06, hMax: 0.22, col: '#0b0d12', win: 0.18 },
    { base: 0.93, hMin: 0.08, hMax: 0.30, col: '#07080b', win: 0.28 },
  ];
  for (const L of layers) {
    let x = 0;
    while (x < W) {
      const bw = 30 + rnd() * 90;
      const bh = (L.hMin + rnd() * (L.hMax - L.hMin)) * H;
      const top = L.base * H - bh;
      g.fillStyle = L.col; g.fillRect(x, top, bw, H - top);
      for (let wy = top + 6; wy < L.base * H - 4; wy += 9) {
        for (let wx = x + 4; wx < x + bw - 4; wx += 8) {
          if (rnd() < L.win * 0.35) {
            const warm = rnd() < 0.7;
            g.fillStyle = warm ? `rgba(233,185,110,${0.35 + rnd() * 0.5})` : `rgba(170,190,215,${0.25 + rnd() * 0.4})`;
            g.fillRect(wx, wy, 3, 4);
          }
        }
      }
      if (bh > 0.2 * H && rnd() < 0.5) { g.fillStyle = 'rgba(217,80,70,0.9)'; g.fillRect(x + bw / 2 - 2, top - 3, 4, 4); }
      x += bw + rnd() * 6;
    }
  }
  // street-level glow band
  g.fillStyle = 'rgba(233,185,110,0.10)'; g.fillRect(0, H * 0.93, W, H * 0.07);
  return c;
}

/** Radial glow sprite. */
export function glowSprite(rgb: string): HTMLCanvasElement {
  const [c, g] = canvas(128, 128);
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, `rgba(${rgb},0.9)`); gr.addColorStop(0.25, `rgba(${rgb},0.35)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return c;
}

/** Faint concrete stain texture so big surfaces are not flat. */
export function grimeTexture(seed = 3, base = 200): HTMLCanvasElement {
  const [c, g] = canvas(256, 256);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  g.fillStyle = `rgb(${base},${base},${base})`; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 260; i++) {
    const r = 4 + rnd() * 30; const x = rnd() * 256, y = rnd() * 256;
    const v = base - 10 - rnd() * 30;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${v},${v},${v - 4},0.22)`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}
