import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2] || here);
const require = createRequire(resolve(here, '../../reports/agent-reports/package.json'));
const puppeteer = require('puppeteer');
const browser = await puppeteer.launch({ headless: 'new', executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] });
for (const f of readdirSync(dir).filter((n) => n.endsWith('.html'))) {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(resolve(dir, f)).href, { waitUntil: 'load' });
  const el = await page.$('.tp-page-backdrop');
  await el.screenshot({ path: resolve(dir, f.replace(/\.html$/, '.png')) });
  await page.close();
}
await browser.close();
console.log('shot');
