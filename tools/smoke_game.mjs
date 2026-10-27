import { open } from './pw.mjs';
const out = process.argv[2];
const h = await open('http://localhost:8765/local.html', { outDir: out });
try {
  await h.page.waitForFunction(() => window.__p3 && document.querySelector('#loading').hidden, null, { timeout: 120000 });
  await h.sleep(1500);
  await h.shot('01_title');
  console.log('title', JSON.stringify(await h.st()));
} catch (e) { console.log('ERR', e.message); }
console.log(h.logs.join('\n'));
await h.browser.close();
