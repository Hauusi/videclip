/**
 * PeakClip Komplettübersicht → PDF
 * Run: node docs/projekt-dokumentation/generate-overview-pdf.mjs
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

execSync('node build-overview.mjs', { cwd: __dirname, stdio: 'inherit' });

const require = createRequire(
  path.resolve(__dirname, '../../server/package.json'),
);
const puppeteer = require('puppeteer');

const htmlPath = path.join(__dirname, 'uebersicht.html');
const pdfPath = path.join(__dirname, 'PEAKCLIP-KOMPLETTUEBERSICHT.pdf');

if (!fs.existsSync(htmlPath)) {
  console.error('Missing uebersicht.html');
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
  margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
});
await browser.close();

console.log('PDF created:', pdfPath);
