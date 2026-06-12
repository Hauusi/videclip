# Debug Kill Export — removal checklist

**Temporary feature** for inspecting HUD-detected kills during CS2 montage tuning.
Disable without deleting: set `DEBUG_KILL_EXPORT=0` in server `.env`.

## Files to delete

| File | Purpose |
|------|---------|
| `server/src/services/debugKillExport.js` | Core logic (JSON + MP4 reels) |
| `client/src/components/DebugKillExportPanel.jsx` | Download UI |
| `DEBUG_KILL_EXPORT_REMOVAL.md` | This checklist |

## Files to edit (revert marked blocks)

### `server/src/config.js`
Remove:
```js
debugKillExport: process.env.DEBUG_KILL_EXPORT !== '0',
```

### `server/src/services/analyzePipeline.js`
1. Remove import:
   ```js
   import { exportDebugKills, isDebugKillExportEnabled } from './debugKillExport.js';
   ```
2. Revert `highlightContext` back to inline spread in `analyzeHighlights(...)` if desired.
3. Remove entire block between `// DEBUG_KILL_EXPORT START` and `// DEBUG_KILL_EXPORT END`.
4. Remove `debugKillExport` from `result` object.

### `client/src/App.jsx`
1. Remove `import DebugKillExportPanel from './components/DebugKillExportPanel.jsx';`
2. Remove `<DebugKillExportPanel debugKillExport={result.debugKillExport} />` below clips header.
3. Remove `debugKillExport={result.debugKillExport}` from `<HighlightCard>`.

### `client/src/components/HighlightCard.jsx`
1. Remove `DebugKillExportPanel` import and `debugKillExport` prop.
2. Remove montage segment download links (`debug_download_url`) and embedded panel.

### `server/src/services/analyzePipeline.js` (extra)
Remove `attachMontageSegmentDownloads` import and post-enrich `Promise.all` block.

### `README.md`
Remove **Debug kill export (temporary)** section and changelog line.

## Server env (Hetzner)

Remove or set on production after testing:
```
DEBUG_KILL_EXPORT=0
```

## Output artifacts per job

Written to `{workDir}/debug/`:
- `kills.json` — all HUD events with filter status
- `kills-reel-all.mp4` — up to 60 kills, ~3.5s each
- `kills-reel-pool.mp4` — montage-pool kills only
- `kills-reel-rejected.mp4` — confirmed but not in pool

Served via existing `/api/files/:jobId/debug/:file` route (no route changes needed).
