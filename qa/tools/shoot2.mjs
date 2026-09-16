// Per-file viewport variant of ../tools/shoot.mjs: body[data-vw]/[data-vh] size the page; fixed sheets stay inside the shot.
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../../reports/agent-reports/package.json'));
const puppeteer = require('puppeteer');
const files = process.argv.slice(2);
const browser = await puppeteer.launch({ headless: 'new', executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] });
for (const f of files) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(resolve(here, f)).href, { waitUntil: 'load' });
  const vw = Number(await page.$eval('body', (b) => b.dataset.vw)) || 900;
  const vh = Number(await page.$eval('body', (b) => b.dataset.vh)) || 640;
  await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 2 });
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: resolve(here, f.replace(/\.html$/, '.png')), fullPage: false });
  await page.close();
}
await browser.close();
console.log('shot', files.length);
