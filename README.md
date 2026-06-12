# Videclip (PeakClip)

YouTube/VOD → AI highlights → vertical clips (Shorts, TikTok, Reels).

> **Living documentation.** This file is the single source of truth for architecture, pipeline behaviour, and production deploy. **Agents must update it in the same session** when adding, removing, or changing features (see `AGENTS.md` and `.cursor/rules/readme-sync.mdc`).

**Last updated:** 2026-06-10 (kill anchor fix)

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18, Vite, Tailwind |
| Backend | Node.js (ESM), Express |
| Highlights (general) | Anthropic Claude (`CLAUDE_MODEL`, default Sonnet) |
| STT / captions | Groq Whisper (`GROQ_API_KEY`) |
| Video | `ffmpeg-static`, hybrid seek for AV1 montage cuts |
| Shooter HUD | Python 3 + OpenCV + `kill_feed_detect.py` |
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
| Render | `ffmpeg.js`, `captionPipeline.js` | Montage clips skip caption burn |

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
4. Prefer **3–4 kill** chains; 2-kill chains as fallback
5. **No kill reused** across clips (`montagesShareKill`)

### Do NOT reintroduce

- Round-robin packing (`allKills.forEach((k,i) => packs[i % 5])`) — caused 500s gaps between kills in one clip
- `snapPeakToGunshot` for HUD anchors — shifted cuts before visible kill
- Auto `viral_score` from segment count only — use `montageViralScore` in `shooterHighlightSelect.js`
- Skipping `isCoherentKillMontage` for HUD packs

### Debug logs (production)

```bash
ssh -i C:\Users\rapha\.ssh\id_ed25519_hetzner root@62.238.39.31 \
  "journalctl -u videclip -n 100 --no-pager | grep -E 'hud-quality|HUD chains|montage preview|cut\] montage'"
```

| Log | Healthy signal |
|-----|----------------|
| `[hud-quality] X/Y HUD events pass` | X < Y (noise filtered) |
| `[montage] HUD chains: … → N clips (4+3+…)` | Mixed kill counts |
| `HUD montage preview: … peak gaps 5s \| 7s` | Gaps **< 18s**, not 500s |
| `[cut] montage … 424+3.7s \| 431+3.7s` | Tight local segments |

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

## Debug kill export (temporary)

Inspect HUD-detected kills per shooter analyze job. **Remove when done** — see `DEBUG_KILL_EXPORT_REMOVAL.md`.

| Output | Path |
|--------|------|
| Annotated JSON | `/api/files/{jobId}/debug/kills.json` |
| Reel (all, max 60) | `debug/kills-reel-all.mp4` |
| Reel (montage pool) | `debug/kills-reel-pool.mp4` |
| Reel (rejected) | `debug/kills-reel-rejected.mp4` |

Enabled by default. Disable: `DEBUG_KILL_EXPORT=0` in server `.env`.

---

## Production deploy

```powershell
# Client (after UI changes)
npm run build
scp -i C:\Users\rapha\.ssh\id_ed25519_hetzner -r client\dist root@62.238.39.31:/opt/videclip/client/

# Server services (after backend changes)
scp -i C:\Users\rapha\.ssh\id_ed25519_hetzner server\src\services\*.js root@62.238.39.31:/opt/videclip/server/src/services/

# Python HUD script
scp -i C:\Users\rapha\.ssh\id_ed25519_hetzner server\scripts\kill_feed_detect.py root@62.238.39.31:/opt/videclip/server/scripts/

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
