// Render an HTML file to PDF with the bundled puppeteer (reports/agent-reports).
// Usage: node qa/tools/render-pdf.mjs <in.html> <out.pdf> "<footer text>"
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../reports/agent-reports/package.json'));
const puppeteer = require('puppeteer');

const [, , inHtml, outPdf, footer = 'Ticket Pulse — QA response'] = process.argv;
if (!inHtml || !outPdf) { console.error('usage: render-pdf.mjs <in.html> <out.pdf>'); process.exit(1); }

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.goto(pathToFileURL(resolve(inHtml)).href, { waitUntil: 'load' });
await page.evaluate(() => document.fonts?.ready);
await page.pdf({
  path: resolve(outPdf),
  format: 'Letter',
  printBackground: true,
  preferCSSPageSize: true,
  margin: { top: '0.55in', bottom: '0.6in', left: '0.55in', right: '0.55in' },
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: `<div style="width:100%;font-size:8px;color:#94a3b8;padding:0 0.55in;display:flex;justify-content:space-between;font-family:Segoe UI,Arial"><span>${footer}</span><span class="pageNumber"></span></div>`,
});
await browser.close();
console.log('pdf written', resolve(outPdf));
