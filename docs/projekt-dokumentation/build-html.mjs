import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const md = fs.readFileSync(path.join(__dirname, 'VIDECLIP-HANDBUCH.md'), 'utf8');

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
  let inTable = false;
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
    inTable = false;
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inPre) {
        out.push('</pre>');
        inPre = false;
      } else {
        flushTable();
        out.push('<pre class="code">');
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
      inTable = true;
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
    if (line.startsWith('<h')) {
      out.push(line);
      continue;
    }
    if (line.startsWith('<hr')) {
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
  <title>Videclip — Projekthandbuch</title>
  <style>
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 10.5pt;
      line-height: 1.45;
      color: #1a1a2e;
      max-width: 100%;
    }
    h1 { font-size: 22pt; color: #5b21b6; margin: 0 0 8pt; page-break-after: avoid; }
    h2 {
      font-size: 14pt;
      color: #6d28d9;
      margin: 18pt 0 8pt;
      padding-bottom: 4pt;
      border-bottom: 2px solid #e9d5ff;
      page-break-after: avoid;
    }
    h3 { font-size: 11.5pt; color: #7c3aed; margin: 12pt 0 6pt; page-break-after: avoid; }
    p { margin: 0 0 8pt; }
    li { margin: 0 0 4pt 16pt; }
    hr { border: none; border-top: 1px solid #ddd; margin: 14pt 0; }
    code {
      font-family: Consolas, monospace;
      font-size: 9pt;
      background: #f3f4f6;
      padding: 1pt 4pt;
      border-radius: 3pt;
    }
    pre.code {
      font-family: Consolas, monospace;
      font-size: 8.5pt;
      background: #1e1e2e;
      color: #e2e8f0;
      padding: 10pt 12pt;
      border-radius: 6pt;
      overflow-x: auto;
      white-space: pre-wrap;
      page-break-inside: avoid;
      margin: 8pt 0 12pt;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 8pt 0 14pt;
      font-size: 9.5pt;
      page-break-inside: avoid;
    }
    th, td {
      border: 1px solid #d1d5db;
      padding: 6pt 8pt;
      text-align: left;
      vertical-align: top;
    }
    th { background: #f5f3ff; color: #5b21b6; font-weight: 600; }
    tr:nth-child(even) td { background: #fafafa; }
    .cover {
      text-align: center;
      padding: 60pt 0 40pt;
      page-break-after: always;
    }
    .cover h1 { font-size: 28pt; }
    .cover p { font-size: 12pt; color: #64748b; }
  </style>
</head>
<body>
  <div class="cover">
    <h1>Videclip</h1>
    <p>Projekthandbuch — Architektur, Prozesse &amp; Ordnerstruktur</p>
    <p>Version 1.0 · Mai 2026</p>
  </div>
  ${body}
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'handbuch.html'), template, 'utf8');
console.log('HTML created: handbuch.html');
