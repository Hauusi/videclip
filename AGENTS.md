# Agent context — Videclip

**Start here:** Read [`README.md`](README.md) before changing pipeline, shooter, or deploy code.

## Session checklist

1. Read `README.md` (especially **Shooter / CS2 pipeline** and **Changelog**)
2. After any architectural change → update `README.md` in the **same session**
3. Production changes → deploy per README **Production deploy** and verify logs
4. Do not rely on chat history alone — README is the persistent context

## Shooter montages (one paragraph)

CS2 VODs use HUD kill-feed detection (`kill_feed_detect.py`), quality filtering (`filterQualityHudKills`), local kill chains (`buildSlidingKillChains`), jump-cut segments per kill (`buildHudKillMontageSegments`), selection of 5 non-overlapping clips (`shooterHighlightSelect`), FFmpeg montage cut (`cutMontageClip`). **Never** pack kills round-robin across the full VOD.

## Key paths

| What | Where |
|------|--------|
| Analyze job | `server/src/services/analyzePipeline.js` |
| Montage logic | `server/src/services/montageClip.js` |
| HUD quality | `server/src/services/shooterClusters.js` |
| Python HUD | `server/scripts/kill_feed_detect.py` |
| Production | `62.238.39.31:/opt/videclip`, `systemctl restart videclip` |

## README update triggers

Update `README.md` when you:

- Add/remove/rename a service or pipeline phase
- Change shooter timing, clustering, or selection rules
- Change env vars, API routes, or deploy commands
- Fix a bug that future agents must not reintroduce → add to **Do NOT reintroduce**

Bump `Last updated` and add a **Changelog** row.

## Deeper docs

- [`docs/projekt-dokumentation/PEAKCLIP-KOMPLETTUEBERSICHT.md`](docs/projekt-dokumentation/PEAKCLIP-KOMPLETTUEBERSICHT.md) — full handbook (may lag behind README; sync on major changes)
