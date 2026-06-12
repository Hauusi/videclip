/**
 * Build HTML from Markdown, then PDF via Puppeteer.
 * Run: node docs/projekt-dokumentation/generate-pdf.mjs
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

execSync('node build-html.mjs', { cwd: __dirname, stdio: 'inherit' });

const require = createRequire(
  path.resolve(__dirname, '../../server/package.json'),
);
const puppeteer = require('puppeteer');

const htmlPath = path.join(__dirname, 'handbuch.html');
const pdfPath = path.join(__dirname, 'VIDECLIP-HANDBUCH.pdf');

if (!fs.existsSync(htmlPath)) {
  console.error('Missing handbuch.html — run after creating HTML.');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, {
  waitUntil: 'networkidle0',
});
await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' },
});
await browser.close();

console.log('PDF created:', pdfPath);
