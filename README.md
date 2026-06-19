# Videclip (PeakClip)

YouTube/VOD → AI highlights → vertical clips (Shorts, TikTok, Reels).

> **Living documentation.** This file is the single source of truth for architecture, pipeline behaviour, and production deploy. **Agents must update it in the same session** when adding, removing, or changing features (see `AGENTS.md` and `.cursor/rules/readme-sync.mdc`).

**Last updated:** 2026-06-19 (Shooter pipeline bugfixes — gamertag validation, POV detection, montage coherence)

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18, Vite, Tailwind |
| Backend | Node.js (ESM), Express |
| Highlights (general) | Anthropic Claude (`CLAUDE_MODEL`, default Sonnet) |
| STT / captions | Groq Whisper (`GROQ_API_KEY`) |
| Video | `ffmpeg-static`, hybrid seek for AV1 montage cuts |
| Shooter HUD | Python 3 + OpenCV + `kill_feed_detect.py` (AV1 → ffmpeg frame extract) |
| Production | Hetzner VPS `62.238.39.31`, path `/opt/videclip`, systemd `videclip` |

Extended handbook: [`docs/projekt-dokumentation/PEAKCLIP-KOMPLETTUEBERSICHT.md`](docs/projekt-dokumentation/PEAKCLIP-KOMPLETTUEBERSICHT.md)

---

## Setup

```bash
npm run install:all
copy server\.env.example server\.env   # set ANTHROPIC_API_KEY, GROQ_API_KEY
npm run dev
```

- App: http://localhost:5173  
- API: http://localhost:3001  

**Env (server/.env):** `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `PORT`, `PYTHON_PATH` (for HUD script). See `server/.env.example`.

---

## Analyze pipeline (all content)

**Entry:** `POST /api/analyze` → `server/src/services/analyzePipeline.js` → `runAnalyzeJob()`

```
Download → Transcript (YouTube or Groq STT) → Category (gameCategory + visual)
  → Highlight candidates (Claude or shooter path) → Cut raw clips → Transcribe clips
  → Render 9:16 → Project thumbnail → Job complete
```

| Phase | Service(s) | Notes |
|-------|------------|-------|
| Download | `download.js` | Piped API; yt-dlp on production |
| Transcript | `transcript.js`, `youtubeTranscript.js` | YouTube often **429** → fallback Groq full-VOD STT in 8×10min chunks |
| Category | `gameCategory.js`, `gameVisualDetect.js` | CS2 → `shooter` profile |
| Highlights | `claude.js`, `highlightCandidates.js` | Shooter bypasses linear Claude clips |
| Cut | `ffmpeg.js` | `cutMontageClip()` for jump-cut montages |
| Render | `ffmpeg.js`, `smartCrop.js`, `captionPipeline.js` | Landscape 9:16: blur-letterbox (full gameplay width); montage clips skip caption burn |

---

## Shooter / CS2 pipeline (kill montages)

**Goal:** Up to **5 clips**, each a **local jump-cut montage** of the streamer's kills (HUD timeline), not random VOD moments stitched together.

### Flow

```
audioEnergyScan → hudKillFeed (Python ROI scan) → filterQualityHudKills
  → buildSlidingKillChains (2–4 kills within ~18s) → buildHudKillMontageSegments
  → shooterHighlightSelect (5 clips, no shared kills) → cutMontageClip (FFmpeg)
