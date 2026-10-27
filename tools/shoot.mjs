// Open a page in headless Chromium, wait for window.__shots, save PNGs.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
const [url, outDir] = process.argv.slice(2);
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const logs = []; page.on('console', (m) => logs.push(m.type() + ': ' + m.text())); page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.goto(url);
await page.waitForFunction(() => window.__shots || window.__err, null, { timeout: 120000 });
const err = await page.evaluate(() => window.__err); if (err) console.log('ERR', err);
const shots = await page.evaluate(() => window.__shots || {});
mkdirSync(outDir, { recursive: true });
for (const [k, v] of Object.entries(shots)) writeFileSync(`${outDir}/${k}.png`, Buffer.from(v.split(',')[1], 'base64'));
console.log(Object.keys(shots).join(' '), JSON.stringify(await page.evaluate(() => window.__stats)));
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
