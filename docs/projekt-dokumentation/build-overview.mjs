import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const md = fs.readFileSync(path.join(__dirname, 'PEAKCLIP-KOMPLETTUEBERSICHT.md'), 'utf8');

function mdToHtml(src) {
  let html = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^---$/gm, '<hr/>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  const lines = html.split('\n');
  const out = [];
  let inPre = false;
  let tableRows = [];

  const flushTable = () => {
    if (!tableRows.length) return;
    out.push('<table>');
    tableRows.forEach((row, i) => {
      const tag = i === 0 ? 'th' : 'td';
      out.push(
        '<tr>' +
          row.map((c) => `<${tag}>${c.trim()}</${tag}>`).join('') +
          '</tr>',
      );
    });
    out.push('</table>');
    tableRows = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inPre) {
        out.push('</pre>');
        inPre = false;
      } else {
        flushTable();
        out.push('<pre class="diagram">');
        inPre = true;
      }
      continue;
    }
    if (inPre) {
      out.push(line);
      continue;
    }
    if (line.includes('|') && line.trim().startsWith('|')) {
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue;
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      tableRows.push(cells);
      continue;
    }
    flushTable();
    if (/^\d+\.\s/.test(line)) {
      out.push(`<li>${line.replace(/^\d+\.\s/, '')}</li>`);
      continue;
    }
    if (line.startsWith('- ')) {
      out.push(`<li>${line.slice(2)}</li>`);
      continue;
    }
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    if (line.startsWith('<h') || line.startsWith('<hr')) {
      out.push(line);
      continue;
    }
    out.push(`<p>${line}</p>`);
  }
  flushTable();
  if (inPre) out.push('</pre>');

  return out.join('\n');
}

const body = mdToHtml(md);

const template = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8"/>
  <title>PeakClip — Komplettübersicht</title>
  <style>
    @page { size: A4; margin: 16mm 14mm; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 10pt;
      line-height: 1.42;
      color: #1a1a2e;
    }
    h1 { font-size: 20pt; color: #5b21b6; margin: 0 0 8pt; page-break-after: avoid; }
    h2 {
      font-size: 13.5pt;
      color: #6d28d9;
      margin: 16pt 0 7pt;
      padding-bottom: 3pt;
      border-bottom: 2px solid #e9d5ff;
      page-break-after: avoid;
    }
    h3 { font-size: 11pt; color: #7c3aed; margin: 10pt 0 5pt; page-break-after: avoid; }
    p { margin: 0 0 7pt; }
    li { margin: 0 0 3pt 14pt; }
    hr { border: none; border-top: 1px solid #ddd; margin: 12pt 0; }
    code {
      font-family: Consolas, monospace;
      font-size: 8.5pt;
      background: #f3f4f6;
      padding: 1pt 4pt;
      border-radius: 3pt;
    }
    pre.diagram {
      font-family: Consolas, 'Courier New', monospace;
      font-size: 7.5pt;
      line-height: 1.25;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      color: #334155;
      padding: 10pt 12pt;
      border-radius: 6pt;
      white-space: pre;
      overflow-x: auto;
      page-break-inside: avoid;
      margin: 8pt 0 12pt;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 6pt 0 12pt;
      font-size: 9pt;
      page-break-inside: avoid;
    }
    th, td {
      border: 1px solid #d1d5db;
      padding: 5pt 7pt;
      text-align: left;
      vertical-align: top;
    }
    th { background: #f5f3ff; color: #5b21b6; font-weight: 600; }
    tr:nth-child(even) td { background: #fafafa; }
    .cover {
      text-align: center;
      padding: 50pt 0 30pt;
      page-break-after: always;
      background: linear-gradient(180deg, #f5f3ff 0%, #fff 100%);
      border-radius: 8pt;
      margin-bottom: 20pt;
    }
    .cover h1 { font-size: 26pt; margin-bottom: 12pt; }
    .cover .sub { font-size: 13pt; color: #64748b; margin: 4pt 0; }
    .cover .ver { font-size: 10pt; color: #94a3b8; margin-top: 20pt; }
    .badge {
      display: inline-block;
      background: #7c3aed;
      color: white;
      font-size: 8pt;
      padding: 3pt 10pt;
      border-radius: 20pt;
      margin-top: 8pt;
    }
  </style>
</head>
<body>
  <div class="cover">
    <h1>PeakClip</h1>
    <p class="sub">Komplettübersicht · Architektur · Prozesse · Neuerungen</p>
    <p class="sub">YouTube → KI-Clips → Shorts / TikTok / Reels</p>
    <span class="badge">Version 2.0 · Juni 2026</span>
    <p class="ver">Produktion: Hetzner VPS · /opt/videclip</p>
  </div>
  ${body}
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'uebersicht.html'), template, 'utf8');
console.log('HTML created: uebersicht.html');