```

### Key files

| File | Role |
|------|------|
| `server/scripts/kill_feed_detect.py` | Frame-diff + OCR in kill-feed ROIs; `adjust_kill_time()` |
| `server/src/services/hudKillFeed.js` | Scan windows, spawn Python, merge events |
| `server/src/services/shooterClusters.js` | `isConfirmedHudKill`, `isQualityHudKill`, `filterQualityHudKills` |
| `server/src/services/montageClip.js` | Chains, segments, timing, `buildKillMontagePacks` |
| `server/src/services/highlightCandidates.js` | `injectHudMontageCandidates` |
| `server/src/services/shooterHighlightSelect.js` | Pick 5 montages, dedupe by kill time |
| `server/src/services/ffmpeg.js` | `cutMontageClip`, hybrid seek per segment |
| `server/src/services/smartCrop.js` | 9:16 framing: **Wide** = 16:9 + blur; **Crop** = 4:3 + blur; **Fill** = classic center 9:16 strip |

### Timing (HUD kill segment)

- **`raw_time`** (Python): frame when kill-feed UI flashed — montage anchor source
- **`shot_time`**: estimated gunshot (earlier) — do **not** use for cuts
- Anchor: `raw_time - 0.65s` (bottom_kills) via `resolveHudKillAnchor`
- Per kill: **~0.4s before anchor**, **~4.5s after** → ~4.9s per segment
- Combat-audio must spike near `raw_time` (`hasCombatAudioNear`)
- Prefer **`bottom_kills`** ROI (streamer multikill icons) when ≥3 available

### Selection rules

1. **Quality filter** rejects spawn/round-start HUD noise (first ~90s weak `top_right` without OCR)
2. **`bottom_kills` ROI** = streamer multikill icons (highest trust)
3. **Chains only** — kills within `HUD_CLUSTER_MAX_GAP_SEC` (18s); **never round-robin across full VOD**
4. **POV kills** — Python: red-border feed line + OCR name ≈ POV cluster (`llipeepfan-` variants); **not** YouTube channel/title
5. Prefer **3–4 kill** burst chains; **isolated kills → solo clip** (full coverage)
6. **Every detected POV kill** is clipped — `partitionKillsIntoBurstPacks` (no 5-clip cap)

### Do NOT reintroduce

- Round-robin packing (`allKills.forEach((k,i) => packs[i % 5])`) — caused 500s gaps between kills in one clip
- `snapPeakToGunshot` for HUD anchors — shifted cuts before visible kill
- Auto `viral_score` from segment count only — use `montageViralScore` in `shooterHighlightSelect.js`
- Skipping `isCoherentKillMontage` for HUD packs
- `fallback_red_border` in `kill_feed_pipeline.py` — counted every red-border feed line (~3× false kills); use `killer_matches_pov` only
- `pov_partial_victim` accept-all on red border — ~52 false kills (enemy names OCR'd as single victim); montage segments then show no frag
- Narrow center crop for landscape 9:16 (`cropH=full, cropW=H*9/16`) — cuts off FPS weapon model; use blur-letterbox in `smartCrop.js`
- Debug kill-export panel in main UI without `?debug=1` — use `isDebugUiEnabled()` only
- `gameplayFraming` in `structuralSettingsKey` — triggers FFmpeg preview on toggle; framing is client CSS on raw clip
- **Strict gamertag regex** `[A-Za-z0-9_\-]+` in `is_plausible_gamertag()` — rejects valid CS2 names with dots, brackets, etc.; use permissive pattern with boundary checks for bad words only
- **`bottom_kills` ROI exclusion** — falsely ignores high-confidence multikill icons; include with high confidence threshold (≥0.7 + player_kill flag)
- **Marking all kills as `red_highlight: True`** — breaks downstream quality filters; only set red_highlight when kill confirmed via visual red border detection
- **Wide-gap montage bypass** — `isCoherentKillMontage({ wideGap: true })` allows incoherent clips spanning the VOD; always enforce local kill sequences
- **Generic audio energy check** in `hasCombatAudioNear()` — checks delta buckets instead of specific gunshot peaks; verify against `audioScan.peaks` array

### Debug logs (production)

```bash
ssh -i C:\Users\rapha\.ssh\id_ed25519_hetzner root@62.238.39.31 \
  "journalctl -u videclip -n 100 --no-pager | grep -E 'hud-quality|HUD chains|montage preview|cut\] montage'"
```

| Log | Healthy signal |
|-----|----------------|
| `[kill-feed] POV filter: X kills, Y deaths, Z foreign/skip` | X ≈ POV kill count (~50–70/49min VOD), not ~180 |
| `[kill-feed] POV skip reasons: {...}` | Most skips should be `not_pov`, not `no_pov` |
| `[hud-quality] X/Y HUD events pass` | X < Y (noise filtered) |
| `[montage] HUD chains: … → N clips (4+3+…)` | Mixed kill counts |
| `HUD montage preview: … peak gaps 5s \| 7s` | Gaps **< 18s**, not 500s |
| `[cut] montage … 424+3.7s \| 431+3.7s` | Tight local segments |
| `[kill-feed] force_ffmpeg=True` | AV1 source — cv2 skipped, ffmpeg decodes frames |
| `[hud-killfeed] funnel: pass1=… kills=…` | pass1 ≈ duration/3; kills > 0 on POV VOD |
| `[hud-killfeed] WARNING: AV1 decode failure` | Scan crashed — audio fallback only |

---

## API routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/analyze` | Start async analyze job |
| GET | `/api/jobs/:id` | Poll job status |
| POST | `/api/clip` | Full FFmpeg export |
| POST | `/api/preview` | Lightweight preview |
| POST | `/api/download-all` | ZIP export |
| POST | `/api/upload-music` | Custom music track |

