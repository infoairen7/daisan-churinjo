// Shared Playwright helpers for the scripted playtests.
let pw;
try { pw = (await import('playwright')).default; } catch { pw = (await import('/opt/node22/lib/node_modules/playwright/index.js')).default; }
import { mkdirSync } from 'node:fs';
export async function open(url, { width = 960, height = 540, touch = false, outDir, locale = 'ja-JP', notice = false }) {
  mkdirSync(outDir, { recursive: true });
  const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1, locale });
  // the one-time content notice before the first night would stop every scripted run; mark it as seen unless asked
  if (!notice) await ctx.addInitScript(() => { try { const k = 'parking3.settings.v1'; const s = JSON.parse(localStorage.getItem(k) || '{}'); if (!s.warned) { s.warned = true; localStorage.setItem(k, JSON.stringify(s)); } } catch { /* ignore */ } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message + '\n' + e.stack));
  await page.goto(url);
  const h = {
    page, browser, logs,
    sleep: (ms) => page.waitForTimeout(ms),
    st: () => page.evaluate(() => window.__p3?.state()),
    shot: (name) => page.screenshot({ path: `${outDir}/${name}.png`, timeout: 120000 }),
    key: async (k, hold = 60) => { await page.keyboard.down(k); await page.waitForTimeout(hold); await page.keyboard.up(k); await page.waitForTimeout(80); },
    tp: (x, z, yaw) => page.evaluate(([x, z, yaw]) => window.__p3.tp(x, z, yaw), [x, z, yaw]),
    face: (px, pz, tx, tz) => page.evaluate(([px, pz, tx, tz]) => window.__p3.tp(px, pz, Math.atan2(-(tx - px), -(tz - pz))), [px, pz, tx, tz]),
    waitFor: async (pred, timeout = 30000, label = '') => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { const s = await h.st(); if (s && pred(s)) return s; await page.waitForTimeout(150); }
      throw new Error('timeout waiting for ' + label + ' state=' + JSON.stringify(await h.st()));
    },
  };
  return h;
}
