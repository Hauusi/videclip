import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import Toggle from './Toggle';
import WebcamSelector from './WebcamSelector';
import { defaultPipSettings } from './WebcamPipPreview';
import WideOverlaySelector, { defaultWideSelection } from './WideOverlaySelector';
import EditorTimeline from './editor/EditorTimeline';
import FramingEditorRow from './editor/FramingEditorRow';
import MontageInfoPanel from './editor/MontageInfoPanel';
import PreviewRenderOverlay from './PreviewRenderOverlay';
import ClipPreviewControls from './ClipPreviewControls';
import GameplayFramingPreview from './GameplayFramingPreview';
import PreviewChrome from './editor/PreviewChrome';
import {
  viralColor,
  formatTime,
  buildScript,
  PLATFORMS,
  MOODS,
  isMontageHighlight,
  getHighlightDisplayDuration,
} from '../utils/helpers';
import {
  buildOutputLayout,
  outputTimeToSegmentIndex,
  resizeSegmentEnd,
} from '../utils/montageTimeline';
import {
  advanceMontagePlayback,
  montageTotalSec,
  sourceTimeFromOutput,
} from '../utils/montagePreview';
import { clampTrimTimes, MAX_MAIN_SEC } from '../utils/trimLimits';
import { clampHookOffsetInClip, minColdOpenPeakOffset } from '../utils/coldOpenTiming';
import {
  buildTrimAroundHook,
  isHookPeakInsideTrim as hookPeakInsideTrim,
  resolveHookPeakTime,
} from '../utils/hookTrim';
import { processClip, previewClip, pollJob } from '../api';
import { enqueuePreview } from '../utils/previewQueue';
import { previewVideoClass } from '../utils/responsiveLayout';
import {
  isGameplayFramingAvailable,
  getGameplayFramingLabel,
  normalizeGameplayFramingMode,
  resolveFramingClipSources,
} from '../utils/gameplayFraming';
import { isDebugUiEnabled } from '../utils/debugUi';

const CAPTION_STYLES = [
  { id: 'fire', label: 'Fire', hint: 'Orange/rot — Shorts-Standard' },
  { id: 'bold', label: 'Bold', hint: 'Weiß, klar' },
  { id: 'minimal', label: 'Minimal', hint: 'Dezent' },
];

/** Settings that change video content (not music volume alone). */
function structuralSettingsKey(s) {
  return [
    s.start_time,
    s.end_time,
    s.hook_teaser_duration,
    s.hook_offset_in_clip,
    s.cold_open,
    s.aspectRatio,
    // gameplayFraming: client-side CSS only — export applies framing, no preview re-render
    s.captions,
    s.caption_style,
    s.showHook,
    s.colorGrade,
    s.wideOverlay,
    s.webcam?.enabled,
    s.webcam?.selection ? JSON.stringify(s.webcam.selection) : '',
    s.wideOverlayRegion?.selection ? JSON.stringify(s.wideOverlayRegion.selection) : '',
    s.wideOverlayRegion?.pip ? JSON.stringify(s.wideOverlayRegion.pip) : '',
    s.webcam?.pip ? JSON.stringify(s.webcam.pip) : '',
    s.ctaText,
    s.aiStrength,
    s.musicTrackId,
    s.musicAuto,
    s.montage_segments ? JSON.stringify(s.montage_segments) : '',
  ].join('|');
}

function defaultHookOffset(h, startTime = h.start_time, endTime = h.end_time) {
  const duration = Math.max(8, endTime - startTime);
  const peak = resolveHookPeakTime(h);
  const rel = peak - startTime;
  if (rel >= minColdOpenPeakOffset(duration) && rel <= duration) {
    return clampHookOffsetInClip(duration, rel);
  }
  return clampHookOffsetInClip(duration, duration * 0.72);
}

const ASPECT_LABELS = {
  '9:16': 'TikTok / Shorts',
  '1:1': 'Instagram',
  '16:9': 'YouTube',
};

function hasPreviewEffects(s) {
  return Boolean(
    s.cold_open ||
      s.captions ||
      s.music ||
      s.colorGrade ||
      s.showHook ||
      s.wideOverlay ||
      s.webcam?.enabled ||
      String(s.ctaText ?? '').trim(),
  );
}

function trimChangedFromHighlight(s, highlight) {
  return (
    Math.abs(s.start_time - highlight.start_time) > 0.35 ||
    Math.abs(s.end_time - highlight.end_time) > 0.35
  );
}

function analyzeDurationDrift(s, highlight) {
  const main = Math.max(1, (s.end_time ?? highlight.end_time) - (s.start_time ?? highlight.start_time));
  const measured = Number(highlight.clip_duration_measured);
  return (
    !trimChangedFromHighlight(s, highlight) &&
    Number.isFinite(measured) &&
    measured > 0.5 &&
    Math.abs(measured - main) > 0.35
  );
}

/** FFmpeg preview only when effects, hook, aspect crop, or analyze drift need server render. */
function needsServerPreview(s, highlight) {
  return (
    Boolean(s.cold_open) ||
    hasPreviewEffects(s) ||
    analyzeDurationDrift(s, highlight) ||
    (s.aspectRatio && s.aspectRatio !== '9:16')
  );
}

/** @deprecated use needsServerPreview — kept for music-volume-only path */
function shouldAutoPreview(s, highlight) {
  return needsServerPreview(s, highlight);
}

function canLiveTrimPreview(s, highlight, sourceVideoUrl) {
  return (
    Boolean(sourceVideoUrl) &&
    !s.cold_open &&
    trimChangedFromHighlight(s, highlight)
  );
}

function isHookPeakInTrim(highlight, start, end) {
  return hookPeakInsideTrim(resolveHookPeakTime(highlight), start, end);
}

function toPreviewSettings(s) {
  const mainDur = Math.max(8, (s.end_time ?? 0) - (s.start_time ?? 0));
  const hookOffset = clampHookOffsetInClip(mainDur, s.hook_offset_in_clip);
  const hookPeak = s.start_time + hookOffset;
  return {
    ...s,
    hook_offset_in_clip: s.cold_open ? hookOffset : undefined,
    hook_peak_time: s.cold_open ? hookPeak : undefined,
    hook_teaser_duration: s.cold_open ? s.hook_teaser_duration : 0,
    showHook: s.cold_open ? s.showHook : false,
  };
}