---

## Scheduled maintenance

### Monthly jobs (`0 7 1 * *`)

Run at **7:00 AM on the 1st of every month** (Europe/Berlin timezone).

#### 1. Deep Cleanup (7:00 AM)

More aggressive than the 10-minute temp cleanup:

| Task | Retention | Description |
|------|-----------|-------------|
| Old job workspaces | 3 days | Removes temp dirs even if they have `meta.json` |
| Preview caches | 7 days | `_previews/` subdirectories |
| Debug kill exports | 14 days | Temporary shooter debug reels |
| Log files | 30 days | `.log` files in `logs/` |
| Expired projects | 60 days | Unsaved project entries (vs 30-day default) |

**Files:** `server/src/services/monthlyCleanup.js`

#### 2. Analytics Report (7:05 AM)

Aggregiert Statistiken des Vormonats:

| Metric | Description |
|--------|-------------|
| Job volume | Total, completed, failed counts |
| Processing time | Avg/median/min/max duration |
| Game categories | CS2, other games, unknown |
| Highlights | Avg per video, montage job counts |
| Source types | YouTube vs local uploads |
| Error breakdown | Error codes and frequency |
| Trend | Last 12 months comparison |

**Output:** `server/data/analytics/YYYY-MM-report.txt` (also `latest.txt`)

**Files:** `server/src/services/monthlyAnalytics.js`

#### Manual trigger

Server runs both jobs immediately on startup as requested. To run manually:
```bash
node -e "import('./src/services/monthlyCleanup.js').then(m => m.triggerMonthlyCleanupNow())"
node -e "import('./src/services/monthlyAnalytics.js').then(m => m.triggerAnalyticsNow())"
```

---

## Debug kill export (temporary)

Inspect HUD-detected kills per shooter analyze job. **Remove when done** — see `DEBUG_KILL_EXPORT_REMOVAL.md`.

| Output | Path |
|--------|------|
| Annotated JSON | `/api/files/{jobId}/debug/kills.json` |
| Reel (all, max 60) | `debug/kills-reel-all.mp4` |
| Reel (montage pool) | `debug/kills-reel-pool.mp4` |
| Reel (rejected) | `debug/kills-reel-rejected.mp4` |

Enabled by default. Disable: `DEBUG_KILL_EXPORT=0` in server `.env`.

**Client debug UI** (kill-export links in clip feed): only with `?debug=1` in the URL (`client/src/utils/debugUi.js`).

---

## Client UI (redesign)

Shared components for the redesign; further phases build on these without changing pipeline behaviour.

| Piece | Path |
|-------|------|
| Design tokens | `client/src/styles/tokens.css` |
| Clip feed tile | `client/src/components/clip/ClipTile.jsx` |
| Project card (rail + grid) | `client/src/components/project/ProjectTile.jsx` |
| Editor preview frame | `client/src/components/editor/PreviewChrome.jsx` |
| Wide / Crop / Fill bar | `client/src/components/editor/FramingBar.jsx` |
| Framing + Editor toggle row | `client/src/components/editor/FramingEditorRow.jsx` |
| Bottom editor timeline | `client/src/components/editor/EditorTimeline.jsx` |
| Settings sheet + step list | `client/src/components/editor/SettingsSheet.jsx`, `EditorStepList.jsx` |
| Inline tool rail (editor) | `client/src/components/editor/EditorToolRail.jsx` |
| Montage info panel | `client/src/components/editor/MontageInfoPanel.jsx` |
| View resolver | `client/src/utils/appViews.js` |
| Home Bento | `client/src/views/HomeWorkspace.jsx` |
| Clip feed | `client/src/views/ClipFeed.jsx` |
| Bibliothek | `client/src/views/LibraryView.jsx` |

