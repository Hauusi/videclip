# Videclip — Projektdokumentation

Dieser Ordner enthält die vollständige Projektdokumentation als **Markdown**, **HTML** und **PDF**.

## Dateien

| Datei | Beschreibung |
|-------|--------------|
| `VIDECLIP-HANDBUCH.md` | Quelltext (bearbeitbar) |
| `handbuch.html` | HTML-Version für Druck/PDF |
| `VIDECLIP-HANDBUCH.pdf` | Technisches Handbuch (PDF) |
| `PEAKCLIP-KOMPLETTUEBERSICHT.md` | Übersicht + Neuerungen (Quelltext) |
| `PEAKCLIP-KOMPLETTUEBERSICHT.pdf` | **Komplettübersicht mit Prozess-Skizzen** |
| `build-html.mjs` | MD → HTML (Handbuch) |
| `build-overview.mjs` | MD → HTML (Übersicht) |
| `generate-pdf.mjs` | Handbuch → PDF |
| `generate-overview-pdf.mjs` | Übersicht → PDF |

## PDF neu erzeugen

**Im Projektordner** `videclip` (nicht in `C:\Users\rapha`):

```powershell
cd C:\Users\rapha\Desktop\videclip
npm run docs:pdf
npm run docs:overview-pdf
```

**Komplettübersicht (Neuerungen, Architektur, Skizzen):**

```powershell
npm run docs:overview-pdf
```

Oder direkt:

```powershell
node C:\Users\rapha\Desktop\videclip\docs\projekt-dokumentation\generate-pdf.mjs
```

Voraussetzung: `npm install` im Ordner `server/` (Puppeteer ist dort bereits eine Abhängigkeit).

## Inhalt des Handbuchs

1. Überblick & Tech-Stack  
2. Projektordner-Struktur & Temp-Dateien  
3. Benutzer-Flow (Frontend)  
4. Backend-Services & Hintergrundprozesse (Analyze, FFmpeg, STT, Hook)  
5. API-Referenz  
6. Konfiguration (.env)  
7. Datenfluss-Diagramme  
8. Bekannte Grenzen & Roadmap  
9. Entwicklung & Logs  
10. Datei-Index aller Services  