export default function HighlightCard({
  highlight,
  jobId,
  sourceDuration = 0,
  sourceWidth,
  sourceHeight,
  sourceVideoUrl = null,
  globalSettings,
  onToast,
  onClipReady,
  mood,
  onMoodChange,
  musicTrack,
  onMusicTrackPick,
  onMusicAuto,
  customMusicName,
  onCustomMusic,
  onSavePrefs,
  setGlobalAspectRatio,
  debugKillExport = null,
}) {
  const defaultCaptionStyle =
    globalSettings.captionStyle || highlight.caption_style || 'fire';

  const [settings, setSettings] = useState({
    start_time: highlight.start_time,
    end_time: highlight.end_time,
    hook_teaser_duration: 0,
    hook_offset_in_clip: defaultHookOffset(highlight),
    cold_open: false,
    caption_style: defaultCaptionStyle,
    ctaText: '',
    captions: false,
    showHook: false,
    music: false,
    musicVolume: globalSettings.musicVolume ?? 15,
    musicAuto: globalSettings.musicAuto !== false,
    musicTrackId: globalSettings.musicTrackId,
    customMusicPath: globalSettings.customMusicPath,
    colorGrade: false,
    wideOverlay: false,
    wideOverlayRegion: {
      enabled: false,
      selection: null,
      pip: null,
      sourceWidth: sourceWidth || 1920,
      sourceHeight: sourceHeight || 1080,
      startOffset: 0,
      endOffset: null,
    },
    aspectRatio: '9:16',
    gameplayFraming: 'wide',
    aiStrength: globalSettings.aiStrength ?? 75,
    webcam: {
      enabled: false,
      selection: null,
      sourceWidth: sourceWidth || 1920,
      sourceHeight: sourceHeight || 1080,
      pip: defaultPipSettings(),
      shape: 'rectangle',
    },
    montage_segments: highlight.montage_segments ? [...highlight.montage_segments] : null,
  });
  const [processing, setProcessing] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewStems, setPreviewStems] = useState(null);
  const [stemRev, setStemRev] = useState(0);
  const [videoSource, setVideoSource] = useState('analyze');
  const videoRef = useRef(null);
  const musicAudioRef = useRef(null);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [hookMeasuredSec, setHookMeasuredSec] = useState(
    Number.isFinite(Number(highlight.hook_teaser_measured_sec))
      ? Number(highlight.hook_teaser_measured_sec)
      : null,
  );
  const settingsRef = useRef(settings);
  const triggerPreviewRef = useRef(null);
  const lastRenderedPreviewKeyRef = useRef('');
  const previewInFlightKeyRef = useRef('');
  const lastDisplayUrlRef = useRef(null);
  const prevHookVisualRef = useRef({
    hook_offset_in_clip: settings.hook_offset_in_clip,
    hook_teaser_duration: settings.hook_teaser_duration,
  });
  const [stemsMatchKey, setStemsMatchKey] = useState('');
  const [playerDurationSec, setPlayerDurationSec] = useState(null);
  const [playerCurrentSec, setPlayerCurrentSec] = useState(0);
  const [previewVideoReady, setPreviewVideoReady] = useState(true);
  const [trimDragging, setTrimDragging] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const trimDraggingRef = useRef(false);
  const montageActiveKillRef = useRef(0);
  const montagePreviewSourceRef = useRef('');
  const optionsScrollRef = useRef(null);
  const optionsScrollTopRef = useRef(0);
  settingsRef.current = settings;

  const setTrimDrag = useCallback((active) => {
    trimDraggingRef.current = active;
    setTrimDragging(active);
    if (!active && needsServerPreview(settingsRef.current, highlight)) {
      queueMicrotask(() => triggerPreviewRef.current?.({ force: true }));
    }
  }, [highlight]);

  useEffect(() => {
    if (
      previewStems?.musicTrackId &&
      globalSettings.musicTrackId &&
      previewStems.musicTrackId !== globalSettings.musicTrackId
    ) {
      setPreviewStems(null);
    }
  }, [globalSettings.musicTrackId, previewStems?.musicTrackId]);

  const trimMatchesAnalyze = !trimChangedFromHighlight(settings, highlight);
  const isMontageClip = isMontageHighlight(highlight);
  const effectiveMontageSegments =
    isMontageClip && settings.montage_segments?.length
      ? settings.montage_segments
      : highlight.montage_segments || [];
  const montageOutputSec = isMontageClip
    ? Math.max(
        1,
        montageTotalSec(effectiveMontageSegments, getHighlightDisplayDuration(highlight)),
      )
    : getHighlightDisplayDuration(highlight);
  const liveMontagePreview =
    isMontageClip && Boolean(sourceVideoUrl) && !settings.cold_open;
  const clampedTrimEarly = clampTrimTimes(settings.start_time, settings.end_time, sourceDuration);
  const measuredAnalyzeSec = Number(highlight.clip_duration_measured);
  const analyzeFileMatchesTrim =
    !Number.isFinite(measuredAnalyzeSec) ||
    measuredAnalyzeSec <= 0.5 ||
    Math.abs(measuredAnalyzeSec - clampedTrimEarly.duration) <= 0.35;
  const analyzeVideoUrl =
    trimMatchesAnalyze && analyzeFileMatchesTrim && highlight.overviewUrl
      ? highlight.overviewUrl
      : null;
  const liveTrimPreview = canLiveTrimPreview(settings, highlight, sourceVideoUrl);
  const hookPeakInTrim = isHookPeakInTrim(highlight, settings.start_time, settings.end_time);
  const structuralKey = structuralSettingsKey(settings);
  const serverPreviewReady =
    videoSource === 'preview' &&
    Boolean(previewUrl) &&
    lastRenderedPreviewKeyRef.current === structuralKey &&
    !previewLoading;
  const useStemAudio =
    videoSource === 'preview' &&
    settings.music &&
    previewStems?.clientMix &&
    previewStems?.musicBedUrl &&
    stemsMatchKey === structuralKey &&
    !previewLoading &&
    !previewStems?.musicBaked;

  const primaryVideoUrl = settings.cold_open
    ? videoSource === 'preview' && previewUrl
      ? previewUrl
      : null
    : liveMontagePreview
      ? sourceVideoUrl
      : liveTrimPreview && (!serverPreviewReady || trimDragging)
        ? sourceVideoUrl
        : serverPreviewReady
          ? previewUrl
          : analyzeVideoUrl;

  const displayVideoUrl =
    primaryVideoUrl ||
    (previewLoading && lastDisplayUrlRef.current && !settings.cold_open
      ? lastDisplayUrlRef.current
      : null);

  useEffect(() => {
    if (primaryVideoUrl) {
      lastDisplayUrlRef.current = primaryVideoUrl;
    }
  }, [primaryVideoUrl]);

  useEffect(() => {
    if (liveMontagePreview) {
      setPlayerDurationSec(montageOutputSec);
      const sourceKey = `${sourceVideoUrl}|${settings.cold_open}`;
      if (montagePreviewSourceRef.current !== sourceKey) {
        montagePreviewSourceRef.current = sourceKey;
        setPlayerCurrentSec(0);
        montageActiveKillRef.current = 0;
      }
      setPreviewVideoReady(Boolean(sourceVideoUrl));
      return;
    }
    montagePreviewSourceRef.current = '';
    if (liveTrimPreview && !settings.cold_open) {
      const dur = Math.max(0.5, settings.end_time - settings.start_time);
      setPlayerDurationSec(dur);
      setPlayerCurrentSec(0);
      setPreviewVideoReady(Boolean(displayVideoUrl));
      return;
    }
    setPlayerDurationSec(null);
    setPlayerCurrentSec(0);
    setPreviewVideoReady(!displayVideoUrl);
  }, [
    displayVideoUrl,
    liveMontagePreview,
    liveTrimPreview,
    montageOutputSec,
    settings.start_time,
    settings.end_time,
    settings.cold_open,
    sourceVideoUrl,
  ]);

  useEffect(() => {
    if (!liveMontagePreview || settings.cold_open) return undefined;
    const video = videoRef.current;
    if (!video || !sourceVideoUrl) return undefined;

    const kills = effectiveMontageSegments.filter((s) => s.segment_type !== 'payoff');
    if (!kills.length) return undefined;

    const seekToMontageStart = () => {
      try {
        if (playerCurrentSecRef.current <= 0.05) {
          video.currentTime = kills[0].start;
          montageActiveKillRef.current = 0;
        }
      } catch {
        /* ignore */
      }
    };

    seekToMontageStart();
    video.addEventListener('loadedmetadata', seekToMontageStart);

    return () => {
      video.removeEventListener('loadedmetadata', seekToMontageStart);
    };
  }, [liveMontagePreview, sourceVideoUrl, settings.cold_open, effectiveMontageSegments]);

  const playerCurrentSecRef = useRef(0);
  playerCurrentSecRef.current = playerCurrentSec;

  useEffect(() => {
    if (!liveMontagePreview) return;
    const v = videoRef.current;
    if (!v) return;
    try {
      const outT = playerCurrentSecRef.current;
      const layout = buildOutputLayout(effectiveMontageSegments);
      const ki = outputTimeToSegmentIndex(layout, outT);
      montageActiveKillRef.current = ki >= 0 ? ki : 0;
      v.currentTime = sourceTimeFromOutput(effectiveMontageSegments, outT);
    } catch {
      /* ignore */
    }
  }, [effectiveMontageSegments, liveMontagePreview]);

  useEffect(() => {
    if (!liveTrimPreview || settings.cold_open || liveMontagePreview) return undefined;
    const video = videoRef.current;
    if (!video || !displayVideoUrl) return undefined;

    const start = settings.start_time;
    const end = settings.end_time;

    const seekToStart = () => {
      try {
        if (Math.abs(video.currentTime - start) > 0.15) {
          video.currentTime = start;
        }
      } catch {
        /* ignore */
      }
    };

    const onTimeUpdate = () => {
      if (video.currentTime >= end - 0.05) {
        try {
          video.currentTime = start;
        } catch {
          /* ignore */
        }
        if (!video.paused) {
          video.play().catch(() => {});
        }
      }
    };

    seekToStart();
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', seekToStart);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', seekToStart);
    };
  }, [
    liveTrimPreview,
    settings.start_time,
    settings.end_time,
    settings.cold_open,
    displayVideoUrl,
  ]);

  useLayoutEffect(() => {
    const el = optionsScrollRef.current;
    if (el && optionsScrollTopRef.current > 0) {
      el.scrollTop = optionsScrollTopRef.current;
      optionsScrollTopRef.current = 0;
    }
  });

  const update = (patch) => setSettings((s) => ({ ...s, ...patch }));

  const resetToRawView = useCallback(() => {
    setVideoSource('analyze');
    setPreviewUrl(null);
    setPreviewStems(null);
    setStemsMatchKey('');
    lastRenderedPreviewKeyRef.current = '';
  }, []);

  const triggerPreview = useCallback(async ({ force = false } = {}) => {
    const currentSettings = settingsRef.current;
    const previewKey = structuralSettingsKey(currentSettings);

    if (!force && previewKey === lastRenderedPreviewKeyRef.current && previewUrl) {
      return;
    }
    if (!force && previewInFlightKeyRef.current === previewKey) {
      return;
    }

    previewInFlightKeyRef.current = previewKey;
    setPreviewLoading(true);
    const cacheBust = Date.now();
    try {
      const payload = { ...toPreviewSettings(currentSettings), previewNonce: cacheBust };
      const data = await enqueuePreview(() =>
        previewClip({
          jobId,
          highlightId: highlight.id,
          settings: payload,
        }),
      );

      if (structuralSettingsKey(settingsRef.current) !== previewKey) {
        return;
      }

      const url = data.previewUrl;
      const withBust = url.includes('?') ? `${url}&t=${cacheBust}` : `${url}?t=${cacheBust}`;
      setPreviewVideoReady(false);
      setPreviewUrl(withBust);
      if (data.previewStems?.clientMix) {
        setPreviewStems(data.previewStems);
        setStemRev(cacheBust);
        setStemsMatchKey(previewKey);
      } else {
        setPreviewStems(null);
        setStemsMatchKey('');
      }
      const hookSec = Number(data.hookTeaserMeasuredSec);
      const requestedHook = Number(settingsRef.current.hook_teaser_duration);
      if (
        Number.isFinite(hookSec) &&
        hookSec > 0 &&
        (!Number.isFinite(requestedHook) || hookSec >= requestedHook * 0.45)
      ) {
        setHookMeasuredSec(hookSec);
      } else if (Number.isFinite(requestedHook) && requestedHook > 0) {
        setHookMeasuredSec(null);
      }
      const measured = Number(data.clipDurationMeasured);
      if (Number.isFinite(measured) && measured > 0.5) {
        setPlayerDurationSec(measured);
      } else if (Number.isFinite(Number(data.exportMainDurationSec))) {
        setPlayerDurationSec(Number(data.exportMainDurationSec));
      }
      const uiMain =
        currentSettings.end_time - currentSettings.start_time;
      if (
        uiMain > MAX_MAIN_SEC + 0.3 &&
        Number.isFinite(Number(data.effectiveStartTime)) &&
        Number.isFinite(Number(data.effectiveEndTime))
      ) {
        const eff = clampTrimTimes(
          data.effectiveStartTime,
          data.effectiveEndTime,
          sourceDuration,
        );
        setSettings((s) => ({ ...s, start_time: eff.start, end_time: eff.end }));
        onToast?.(`Ausschnitt auf ${MAX_MAIN_SEC} s für Shorts begrenzt.`, 'success');
      }
      if (data.musicBaked) {
        setPreviewStems(null);
        setStemsMatchKey('');
      }
      lastRenderedPreviewKeyRef.current = previewKey;
      setVideoSource('preview');
      setPreviewVideoReady(true);
    } catch (err) {
      if (err?.code === 'PREVIEW_SUPERSEDED') return;
      if (structuralSettingsKey(settingsRef.current) !== previewKey) return;
      console.error('[preview]', highlight.id, err);
      onToast?.(`Vorschau fehlgeschlagen: ${err?.message || 'Render-Fehler'}`, 'error');
    } finally {
      if (previewInFlightKeyRef.current === previewKey) {
        previewInFlightKeyRef.current = '';
      }
      setPreviewLoading(Boolean(previewInFlightKeyRef.current));
    }
  }, [jobId, highlight.id, onToast, previewUrl]);

  triggerPreviewRef.current = triggerPreview;

  useEffect(() => {
    lastRenderedPreviewKeyRef.current = '';
    previewInFlightKeyRef.current = '';
    setPreviewUrl(null);
    setPreviewStems(null);
    setStemsMatchKey('');
    setVideoSource('analyze');
  }, [jobId, highlight.id]);

  const applyTrimAroundHook = useCallback(
    (opts = {}) => {
      const anchored = buildTrimAroundHook(highlight, sourceDuration);
      const teaser = Number.isFinite(Number(highlight.hook_teaser_duration))
        ? Number(highlight.hook_teaser_duration)
        : 2.2;
      setSettings((s) => ({
        ...s,
        start_time: anchored.start,
        end_time: anchored.end,
        hook_offset_in_clip: anchored.hook_offset_in_clip,
        hook_peak_time: anchored.hook_peak_time,
        ...(opts.enableColdOpen
          ? {
              cold_open: true,
              showHook: Boolean(highlight.hook),
              hook_teaser_duration: Math.max(0.5, teaser),
            }
          : {}),
      }));
      lastRenderedPreviewKeyRef.current = '';
      if (opts.toast !== false) {
        onToast?.('Clip an Hook-Position angepasst', 'success');
      }
    },
    [highlight, sourceDuration, onToast],
  );

  useEffect(() => {
    if (!settings.cold_open) return undefined;
    if (hookPeakInTrim) return undefined;
    applyTrimAroundHook({ toast: true });
    return undefined;
  }, [
    settings.cold_open,
    settings.start_time,
    settings.end_time,
    hookPeakInTrim,
    applyTrimAroundHook,
  ]);

  const prevColdOpenRef = useRef(settings.cold_open);
  useEffect(() => {
    if (prevColdOpenRef.current === settings.cold_open) return undefined;
    const wasOn = prevColdOpenRef.current;
    prevColdOpenRef.current = settings.cold_open;
    lastRenderedPreviewKeyRef.current = '';
    setHookMeasuredSec(null);
    setPlayerDurationSec(null);
    setPreviewVideoReady(false);
    setPreviewStems(null);
    setStemsMatchKey('');

    if (wasOn && !settings.cold_open) {
      setPreviewUrl(null);
      setVideoSource('analyze');
      const video = videoRef.current;
      if (video) {
        video.pause();
        try {
          video.currentTime = 0;
        } catch {
          /* ignore */
        }
      }
    } else {
      setPreviewLoading(true);
    }

    return undefined;
  }, [settings.cold_open]);

  useEffect(() => {
    if (!settings.cold_open) return undefined;
    const main = Math.max(8, settings.end_time - settings.start_time);
    const clamped = clampHookOffsetInClip(main, settings.hook_offset_in_clip);
    if (Math.abs(clamped - settings.hook_offset_in_clip) < 0.05) return undefined;
    setSettings((s) => ({
      ...s,
      hook_offset_in_clip: clamped,
      hook_peak_time: s.start_time + clamped,
    }));
    return undefined;
  }, [settings.cold_open, settings.start_time, settings.end_time, settings.hook_offset_in_clip]);

  useEffect(() => {
    const current = settingsRef.current;
    if (trimDraggingRef.current) return undefined;

    if (!needsServerPreview(current, highlight)) {
      if (!previewInFlightKeyRef.current) {
        setPreviewLoading(false);
      }
      return undefined;
    }

    const previewKey = structuralSettingsKey(current);
    if (previewKey === lastRenderedPreviewKeyRef.current) {
      return undefined;
    }
    if (previewKey === previewInFlightKeyRef.current) {
      return undefined;
    }

    setStemsMatchKey('');

    const prevHook = prevHookVisualRef.current;
    const hookPeakMoved =
      current.cold_open &&
      (Math.abs((Number(prevHook.hook_offset_in_clip) || 0) - (Number(current.hook_offset_in_clip) || 0)) >=
        0.01 ||
        Math.abs(
          (Number(prevHook.hook_teaser_duration) || 0) - (Number(current.hook_teaser_duration) || 0),
        ) >= 0.05);
    prevHookVisualRef.current = {
      hook_offset_in_clip: current.hook_offset_in_clip,
      hook_teaser_duration: current.hook_teaser_duration,
    };
    const hookTweak =
      current.cold_open ||
      current.showHook ||
      (Number(current.hook_teaser_duration) || 0) >= 0.5;
    const debounceMs = hookPeakMoved ? 150 : hookTweak ? 120 : 200;
    const timer = setTimeout(() => {
      triggerPreviewRef.current?.({ force: true });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [
    structuralKey,
    settings.start_time,
    settings.end_time,
    settings.hook_teaser_duration,
    settings.hook_offset_in_clip,
    settings.cold_open,
    settings.showHook,
    settings.aspectRatio,
    settings.wideOverlay,
    settings.captions,
    settings.caption_style,
    settings.colorGrade,
    settings.ctaText,
    settings.aiStrength,
    settings.musicTrackId,
    settings.music,
    settings.musicAuto,
    settings.webcam?.enabled,
    settings.webcam?.selection,
    settings.webcam?.pip,
    settings.wideOverlayRegion?.selection,
    settings.wideOverlayRegion?.pip,
    highlight.start_time,
    highlight.end_time,
    trimDragging,
    videoSource,
    previewUrl,
  ]);

  const musicVolRef = useRef(settings.musicVolume);
  useEffect(() => {
    if (!settings.music) return undefined;
    const vol = settings.musicVolume ?? 15;
    if (vol === musicVolRef.current) return undefined;
    musicVolRef.current = vol;

    if (useStemAudio) {
      return undefined;
    }
    if (!shouldAutoPreview(settingsRef.current, highlight)) {
      return undefined;
    }

    const timer = setTimeout(() => {
      triggerPreviewRef.current?.();
    }, 600);

    return () => clearTimeout(timer);
  }, [settings.musicVolume, useStemAudio, settings.music, highlight, resetToRawView]);

  const musicOnRef = useRef(settings.music);
  useEffect(() => {
    if (settings.music === musicOnRef.current) return undefined;
    const wasOff = !musicOnRef.current;
    musicOnRef.current = settings.music;

    if (!settings.music) {
      if (!hasPreviewEffects(settingsRef.current)) {
        resetToRawView();
      }
      return undefined;
    }

    if (wasOff && shouldAutoPreview(settingsRef.current, highlight)) {
      const timer = setTimeout(() => {
        triggerPreviewRef.current?.();
      }, 600);
      return () => clearTimeout(timer);
    }

    return undefined;
  }, [settings.music, highlight, resetToRawView]);

  useEffect(() => {
    const audio = musicAudioRef.current;
    if (!audio || !previewStems?.clientMix || !settings.music) return;
    audio.volume = Math.min(0.4, (Number(settings.musicVolume) || 15) / 100);
  }, [settings.musicVolume, settings.music, previewStems?.clientMix]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = musicAudioRef.current;
    if (!video || !audio || !useStemAudio) return undefined;

    const hookSec = Number(previewStems.musicStartSec) || 0;
    const offsetSec = Number(previewStems.musicOffsetSec) || 0;

    const syncMusic = () => {
      const t = video.currentTime;
      if (t < hookSec) {
        audio.pause();
        return;
      }
      const target = Math.max(0, t - hookSec + offsetSec);
      if (Math.abs(audio.currentTime - target) > 0.25) {
        audio.currentTime = target;
      }
      if (video.paused) {
        audio.pause();
      } else if (audio.paused) {
        audio.play().catch(() => {});
      }
    };

    const onPlay = () => {
      audio.volume = Math.min(0.4, (Number(settings.musicVolume) || 15) / 100);
      syncMusic();
    };

    video.addEventListener('timeupdate', syncMusic);
    video.addEventListener('play', onPlay);
    video.addEventListener('seeking', syncMusic);
    video.addEventListener('pause', () => audio.pause());

    return () => {
      video.removeEventListener('timeupdate', syncMusic);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('seeking', syncMusic);
      video.removeEventListener('pause', () => audio.pause());
    };
  }, [
    useStemAudio,
    previewStems?.musicStartSec,
    previewStems?.musicOffsetSec,
    settings.musicVolume,
  ]);

  const handleProcess = async () => {
    setProcessing(true);
    try {
      const { jobId: clipJobId } = await processClip({
        jobId,
        highlightId: highlight.id,
        settings: {
          ...globalSettings,
          ...toPreviewSettings(settings),
          aspectRatio: settings.aspectRatio || '9:16',
          gameplayFraming: normalizeGameplayFramingMode(settingsRef.current.gameplayFraming),
          title: highlight.title,
        },
      });
      const job = await pollJob(clipJobId, 1200);
      const url = job.result?.downloadUrl;
      setDownloadUrl(url);
      onClipReady?.(highlight.id, url);
      onToast?.('Clip ready!', 'success');
    } catch (e) {
      const msg = e?.message || 'Clip processing failed';
      console.error('[Download Clip]', msg, e?.stack);
      onToast?.(msg, 'error');
    } finally {
      setProcessing(false);
    }
  };

  const copyScript = async () => {
    await navigator.clipboard.writeText(buildScript(highlight, settings.ctaText));
    onToast?.('Script copied', 'success');
  };

  const montageKillCount =
    highlight.montage_kill_count || effectiveMontageSegments.filter((s) => s.segment_type !== 'payoff').length || 0;
  const showDebugMontage = isDebugUiEnabled();

  const clampedTrim = clampTrimTimes(settings.start_time, settings.end_time, sourceDuration);
  const mainDuration = isMontageClip ? montageOutputSec : clampedTrim.duration;
  const trimWasClamped =
    Math.abs(clampedTrim.start - settings.start_time) > 0.2 ||
    Math.abs(clampedTrim.end - settings.end_time) > 0.2;
  const hookSec =
    settings.cold_open && settings.hook_teaser_duration >= 0.5
      ? hookMeasuredSec ?? settings.hook_teaser_duration
      : 0;
  const clipTotalSec = mainDuration + hookSec;
  const previewSynced =
    videoSource === 'preview' &&
    lastRenderedPreviewKeyRef.current === structuralKey &&
    !previewLoading;
  const hookInPreviewFile =
    settings.cold_open &&
    hookSec >= 0.3 &&
    previewSynced &&
    playerDurationSec != null &&
    Math.abs(playerDurationSec - clipTotalSec) <= 0.6;
  const durationMismatch =
    previewSynced &&
    previewVideoReady &&
    !previewLoading &&
    settings.cold_open &&
    hookSec >= 0.3 &&
    playerDurationSec != null &&
    Math.abs(playerDurationSec - clipTotalSec) > 0.6;
  const playerTotalSec =
    hookInPreviewFile && playerDurationSec != null ? playerDurationSec : mainDuration;
  const canUpdatePreview = !previewLoading;

  const handleTrimChange = ({ start, end }) => {
    if (optionsScrollRef.current) {
      optionsScrollTopRef.current = optionsScrollRef.current.scrollTop;
    }
    const c = clampTrimTimes(start, end, sourceDuration);
    const next = { ...settingsRef.current, start_time: c.start, end_time: c.end };
    if (needsServerPreview(next, highlight)) {
      lastRenderedPreviewKeyRef.current = '';
    }
    update({ start_time: c.start, end_time: c.end });
    if (canLiveTrimPreview(next, highlight, sourceVideoUrl)) {
      setPreviewLoading(false);
      const v = videoRef.current;
      if (v) {
        try {
          v.currentTime = c.start;
        } catch {
          /* ignore */
        }
      }
    }
  };

  const overlayThumbUrl = highlight.thumbnailUrl || null;
  const overlayVideoUrl = sourceVideoUrl || null;
  const overlaySeekSec = settings.start_time;
  const clipPreviewUrl =
    videoSource === 'preview' && previewUrl ? previewUrl : highlight.overviewUrl || null;
  const gameplayFramingMode = normalizeGameplayFramingMode(settings.gameplayFraming);
  const framingSources = resolveFramingClipSources(highlight, jobId);
  const framingVideoUrl =
    liveMontagePreview && sourceVideoUrl ? sourceVideoUrl : framingSources.primaryUrl;
  const useClientFraming =
    isGameplayFramingAvailable(settings.aspectRatio, sourceWidth, sourceHeight) &&
    Boolean(framingVideoUrl) &&
    !liveTrimPreview &&
    !settings.cold_open;
  const trimMin = Math.max(0, highlight.start_time - 30);
  const trimMax =
    sourceDuration > 0
      ? Math.min(sourceDuration, highlight.end_time + 30)
      : highlight.end_time + 30;

  const editorSections = [
    {
      id: 'clip',
      step: 1,
      title: 'Clip',
      subtitle: 'Welcher Ausschnitt aus dem Video?',
      children: (
        <>
          {isMontageClip ? (
            <MontageInfoPanel
              highlight={highlight}
              killCount={montageKillCount}
              outputSec={montageOutputSec}
              debugKillExport={debugKillExport}
              showDebug={showDebugMontage}
            />
          ) : (
            <p className="text-sm text-theme-muted leading-relaxed">
              Ausschnitt auf der <span className="text-theme">Timeline unten</span> mit den Griffen
              setzen — linker Griff = Start, rechter = Ende. Am Playhead schneiden mit dem
              Scheren-Icon.
            </p>
          )}
          <div className="min-h-[3.25rem] space-y-1">
            {trimWasClamped && !isMontageClip ? (
              <p className="text-sm text-amber-400/90">
                Shorts-Maximum: Hauptteil auf max. {MAX_MAIN_SEC} s begrenzt (Server-Export).
              </p>
            ) : null}
            {hookSec >= 0.3 ? (
              <p className="text-sm text-theme-muted">
                Mit Hook:{' '}
                <span className="text-peak-purple tabular-nums">{clipTotalSec.toFixed(1)} s</span>{' '}
                gesamt ({mainDuration.toFixed(1)} s Hauptteil + {hookSec.toFixed(1)} s Hook)
              </p>
            ) : null}
            {durationMismatch ? (
              <p className="text-sm text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                Vorschau ({playerDurationSec.toFixed(1)} s) enthält den Hook noch nicht — erwartet{' '}
                {clipTotalSec.toFixed(1)} s. „Vorschau aktualisieren“.
              </p>
            ) : null}
            {previewLoading &&
            trimChangedFromHighlight(settings, highlight) &&
            needsServerPreview(settings, highlight) ? (
              <p className="text-sm text-peak-purple/90">Effekte werden gerendert…</p>
            ) : null}
          </div>
        </>
      ),
    },
    {
      id: 'hook',
      step: 2,
      title: 'Hook',
      subtitle: 'Kurzer Einstieg — Scroll-Stopper vor dem Hauptclip',
      children: (
        <>
          <p className="text-sm text-theme-muted">
            Standard aus — kein Einstieg vor dem Hauptclip. Erst nach Aktivierung wird der Hook
            analysiert und eingefügt.
          </p>
          {!hookPeakInTrim && (
            <div className="text-sm text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 space-y-2">
              <p>
                Der beste Hook liegt bei{' '}
                <span className="font-medium tabular-nums">
                  {formatTime(resolveHookPeakTime(highlight))}
                </span>{' '}
                — außerhalb deines Ausschnitts (
                {formatTime(settings.start_time)}–{formatTime(settings.end_time)}).
              </p>
              <button
                type="button"
                onClick={() => applyTrimAroundHook({ toast: true })}
                className="peak-btn-primary !py-1.5 !px-3 !text-xs"
              >
                Clip an Hook anpassen
              </button>
            </div>
          )}
          <Toggle
            label="Intelligenter Cold-open"
            checked={settings.cold_open}
            onChange={(v) => {
              if (!v) {
                update({
                  cold_open: false,
                  showHook: false,
                  hook_teaser_duration: 0,
                  hook_peak_time: undefined,
                });
                return;
              }
              if (!hookPeakInTrim) {
                setPreviewLoading(true);
                applyTrimAroundHook({ enableColdOpen: true, toast: true });
                return;
              }
              const teaser = Number.isFinite(Number(highlight.hook_teaser_duration))
                ? Number(highlight.hook_teaser_duration)
                : 2.2;
              const off = defaultHookOffset(
                highlight,
                settings.start_time,
                settings.end_time,
              );
              setPreviewLoading(true);
              update({
                cold_open: true,
                showHook: Boolean(highlight.hook),
                hook_teaser_duration: Math.max(0.5, teaser),
                hook_offset_in_clip: off,
                hook_peak_time: settings.start_time + off,
              });
            }}
          />
          {settings.cold_open && highlight.hook && (
            <p className="text-sm text-theme-muted peak-subpanel rounded-lg px-3 py-2">
              <span className="type-label block mb-1">
                Cliffhanger-Text
              </span>
              {highlight.hook}
            </p>
          )}
          {settings.cold_open && (
            <>
              <div className="space-y-1">
                <div className="flex justify-between text-sm text-theme-muted">
                  <span>Hook-Länge</span>
                  <span>
                    {settings.hook_teaser_duration.toFixed(1)} s
                    {hookMeasuredSec != null &&
                      Math.abs(hookMeasuredSec - settings.hook_teaser_duration) > 0.12 && (
                        <span className="text-amber-400/90" title="Vorschau wird neu gerendert oder Spannungs-Moment anpassen">
                          {' '}
                          → {hookMeasuredSec.toFixed(1)} s im Video
                        </span>
                      )}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={4}
                  step={0.1}
                  value={settings.hook_teaser_duration}
                  onChange={(e) => {
                    setHookMeasuredSec(null);
                    update({ hook_teaser_duration: Number(e.target.value) });
                  }}
                  className="w-full accent-violet-500"
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-sm text-theme-muted">
                  <span>Spannungs-Moment im Clip</span>
                  <span className="tabular-nums text-right">
                    {formatTime(settings.start_time + settings.hook_offset_in_clip)} (
                    +{settings.hook_offset_in_clip.toFixed(1)} s)
                  </span>
                </div>
                <input
                  type="range"
                  min={minColdOpenPeakOffset(mainDuration)}
                  max={Math.max(minColdOpenPeakOffset(mainDuration) + 1, mainDuration - 0.5)}
                  step={0.25}
                  value={clampHookOffsetInClip(mainDuration, settings.hook_offset_in_clip)}
                  onChange={(e) => {
                    const off = clampHookOffsetInClip(mainDuration, Number(e.target.value));
                    setHookMeasuredSec(null);
                    update({
                      hook_offset_in_clip: off,
                      hook_peak_time: settings.start_time + off,
                    });
                  }}
                  className="w-full accent-violet-500"
                />
                <p className="text-2xs text-theme-muted">
                  Frühestens ab {minColdOpenPeakOffset(mainDuration).toFixed(0)} s im Clip (Spannungsaufbau).
                </p>
              </div>
              <Toggle
                label="Hook-Text als Overlay einblenden"
                checked={settings.showHook}
                onChange={(v) => update({ showHook: v })}
              />
            </>
          )}
        </>
      ),
    },
    {
      id: 'look',
      step: 3,
      title: 'Bild',
      subtitle: 'Format und Look für Shorts',
      children: (
        <>
          <div>
            <span className="text-sm text-theme-muted block mb-2">Seitenverhältnis</span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {['9:16', '1:1', '16:9'].map((ar) => (
                <button
                  key={ar}
                  type="button"
                  onClick={() => {
                    update({ aspectRatio: ar });
                    setGlobalAspectRatio?.(ar);
                  }}
                  className={`text-left px-3 py-2.5 rounded-xl border text-base ${
                    settings.aspectRatio === ar ? 'peak-option-active' : 'peak-option'
                  }`}
                >
                  <span className="font-medium">{ar}</span>
                  <span className="block text-sm text-theme-muted mt-0.5">{ASPECT_LABELS[ar]}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="flex justify-between text-sm text-theme-muted mb-1">
              <span>KI-Stärke (Effekte)</span>
              <span>{settings.aiStrength ?? 75}%</span>
            </div>
            <input
              type="range"
              min={25}
              max={100}
              value={settings.aiStrength ?? 75}
              onChange={(e) => update({ aiStrength: Number(e.target.value) })}
              className="w-full accent-violet-500"
            />
          </div>
          <Toggle label="Farb-Look (Kontrast & Sättigung)" checked={settings.colorGrade} onChange={(v) => update({ colorGrade: v })} />
          <p className="text-sm text-theme-muted">
            KI-Stärke skaliert die Intensität des Farb-Looks in der Vorschau.
          </p>
        </>
      ),
    },
    {
      id: 'overlays',
      step: 4,
      title: 'Overlays',
      subtitle: 'Webcam & Gaming-UI — optional',
      children: (
        <>
          <div className="rounded-xl border-2 border-violet-500/35 bg-violet-500/[0.07] p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-peak-purple">Wide-UI / Menü-Bereich</p>
                <p className="text-sm text-theme-muted mt-0.5">
                  Für Landscape-Gaming: Spielbereich oben, UI unten (9:16 Shorts).
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.wideOverlay}
                onClick={() => {
                  const v = !settings.wideOverlay;
                  const sw = sourceWidth || 1920;
                  const sh = sourceHeight || 1080;
                  const sel =
                    settings.wideOverlayRegion?.selection?.width > 0
                      ? settings.wideOverlayRegion.selection
                      : defaultWideSelection(sw, sh);
                  update({
                    wideOverlay: v,
                    wideOverlayRegion: {
                      ...settings.wideOverlayRegion,
                      enabled: v,
                      selection: v ? sel : settings.wideOverlayRegion?.selection,
                      sourceWidth: sw,
                      sourceHeight: sh,
                      startOffset: settings.wideOverlayRegion?.startOffset ?? 0,
                      endOffset: settings.wideOverlayRegion?.endOffset ?? mainDuration,
                    },
                  });
                }}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                  settings.wideOverlay ? 'bg-peak-purple' : 'bg-theme-surface border border-theme'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                    settings.wideOverlay ? 'translate-x-5' : ''
                  }`}
                />
              </button>
            </div>
            {settings.wideOverlay && (
              <WideOverlaySelector
                imageUrl={overlayThumbUrl}
                videoUrl={overlayVideoUrl}
                seekSec={overlaySeekSec}
                clipPreviewUrl={clipPreviewUrl}
                sourceWidth={sourceWidth || settings.wideOverlayRegion.sourceWidth}
                sourceHeight={sourceHeight || settings.wideOverlayRegion.sourceHeight}
                clipDuration={mainDuration}
                value={settings.wideOverlayRegion}
                onChange={(wideOverlayRegion) => update({ wideOverlayRegion })}
              />
            )}
          </div>

          <div className="peak-subpanel p-3 space-y-2">
            <Toggle
              label="Webcam einblenden"
              checked={settings.webcam.enabled}
              onChange={(v) => {
                const sw = sourceWidth || 1920;
                const sh = sourceHeight || 1080;
                update({
                  webcam: {
                    ...settings.webcam,
                    enabled: v,
                    sourceWidth: sw,
                    sourceHeight: sh,
                  },
                });
              }}
            />
            {settings.webcam.enabled && (
              <WebcamSelector
                imageUrl={overlayThumbUrl}
                videoUrl={overlayVideoUrl}
                seekSec={overlaySeekSec}
                clipPreviewUrl={clipPreviewUrl}
                sourceWidth={sourceWidth || settings.webcam.sourceWidth}
                sourceHeight={sourceHeight || settings.webcam.sourceHeight}
                value={settings.webcam}
                onChange={(webcam) => update({ webcam })}
              />
            )}
            {settings.webcam.enabled && !settings.webcam?.selection?.width && (
              <p className="text-sm text-amber-400/90">
                Bereich im Bild markieren — sonst erscheint die Webcam nicht in der Vorschau.
              </p>
            )}
          </div>
        </>
      ),
    },
    {
      id: 'music',
      step: 5,
      title: 'Musik',
      subtitle: 'Hintergrundmusik — im Hook nur Originalton',
      children: (
        <>
          <Toggle label="Hintergrundmusik" checked={settings.music} onChange={(v) => update({ music: v })} />
          {settings.music && (
            <>
              <div>
                <span className="text-sm text-theme-muted block mb-2">Musik-Stimmung</span>
                <div className="flex flex-wrap gap-2">
                  {MOODS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        onMoodChange?.(m.id);
                        update({ musicAuto: true });
                      }}
                      className={`px-3 py-2 rounded-xl text-sm border ${
                        mood === m.id ? 'peak-option-active' : 'peak-option'
                      }`}
                    >
                      {m.emoji} {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  onClick={() => {
                    onMusicAuto?.();
                    update({ musicAuto: true });
                  }}
                  className={`text-sm px-3 py-1.5 rounded-lg border ${
                    settings.musicAuto !== false ? 'peak-option-active' : 'peak-option'
                  }`}
                >
                  Auto pro Clip
                </button>
                {[1, 2, 3].map((n) => {
                  const id = `${mood || 'hype'}-${n}`;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => {
                        onMusicTrackPick?.(id);
                        update({ musicTrackId: id, musicAuto: false });
                      }}
                      className={`text-sm px-3 py-1.5 rounded-lg border ${
                        settings.musicAuto === false && settings.musicTrackId === id
                          ? 'peak-option-active'
                          : 'peak-option'
                      }`}
                    >
                      Track {n}
                    </button>
                  );
                })}
              </div>
              <div>
                <div className="flex justify-between text-sm text-theme-muted mb-1">
                  <span>Lautstärke</span>
                  <span>{settings.musicVolume ?? 15} %</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={settings.musicVolume ?? 15}
                  onChange={(e) => update({ musicVolume: Number(e.target.value) })}
                  className="w-full accent-violet-500"
                />
              </div>
              <label className="flex flex-col gap-1 text-sm text-theme-muted cursor-pointer">
                <input type="file" accept="audio/*" className="hidden" onChange={onCustomMusic} />
                <span className="border border-dashed border-theme rounded-lg px-3 py-2 text-center hover:border-peak-purple/40">
                  Eigene Musik hochladen
                </span>
                {customMusicName && (
                  <span className="text-peak-purple truncate">{customMusicName}</span>
                )}
              </label>
              {settings.music && (
                <p className="text-sm text-theme-muted">
                  Nach „Vorschau aktualisieren“ ist Musik im Vorschau-Video hörbar (nicht nur im
                  Export).
                </p>
              )}
              <p className="text-sm text-theme-muted">Musik startet nach dem Hook.</p>
            </>
          )}
        </>
      ),
    },
    {
      id: 'captions',
      step: 6,
      title: 'Untertitel',
      subtitle: 'Lesbarkeit & Abschluss — zuletzt feintunen',
      children: (
        <>
          <Toggle label="Wort-Untertitel (aus Sprache)" checked={settings.captions} onChange={(v) => update({ captions: v })} />
          {settings.captions && (
            <div>
              <span className="text-sm text-theme-muted block mb-2">Stil</span>
              <div className="flex flex-col gap-2">
                {CAPTION_STYLES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => update({ caption_style: s.id })}
                    className={`text-left px-3 py-2 rounded-lg border text-sm ${
                      settings.caption_style === s.id
                        ? 'peak-option-active'
                        : 'peak-option hover:border-peak-purple/30'
                    }`}
                  >
                    <span className="font-medium">{s.label}</span>
                    <span className="block text-sm text-theme-muted">{s.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="text-sm text-theme-muted block mb-1">CTA am Ende (optional)</label>
            <input
              type="text"
              value={settings.ctaText}
              onChange={(e) => update({ ctaText: e.target.value })}
              placeholder="z. B. Follow for more"
              className="w-full peak-input !rounded-lg !py-2 !text-sm"
            />
          </div>
        </>
      ),
    },
  ];

  const lookSection = editorSections.find((s) => s.id === 'look');
  const musicSection = editorSections.find((s) => s.id === 'music');
  const sheetSections = isMontageClip
    ? [
        {
          id: 'clip',
          step: 1,
          title: 'Clip',
          subtitle: 'Kill-Montage & Segmente',
          children: (
            <MontageInfoPanel
              highlight={highlight}
              killCount={montageKillCount}
              outputSec={montageOutputSec}
              debugKillExport={debugKillExport}
              showDebug={showDebugMontage}
            />
          ),
        },
        lookSection
          ? { ...lookSection, step: 2, title: 'Look', subtitle: 'Format & Farb-Look' }
          : null,
        musicSection
          ? { ...musicSection, step: 3, title: 'Musik', subtitle: musicSection.subtitle }
          : null,
      ].filter(Boolean)
    : editorSections;

  const montageLayout = isMontageClip ? buildOutputLayout(effectiveMontageSegments) : [];
  const activeKillIndex = isMontageClip
    ? outputTimeToSegmentIndex(montageLayout, playerCurrentSec)
    : -1;

  const handleKillSeek = useCallback(
    (sec) => {
      const v = videoRef.current;
      if (!v) return;
      try {
        v.pause();
        if (liveMontagePreview) {
          const layout = buildOutputLayout(effectiveMontageSegments);
          const ki = outputTimeToSegmentIndex(layout, sec);
          montageActiveKillRef.current = ki >= 0 ? ki : 0;
          const sourceT = sourceTimeFromOutput(effectiveMontageSegments, sec);
          v.currentTime = sourceT;
          setPlayerCurrentSec(sec);
          return;
        }
        v.currentTime = Math.max(0, sec);
      } catch {
        /* ignore */
      }
    },
    [effectiveMontageSegments, liveMontagePreview],
  );

  const timelineTotalSec = isMontageClip ? montageOutputSec : Math.max(1, trimMax - trimMin);
  const timelineCurrentSec = isMontageClip
    ? playerCurrentSec
    : Math.max(
        0,
        Math.min(
          timelineTotalSec,
          (liveTrimPreview ? settings.start_time + playerCurrentSec : settings.start_time) - trimMin,
        ),
      );

  const handleTimelineSeek = useCallback(
    (t) => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(t)) return;
      if (isMontageClip) {
        handleKillSeek(t);
        return;
      }
      const sourceT = trimMin + t;
      try {
        v.pause();
        if (liveTrimPreview) {
          v.currentTime = Math.max(settings.start_time, Math.min(settings.end_time, sourceT));
        } else {
          v.currentTime = Math.max(0, sourceT - settings.start_time);
        }
      } catch {
        /* ignore */
      }
    },
    [
      handleKillSeek,
      isMontageClip,
      liveTrimPreview,
      settings.end_time,
      settings.start_time,
      trimMin,
    ],
  );

  const handlePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const handleSkipBack = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = Math.max(0, v.currentTime - 2);
    } catch {
      /* ignore */
    }
  }, []);

  const handleSkipForward = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = Math.min(v.duration || timelineTotalSec, v.currentTime + 2);
    } catch {
      /* ignore */
    }
  }, [timelineTotalSec]);

  const handleSplitAtPlayhead = useCallback(() => {
    if (isMontageClip) {
      const segs = effectiveMontageSegments;
      const layout = buildOutputLayout(segs);
      const ki = outputTimeToSegmentIndex(layout, playerCurrentSec);
      if (ki < 0) return;
      const row = layout[ki];
      const newDur = Math.max(1.15, playerCurrentSec - row.outStart + 0.05);
      const next = resizeSegmentEnd(segs, ki, newDur, { sourceDuration });
      update({ montage_segments: next });
      onToast?.(`Kill ${ki + 1} gekürzt`, 'success');
      return;
    }
    const minClip = 8;
    const cutAt = liveTrimPreview
      ? settings.start_time + playerCurrentSec
      : settings.start_time + Math.min(mainDuration, playerCurrentSec);
    if (cutAt > settings.start_time + minClip && cutAt < settings.end_time - 2) {
      update({ end_time: cutAt });
      onToast?.('Clip am Playhead gekürzt', 'success');
    }
  }, [
    isMontageClip,
    effectiveMontageSegments,
    playerCurrentSec,
    sourceDuration,
    liveTrimPreview,
    settings.start_time,
    settings.end_time,
    mainDuration,
    update,
    onToast,
  ]);

  const handleMontageSegmentsChange = useCallback(
    (segments) => {
      update({ montage_segments: segments });
      lastRenderedPreviewKeyRef.current = '';
    },
    [update],
  );

  const handleSetIn = useCallback(() => {
    const sourceT = trimMin + timelineCurrentSec;
    const c = clampTrimTimes(sourceT, settings.end_time, sourceDuration);
    update({ start_time: c.start, end_time: c.end });
  }, [timelineCurrentSec, trimMin, settings.end_time, sourceDuration, update]);

  const handleSetOut = useCallback(() => {
    const sourceT = trimMin + timelineCurrentSec;
    const c = clampTrimTimes(settings.start_time, sourceT, sourceDuration);
    update({ start_time: c.start, end_time: c.end });
  }, [timelineCurrentSec, trimMin, settings.start_time, sourceDuration, update]);

  const musicLabel =
    settings.musicAuto !== false
      ? `${MOODS.find((m) => m.id === mood)?.label || mood || 'Auto'}`
      : musicTrack || settings.musicTrackId || 'Musik';

  const showFramingVideo = useClientFraming
    ? Boolean(framingSources.primaryUrl)
    : Boolean(displayVideoUrl);

  const onVideoLoadedMetadata = (e) => {
    const v = e.currentTarget;
    if (liveMontagePreview) {
      setPlayerDurationSec(montageOutputSec);
      const kills = effectiveMontageSegments.filter((s) => s.segment_type !== 'payoff');
      if (kills.length) {
        try {
          v.currentTime = kills[0].start;
        } catch {
          /* ignore */
        }
      }
      montageActiveKillRef.current = 0;
      setPlayerCurrentSec(0);
      return;
    }
    if (liveTrimPreview) {
      const dur = Math.max(0.5, settings.end_time - settings.start_time);
      setPlayerDurationSec(dur);
      try {
        v.currentTime = settings.start_time;
      } catch {
        /* ignore */
      }
      return;
    }
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    setPlayerDurationSec(d);
  };

  const onVideoTimeUpdate = (e) => {
    const v = e.currentTarget;
    if (liveMontagePreview) {
      const outT = advanceMontagePlayback(v, effectiveMontageSegments, montageActiveKillRef);
      setPlayerCurrentSec(outT);
      return;
    }
    if (liveTrimPreview) {
      setPlayerCurrentSec(
        Math.max(0, Math.min(mainDuration, v.currentTime - settings.start_time)),
      );
      return;
    }
    const t = v.currentTime;
    if (Number.isFinite(t)) setPlayerCurrentSec(t);
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    setIsPlaying(!v.paused);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, [showFramingVideo, displayVideoUrl, gameplayFramingMode, videoSource, previewUrl]);

  const framingBadge = showFramingVideo ? (
    <span
      className={`editor-framing-badge ${
        useClientFraming
          ? 'editor-framing-badge--live'
          : videoSource === 'preview'
            ? 'editor-framing-badge--preview'
            : liveTrimPreview
              ? 'editor-framing-badge--trim'
              : 'editor-framing-badge--raw'
      }`}
    >
      {useClientFraming
        ? getGameplayFramingLabel(gameplayFramingMode)
        : videoSource === 'preview'
          ? 'Vorschau'
          : liveMontagePreview
            ? 'Live'
            : liveTrimPreview
              ? 'Live'
              : 'Rohclip'}
    </span>
  ) : null;

  const peakScoreBadge =
    highlight.viral_score > 0 ? (
      <span className={`editor-peak-badge ${viralColor(highlight.viral_score)}`}>
        Peak {highlight.viral_score}
      </span>
    ) : null;

  const videoPanel = (
    <PreviewChrome
      aspectRatio={settings.aspectRatio}
      badge={framingBadge}
      topLeft={peakScoreBadge}
    >
        {showFramingVideo ? (
          <>
            {useClientFraming ? (
              <GameplayFramingPreview
                src={framingVideoUrl}
                fallbackSrc={framingSources.fallbackUrl}
                mode={gameplayFramingMode}
                videoRef={videoRef}
                sourceAspectFallback={
                  liveMontagePreview || framingSources.isRaw
                    ? (sourceWidth || 1920) / (sourceHeight || 1080)
                    : 9 / 16
                }
                onLoadedMetadata={onVideoLoadedMetadata}
                onTimeUpdate={onVideoTimeUpdate}
                onCanPlay={() => setPreviewVideoReady(true)}
              >
                <ClipPreviewControls
                  videoRef={videoRef}
                  mediaKey={`${framingVideoUrl}|${gameplayFramingMode}|${montageOutputSec}`}
                  mode={liveMontagePreview ? 'montage' : 'file'}
                  startTime={settings.start_time}
                  endTime={settings.end_time}
                  totalSec={liveMontagePreview ? montageOutputSec : playerDurationSec ?? clipTotalSec}
                  outputCurrentSec={playerCurrentSec}
                  onSeekOutput={handleTimelineSeek}
                />
                {useStemAudio && (
                  <audio
                    ref={musicAudioRef}
                    src={previewStems.musicBedUrl}
                    preload="auto"
                    loop
                    className="hidden"
                  />
                )}
              </GameplayFramingPreview>
            ) : (
              <>
                <video
                  key={
                    liveMontagePreview
                      ? `montage-source-${highlight.id}`
                      : liveTrimPreview
                        ? `live-source-${highlight.id}`
                        : displayVideoUrl || `${highlight.id}-${videoSource}-empty`
                  }
                  ref={videoRef}
                  src={displayVideoUrl}
                  playsInline
                  className={previewVideoClass(settings.aspectRatio)}
                  onLoadedMetadata={onVideoLoadedMetadata}
                  onTimeUpdate={onVideoTimeUpdate}
                  onCanPlay={() => setPreviewVideoReady(true)}
                />
                <ClipPreviewControls
                  videoRef={videoRef}
                  mode={liveMontagePreview ? 'montage' : liveTrimPreview ? 'live' : 'file'}
                  startTime={settings.start_time}
                  endTime={settings.end_time}
                  totalSec={
                    liveMontagePreview
                      ? montageOutputSec
                      : liveTrimPreview
                        ? mainDuration
                        : playerDurationSec ?? clipTotalSec
                  }
                  outputCurrentSec={playerCurrentSec}
                  onSeekOutput={liveMontagePreview ? handleTimelineSeek : undefined}
                />
                {useStemAudio && (
                  <audio
                    ref={musicAudioRef}
                    src={previewStems.musicBedUrl}
                    preload="auto"
                    loop
                    className="hidden"
                  />
                )}
              </>
            )}
          </>
        ) : previewLoading ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-6 text-center bg-theme-elevated">
            {highlight.thumbnailUrl ? (
              <img
                src={highlight.thumbnailUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover opacity-30"
              />
            ) : null}
            <p className="relative text-sm text-theme">
              {settings.cold_open ? 'Hook-Vorschau wird erstellt…' : 'Vorschau wird erstellt…'}
            </p>
            <p className="relative text-sm text-theme-muted">Bitte kurz warten</p>
          </div>
        ) : !trimMatchesAnalyze ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-6 text-center bg-theme-elevated">
            <p className="text-sm text-theme-muted">Ausschnitt geändert</p>
            <p className="text-sm text-theme-muted">
              Vorschau wird automatisch erstellt oder „Vorschau aktualisieren“ nutzen.
            </p>
          </div>
        ) : highlight.thumbnailUrl ? (
          <img src={highlight.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-theme-elevated animate-pulse" />
        )}
        {showFramingVideo && settings.cold_open && hookSec >= 0.3 && !hookInPreviewFile && (
          <div className="absolute bottom-14 inset-x-2 flex justify-center pointer-events-none z-10">
            <span className="inline-block text-xs leading-snug px-2.5 py-1 rounded-md tabular-nums bg-amber-500/90 text-black">
              Hook noch nicht in der Vorschau — „Vorschau aktualisieren“
            </span>
          </div>
        )}
        {(processing || (previewLoading && !useClientFraming)) && (
          <PreviewRenderOverlay
            label={
              processing
                ? 'Clip wird exportiert…'
                : settings.cold_open && previewLoading
                  ? 'Hook wird eingefügt…'
                  : 'Vorschau wird gerendert…'
            }
          />
        )}
        {highlight.clip_boosted && (
          <span className="absolute bottom-3 left-3 z-20 px-2 py-1 rounded-full text-xs font-medium text-peak-purple bg-peak-purple/15 border border-peak-purple/30">
            Boosted
          </span>
        )}
    </PreviewChrome>
  );

  const exportActions = (
    <div className="cinema-editor-header-actions" aria-label="Export">
      <div className="cinema-editor-header-btns">
        <button
          type="button"
          onClick={() => triggerPreview({ force: true })}
          disabled={!canUpdatePreview}
          className="cinema-editor-header-btn peak-btn-secondary disabled:opacity-50"
        >
          {previewLoading ? '…' : 'Vorschau'}
        </button>
        <button
          type="button"
          onClick={handleProcess}
          disabled={processing}
          className="cinema-editor-header-btn peak-btn-primary disabled:opacity-50"
        >
          {processing ? '…' : 'Export'}
        </button>
      </div>
      <div className="cinema-editor-header-links">
        {previewUrl && videoSource === 'preview' && (
          <button type="button" onClick={() => setVideoSource('analyze')} className="cinema-editor-header-link">
            Rohclip
          </button>
        )}
        {previewUrl && videoSource === 'analyze' && (
          <button type="button" onClick={() => setVideoSource('preview')} className="cinema-editor-header-link">
            Vorschau
          </button>
        )}
        {onSavePrefs && (
          <button
            type="button"
            onClick={() => onSavePrefs(settingsRef.current)}
            className="cinema-editor-header-link"
          >
            Standard
          </button>
        )}
        {downloadUrl && (
          <a href={downloadUrl} download className="cinema-editor-header-link cinema-editor-header-link--accent">
            ↓
          </a>
        )}
      </div>
    </div>
  );

  return (
    <div className={`editor-shell cinema-editor${editorOpen ? ' cinema-editor--timeline' : ''}`}>
      <header className="cinema-editor-header">
        <div className="cinema-editor-header-main min-w-0">
          <p className="editor-eyebrow">Clip bearbeiten</p>
          <h3 className="editor-title truncate">{highlight.title}</h3>
          {(highlight.platform_fit || []).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {(highlight.platform_fit || []).map((p) => {
                const meta = PLATFORMS.find((x) => x.id === p);
                return (
                  <span key={p} className="peak-chip text-2xs !py-0.5 !px-2">
                    {meta?.icon} {meta?.label || p}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div className="cinema-editor-header-end">
          {highlight.viral_score > 0 && (
            <span className={`editor-score shrink-0 ${viralColor(highlight.viral_score)}`}>
              {highlight.viral_score}
              <span className="text-2xs font-medium opacity-70"> Peak</span>
            </span>
          )}
          {exportActions}
        </div>
      </header>

      <div className="cinema-editor-body">
        <div className="cinema-editor-stage">
          <div className="editor-preview-halo" aria-hidden />
          <div className="cinema-editor-preview-wrap">{videoPanel}</div>
        </div>

        <div className="cinema-editor-controls">
          <FramingEditorRow
            showFraming={useClientFraming}
            framingValue={gameplayFramingMode}
            onFramingChange={(mode) => update({ gameplayFraming: mode })}
            editorOpen={editorOpen}
            onToggleEditor={() => setEditorOpen((open) => !open)}
          />
        </div>
      </div>

      {editorOpen && (
        <EditorTimeline
          isMontage={isMontageClip}
          totalSec={timelineTotalSec}
          currentSec={timelineCurrentSec}
          onSeek={handleTimelineSeek}
          isPlaying={isPlaying}
          onPlayPause={handlePlayPause}
          onSkipBack={handleSkipBack}
          onSkipForward={handleSkipForward}
          segments={effectiveMontageSegments}
          onSegmentsChange={handleMontageSegmentsChange}
          activeSegmentIndex={activeKillIndex}
          trimMin={trimMin}
          trimMax={trimMax}
          trimStart={settings.start_time}
          trimEnd={settings.end_time}
          onTrimChange={({ start, end }) => update({ start_time: start, end_time: end })}
          onTrimDragging={setTrimDrag}
          sourceDuration={sourceDuration}
          onSplit={handleSplitAtPlayhead}
          onSetIn={handleSetIn}
          onSetOut={handleSetOut}
          canSplit={timelineCurrentSec > 0}
          thumbnailUrl={overlayThumbUrl}
          musicEnabled={settings.music}
          musicLabel={musicLabel}
          musicVolume={settings.musicVolume ?? 15}
          onMusicToggle={(v) => update({ music: v })}
          onAddAudio={() => update({ music: true })}
          onRemoveAudio={() => update({ music: false })}
          onMusicVolumeChange={(v) => update({ musicVolume: v })}
        />
      )}

    </div>
  );
}