Sidebar: **Start** (Import + Bento), **Bibliothek** (Suche, Sort, Filter). Clip-Feed: TikTok-Grid mit Sort (Score/Kills/Dauer). Editor: Preview + kompakte **Wide/Crop/Fill** + **Editor**-Toggle → volle **Timeline** (Trim/Split/Transport, Kill-Clips per Drag, Audio-Spur); Export-Dock unten.

---

## Production deploy

```powershell
# Client (after UI changes)
npm run build
scp -i C:\Users\rapha\.ssh\id_ed25519_hetzner -r client\dist root@62.238.39.31:/opt/videclip/client/

# Server services (after backend changes)
scp -i C:\Users\rapha\.ssh\id_ed25519_hetzner server\src\services\*.js root@62.238.39.31:/opt/videclip/server/src/services/

# Python HUD script
scp -i C:\Users\rapha\.ssh\id_ed25519_hetzner server\scripts\kill_feed_detect.py server\scripts\kill_feed_pipeline.py root@62.238.39.31:/opt/videclip/server/scripts/

# Restart
ssh -i C:\Users\rapha\.ssh\id_ed25519_hetzner root@62.238.39.31 "systemctl restart videclip"
```

---

## Local run (production-like)

```bash
npm run build
npm start
```

---

## Changelog (architecture)

