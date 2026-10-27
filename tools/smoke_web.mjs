// Smoke test of the release build (docs/): loads with GLB models, no test hooks, title in both languages, a run starts.
// node tools/serve.mjs docs 8766 &  then  node tools/smoke_web.mjs <outDir>
import { open } from './pw.mjs';
const out = process.argv[2] || 'out/smoke_web';
const log = (k, v) => console.log(k, typeof v === 'string' ? v : JSON.stringify(v));
let ok = true;
for (const lang of ['ja', 'en']) {
  const h = await open(`http://localhost:8766/?lang=${lang}`, { outDir: out, width: 1280, height: 720, locale: lang === 'en' ? 'en-US' : 'ja-JP' });
  try {
    await h.page.waitForFunction(() => document.querySelector('#loading')?.hidden, null, { timeout: 180000 });
    const info = await h.page.evaluate(() => ({
      hooks: typeof window.__p3, title: document.title, newGame: document.querySelector('[data-act=new]')?.textContent,
      og: document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
      models: performance.getEntriesByType('resource').filter((r) => r.name.includes('/models/')).map((r) => r.name.split('/').pop()),
    }));
    log(lang + ' info', info);
    if (info.hooks !== 'undefined' || !info.models.length || !info.models.every((m) => m.endsWith('.glb'))) ok = false;
    await h.shot(`web_${lang}_title`);
    await h.page.keyboard.press('Space');
    await h.page.waitForFunction(() => !document.querySelector('#hud').hidden, null, { timeout: 120000 });
    await h.sleep(4000);
    await h.shot(`web_${lang}_play`);
  } catch (e) { ok = false; log('FAIL', e.message.slice(0, 200)); await h.shot(`web_${lang}_zz`); }
  const errs = h.logs.filter((l) => !l.includes('ERR_TUNNEL'));
  log(lang + ' console', errs); if (errs.length) ok = false;
  await h.browser.close();
}
log('RESULT', ok ? 'PASS' : 'FAIL');