| Date | Change |
|------|--------|
| 2026-06-19 | **Bugfix:** Shooter pipeline fixes — fixed `is_plausible_gamertag()` character whitelist (was rejecting valid CS2 names), improved `classify_registry_entry()` POV detection logic, fixed `red_highlight` marking for all kills, fixed `isCoherentKillMontage()` to always reject wide-gap montages, added `bottom_kills` ROI support, improved audio peak detection in `hasCombatAudioNear()` |
| 2026-06-19 | **Maintenance:** Monthly cron jobs (`0 7 1 * *`) — deep cleanup + analytics report; both run immediately on startup |
| 2026-06-12 | **UI:** Montage-Live-Preview — aktiver Kill-Index beim Segmentwechsel (überlappende Source-Zeiten); Playhead/Video bleiben auf Kill 2 statt zurück auf Kill 1 |
| 2026-06-12 | **UI:** Timeline-Ruler und Kill-Spur gleiche Spaltenbreite (Label-Gutter) — 0:00 oben = Clip-Start unten |
| 2026-06-12 | **UI:** Montage-Timeline — äußere Griffe (Kill 1 links, letzter Kill rechts) per Pixel-Delta statt geklemmter Timeline-Position; kein Festhängen am Rand |
| 2026-06-12 | **UI:** Montage-Editor — Live-Preview aus Quell-VOD mit Jump-Cuts (Segment-Länge in Timeline = sofort abspielbar); Export nutzt `montage_segments` |
| 2026-06-12 | **UI Phase 2d:** Timeline nur bei **Editor**-Klick; Werkzeug-Tabs entfernt; Trim-Toolbar über Timeline; Montage-Kills als separate ziehbare Clips (`montage_segments` → Export); Audio-Spur (+ Musik) |
| 2026-06-12 | **UI Phase 2c:** `EditorTimeline` unten (Ruler, Playhead, Trim-Griffe, Split, Transport, Zoom; Montage-Kill-Spur); `FramingEditorRow` (kompakte Wide/Crop/Fill + Editor-Toggle); schmalere Export-Buttons |
| 2026-06-12 | **UI Phase 2b:** Editor — `EditorToolRail` inline; FramingBar eigene Zone (kein Clip), Preview-Höhe begrenzt |
| 2026-06-12 | **UI Phase 2:** Cinema Editor — single-column preview, Kill-Timeline, export dock, „Peak Score“ |
| 2026-06-12 | **UI Phase 1:** `HomeWorkspace` (Bento), `ClipFeed` (Filter + Sort Kills/Dauer), `LibraryView` (Suche/Sort/Filter), `projectMetaLine` mit Kills/Dauer, Projekt-Hover-Play |
| 2026-06-12 | **UI Phase 0:** `tokens.css`, `ClipTile`, `ProjectTile`, `PreviewChrome`, `FramingBar`; `appViews` + `data-app-view`; debug panel gated on `?debug=1`; sidebar **Bibliothek** |
| 2026-06-12 | Gameplay framing (Wide/Crop/9:16): **client CSS on raw clip** — toggle does not trigger FFmpeg preview; export still bakes framing |
| 2026-06-12 | Third gameplay framing **Fill** (`9:16`): classic center strip (full height, no blur); Wide/Crop unchanged |
| 2026-06-12 | Crop framing: center **4:3** gameplay + blur letterbox (not full 16:9, not narrow 9:16 strip); preview + FFmpeg export |
| 2026-06-15 | Fix Crop preview: explicit center-crop transform (316% width on 16:9); zoom fallback on baked 9:16 overview |
| 2026-06-15 | Fix blur-letterbox FFmpeg graph: output pad `[bg]` must not be comma-separated (was `Filter not found`) |
| 2026-06-14 | POV recall: red-border + foreign killer / victim-only OCR (`pov_foreign_killer_ocr`, `pov_partial_victim_foreign`) |
| 2026-06-14 | Burst montages only: gap≤22s, span≤55s; anchor raw−1.8s + gunshot snap; no wide-gap chains; pick 4-kill clips first |
| 2026-06-14 | Revert `pov_partial_victim`; `TRUSTED_POV_REASONS` montage filter; sliding chains before wide-gap; segment 8s (2.5+5.5) + 1.5s anchor lag; red-highlight ignores preset `kill_anchor_time` |
| 2026-06-14 | POV partial-victim on red border; montage segments 8s (3.5+4.5) + 0.8s anchor lag for visible kill |
| 2026-06-14 | POV: OCR cluster only (killer+victim scoring); multi-name match on red-border lines; no YouTube title hints; montage wide-gap coherence fix + sliding fallback |
| 2026-06-14 | POV matching: `killer_matches_pov` (cluster aliases, peepfan stem, hint suffix); skip-reason logs; no `fallback_red_border` |
| 2026-06-14 | POV filter: only killer≈POV counts; title/channel name overrides OCR fragment; fallback no longer accepts all feed kills |
| 2026-06-12 | Kill-feed scan: AV1 sources use ffmpeg per-frame extract (`force_ffmpeg`); distinct AV1 failure WARNING in logs |
| 2026-06-10 | README rewritten as living doc; shooter pipeline documented |
| 2026-06-10 | Kill montages: round-robin → `buildSlidingKillChains` + `filterQualityHudKills` |
| 2026-06-10 | HUD segments anchored on timeline; spawn filter; variable clip length |
| 2026-06-10 | Montage clips skip captions; hybrid FFmpeg seek for AV1 |
| 2026-06-10 | Kill anchor: `raw_time` not `shot_time`; combat-audio + bottom_kills filter |
| 2026-06-10 | Montage cut: hybrid seek only (exact seek timed out on AV1 at t>120s); 120s timeout per segment |
| 2026-06-10 | Jump-cut segments trimmed to non-overlapping source windows (fixes replay after cut) |
| 2026-06-10 | **TEMP** Debug kill export: JSON + MP4 reels per shooter job (`DEBUG_KILL_EXPORT_REMOVAL.md`) |
| 2026-06-10 | HUD: collapse duplicate flashes per engagement; montage gaps up to ~95s (4:25→5:32) |
| 2026-06-10 | Kill detect: audio gunshot + bottom_kills HUD only; removed broad VOD frame-diff sweep |
| 2026-06-10 | Kill anchor on gunshot not HUD flash; scan every combat peak + 3 bottom ROIs |
| 2026-06-10 | Kill quality score (gun strength + HUD timing); rejects weak false positives |
| 2026-06-10 | Gun-first kill detect; 1.2s pre-roll + 6s post-roll; local gun peak refine |
| 2026-06-10 | Primary kill source: CS2 top-right kill-feed OCR + gunshot (not bottom icon alone) |

---

## Maintaining this file

When you change pipeline logic, env vars, deploy paths, or remove a feature:

1. Update the relevant section above  
2. Add a line to **Changelog**  
3. Bump **Last updated** date  
4. If `AGENTS.md` quick-reference is affected, update it too  

Rule enforced via `.cursor/rules/readme-sync.mdc`.
