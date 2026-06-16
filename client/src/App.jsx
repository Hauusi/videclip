import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import HighlightCard from './components/HighlightCard';
import Toast from './components/Toast';
import { useLocalStorage } from './hooks/useLocalStorage';
import { useProjects } from './hooks/useProjects';
import {
  isValidYouTubeUrl,
  youtubeVideoId,
  isAcceptedVideoFile,
  formatDetectedGame,
} from './utils/helpers';
import {
  startAnalyze,
  pollJob,
  getJob,
  downloadAll,
  uploadMusic,
  uploadAndAnalyzeVideo,
  refreshCookies,
  isCookiesExpiredError,
  isDatacenterBlockError,
  parseCookiesPathFromError,
} from './api';
import { useTheme } from './hooks/useTheme';
import CookiesExpiredModal from './components/CookiesExpiredModal';
import AppSidebar from './components/layout/AppSidebar';
import AnalyzeTopBar from './components/layout/AnalyzeTopBar';
import AnalyzingWorkspace from './components/layout/AnalyzingWorkspace';
import AnalysisFooter from './components/layout/AnalysisFooter';
import MobileBottomBar from './components/layout/MobileBottomBar';
import HeroBackdrop from './components/layout/HeroBackdrop';
import PeakClipLogo from './components/brand/PeakClipLogo';
import HomeWorkspace from './views/HomeWorkspace';
import ClipFeed from './views/ClipFeed';
import LibraryView from './views/LibraryView';
import { resolveAppView } from './utils/appViews';
import { isDebugUiEnabled } from './utils/debugUi';

const DEFAULT_PREFS = {
  captions: true,
  music: true,
  musicAuto: true,
  musicVolume: 15,
  colorGrade: true,
  aspectRatio: '9:16',
  captionStyle: 'fire',
  aiStrength: 75,
};

export default function App() {
  const [prefs, setPrefs] = useLocalStorage('videclip-prefs', DEFAULT_PREFS);
  const {
    projects,
    savedProjects,
    loading: projectsLoading,
    upsertFromAnalysis,
    toggleSaved,
    removeProject,
  } = useProjects();
  const [activeView, setActiveView] = useState('clips');

  const [url, setUrl] = useState('');
  const [localFileName, setLocalFileName] = useState('');
  const [mood, setMood] = useState('hype');
  const [musicTrack, setMusicTrack] = useState('hype-1');
  const [customMusicPath, setCustomMusicPath] = useState(null);
  const [customMusicName, setCustomMusicName] = useState(null);
  const [aspectRatio, setAspectRatio] = useState(prefs.aspectRatio || '9:16');
  const [analyzing, setAnalyzing] = useState(false);
  const [job, setJob] = useState(null);
  const [result, setResult] = useState(null);
  const [urlError, setUrlError] = useState('');
  const [toasts, setToasts] = useState([]);
  const [readyClips, setReadyClips] = useState({});
  const [cookiesModalOpen, setCookiesModalOpen] = useState(false);
  const [cookiesModalMode, setCookiesModalMode] = useState('cookies');
  const [cookiesPathHint, setCookiesPathHint] = useState('');
  const [cookiesRefreshing, setCookiesRefreshing] = useState(false);
  const [editingHighlightId, setEditingHighlightId] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage('videclip-sidebar-collapsed', false);
  /** 'compact' = top bar + clip skeletons; 'home' = hero + project rail (logo during analysis) */
  const [analyzeUiMode, setAnalyzeUiMode] = useState('compact');
  const { theme, toggleTheme, isLight } = useTheme();

  const skipAutoAnalyzeRef = useRef(false);
  const analyzeTimerRef = useRef(null);
  const lastAutoTriggeredIdRef = useRef('');
  const pasteImmediateRef = useRef(false);
  const analyzingRef = useRef(false);
  const handleAnalyzeRef = useRef(() => {});

  analyzingRef.current = analyzing;

  const handleUrlChange = useCallback((value) => {
    setUrl(value);
    setUrlError('');
    if (value.trim()) setLocalFileName('');
  }, []);

  const handleUrlPaste = useCallback(() => {
    pasteImmediateRef.current = true;
  }, []);

  const toast = useCallback((message, type = 'success') => {
    const id = Date.now();
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const dismissToast = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  const globalSettings = useMemo(
    () => ({
      ...prefs,
      mood,
      musicTrackId: musicTrack,
      customMusicPath,
      aspectRatio,
      captionStyle: prefs.captionStyle || 'fire',
    }),
    [prefs, mood, musicTrack, customMusicPath, aspectRatio],
  );

  const cardSettings = useMemo(
    () => ({
      ...globalSettings,
      ...(result?.renderSettings || {}),
      aspectRatio: '9:16',
      musicTrackId: result?.musicTrackId || globalSettings.musicTrackId,
      customMusicPath: globalSettings.customMusicPath,
    }),
    [globalSettings, result],
  );

  const handleCustomMusic = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await uploadMusic(file);
      setCustomMusicPath(data.customMusicPath);
      setCustomMusicName(file.name);
      toast('Musik hochgeladen');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const runAnalyzeJob = async (onProgress) => {
    const { jobId } = await startAnalyze(url, mood, globalSettings);
    return pollJob(jobId, 1200, onProgress);
  };

  const finishAnalyzeSuccess = useCallback(
    (completed, historyKey, fallbackTitle) => {
      setResult(completed.result);
      setActiveView('clips');
      upsertFromAnalysis(completed, historyKey, fallbackTitle);
      toast('Analyse abgeschlossen');
    },
    [toast, upsertFromAnalysis],
  );

  const runAnalysis = useCallback(
    async ({ analyzeFn, historyKey, fallbackTitle, youtubeRetry = false }) => {
      setUrlError('');
      setAnalyzing(true);
      setAnalyzeUiMode('compact');
      setResult(null);
      setJob(null);
      setReadyClips({});
      setEditingHighlightId(null);

      try {
        const completed = await analyzeFn(setJob);
        finishAnalyzeSuccess(completed, historyKey, fallbackTitle);
      } catch (e) {
        if (youtubeRetry && isDatacenterBlockError(e)) {
          setCookiesModalMode('datacenter');
          setCookiesModalOpen(true);
          toast('YouTube blockiert die Server-IP — Proxy nötig.', 'error');
        } else if (youtubeRetry && isCookiesExpiredError(e)) {
          try {
            setJob({
              status: 'running',
              step: 'fetching',
              message: 'YouTube-Anmeldung wird erneuert…',
              progress: 8,
            });
            toast('YouTube-Session wird aktualisiert…', 'success');
            await refreshCookies(true);
            const completed = await analyzeFn(setJob);
            finishAnalyzeSuccess(completed, historyKey, fallbackTitle);
            return;
          } catch (retryErr) {
            setCookiesModalMode(
              isDatacenterBlockError(retryErr) ? 'datacenter' : 'cookies',
            );
            setCookiesPathHint(parseCookiesPathFromError(retryErr.message));
            setCookiesModalOpen(true);
            toast(
              isDatacenterBlockError(retryErr)
                ? 'YouTube blockiert die Server-IP — Proxy nötig.'
                : isCookiesExpiredError(retryErr)
                  ? 'Anmeldung fehlgeschlagen — bitte im Browser anmelden.'
                  : retryErr.message,
              'error',
            );
          }
        } else {
          toast(e.message, 'error');
        }
      } finally {
        setAnalyzing(false);
      }
    },
    [finishAnalyzeSuccess, toast],
  );

  const handleAnalyze = async () => {
    if (localFileName) {
      setUrlError('Bitte zuerst die Datei entfernen oder erneut hochladen');
      return;
    }
    if (!isValidYouTubeUrl(url)) {
      setUrlError('Gültige YouTube-URL eingeben');
      return;
    }
    await runAnalysis({
      analyzeFn: runAnalyzeJob,
      historyKey: url,
      fallbackTitle: 'Video',
      youtubeRetry: true,
    });
  };

  const handleLocalUpload = useCallback(
    async (file) => {
      if (!isAcceptedVideoFile(file)) {
        setUrlError('Bitte MP4, MOV, WebM oder MKV hochladen');
        return;
      }

      const name = file.name;
      const historyKey = `local://${name}`;
      setUrl('');
      setUrlError('');
      setLocalFileName(name);
      lastAutoTriggeredIdRef.current = '';

      await runAnalysis({
        analyzeFn: (onProgress) => uploadAndAnalyzeVideo(file, mood, globalSettings, onProgress),
        historyKey,
        fallbackTitle: name.replace(/\.[^.]+$/, ''),
      });
    },
    [globalSettings, mood, runAnalysis],
  );

  const handleClearLocal = useCallback(() => {
    setLocalFileName('');
    setUrlError('');
  }, []);

  handleAnalyzeRef.current = handleAnalyze;

  useEffect(() => {
    if (skipAutoAnalyzeRef.current) {
      skipAutoAnalyzeRef.current = false;
      return;
    }

    const trimmed = url.trim();
    const videoId = youtubeVideoId(trimmed);
    if (!videoId) {
      lastAutoTriggeredIdRef.current = '';
      return;
    }

    if (analyzingRef.current) return;
    if (videoId === lastAutoTriggeredIdRef.current) return;

    const delay = pasteImmediateRef.current ? 50 : 400;
    pasteImmediateRef.current = false;

    clearTimeout(analyzeTimerRef.current);
    analyzeTimerRef.current = setTimeout(() => {
      if (analyzingRef.current) return;
      const currentId = youtubeVideoId(url.trim());
      if (!currentId || currentId !== videoId) return;
      lastAutoTriggeredIdRef.current = videoId;
      handleAnalyzeRef.current();
    }, delay);

    return () => clearTimeout(analyzeTimerRef.current);
  }, [url]);

  const handleCookiesAutoRefresh = async () => {
    setCookiesRefreshing(true);
    try {
      await refreshCookies();
      toast('Cookies aktualisiert');
      setCookiesModalOpen(false);
      handleAnalyze();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setCookiesRefreshing(false);
    }
  };

  const handleCookiesRetry = () => {
    setCookiesModalOpen(false);
    handleAnalyze();
  };

  const detectedGame = useMemo(
    () => formatDetectedGame(result?.contentGame),
    [result?.contentGame],
  );

  const highlights = result?.highlights || [];

  const editingHighlight = useMemo(
    () => highlights.find((h) => h.id === editingHighlightId) || null,
    [highlights, editingHighlightId],
  );

  const handleDownloadAll = async () => {
    if (!result?.jobId) return;
    try {
      const clips = Object.values(readyClips).filter(Boolean);
      const res = await downloadAll(
        result.jobId,
        clips.length ? clips.map((u) => u.split('/').pop()) : undefined,
      );
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `peakclip_${result.jobId.slice(0, 8)}.zip`;
      a.click();
      toast('ZIP-Download gestartet');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const savePrefs = useCallback(
    (clipSettings) => {
      if (clipSettings?.aspectRatio) setAspectRatio(clipSettings.aspectRatio);
      setPrefs((p) => ({
        ...p,
        captions: clipSettings?.captions ?? p.captions,
        music: clipSettings?.music ?? p.music,
        musicAuto: clipSettings?.musicAuto ?? p.musicAuto,
        musicVolume: clipSettings?.musicVolume ?? p.musicVolume,
        colorGrade: clipSettings?.colorGrade ?? p.colorGrade,
        aspectRatio: clipSettings?.aspectRatio ?? aspectRatio,
        captionStyle: clipSettings?.caption_style ?? p.captionStyle ?? 'fire',
        aiStrength: clipSettings?.aiStrength ?? p.aiStrength ?? 75,
      }));
      toast('Einstellungen gespeichert');
    },
    [aspectRatio, toast],
  );

  const handleLoadProject = useCallback(
    async (entry) => {
      setEditingHighlightId(null);
      setUrlError('');
      setActiveView('clips');

      if (entry.resultSnapshot) {
        skipAutoAnalyzeRef.current = true;
        lastAutoTriggeredIdRef.current = youtubeVideoId(entry.url) || '';
        setUrl(entry.url || '');
        setResult(entry.resultSnapshot);
        toast('Projekt geladen');
        return;
      }

      if (entry.jobId) {
        try {
          const job = await getJob(entry.jobId);
          if (job.status === 'completed' && job.result) {
            skipAutoAnalyzeRef.current = true;
            lastAutoTriggeredIdRef.current = youtubeVideoId(entry.url) || '';
            setUrl(entry.url || '');
            setResult(job.result);
            toast('Projekt geladen');
            return;
          }
        } catch {
          /* fall through */
        }
      }

      setResult(null);
      lastAutoTriggeredIdRef.current = '';
      setUrl(entry.url || '');
      toast('Medien abgelaufen — bitte neu analysieren', 'success');
    },
    [toast],
  );

  const handleGoHome = useCallback(() => {
    if (analyzing) {
      setEditingHighlightId(null);
      setResult(null);
      setActiveView('clips');
      setAnalyzeUiMode('home');
      return;
    }

    clearTimeout(analyzeTimerRef.current);
    lastAutoTriggeredIdRef.current = '';
    setAnalyzing(false);
    setAnalyzeUiMode('compact');
    setResult(null);
    setEditingHighlightId(null);
    setUrl('');
    setLocalFileName('');
    setUrlError('');
    setReadyClips({});
    setJob(null);
    setActiveView('clips');
  }, [analyzing]);

  const handleNewProject = handleGoHome;

  const isEditView = Boolean(editingHighlight);
  const showFooter = analyzing || (job && job.step !== 'ready');
  const showProjects = activeView === 'projects' && !isEditView;
  const showAnalyzing = analyzing && !result && activeView === 'clips';
  const showImportHero =
    !isEditView && !result && activeView === 'clips' && (!analyzing || analyzeUiMode === 'home');
  const showAnalyzingWorkspace = showAnalyzing && analyzeUiMode === 'compact';
  const showCompactBar =
    !isEditView && (result || showAnalyzingWorkspace) && activeView === 'clips';

  const recentProjects = projects.slice(0, 6);
  const appView = resolveAppView({
    activeView,
    editingHighlightId,
    result,
  });
  const showDebugUi = isDebugUiEnabled();

  const analyzeProps = {
    url,
    onUrlChange: handleUrlChange,
    onUrlPaste: handleUrlPaste,
    onAnalyze: handleAnalyze,
    onLocalUpload: handleLocalUpload,
    onClearLocal: handleClearLocal,
    analyzing,
    urlError,
    localFileName,
    history: recentProjects,
    onHistoryPick: handleLoadProject,
    projects,
    onOpenProject: handleLoadProject,
    onViewAllProjects: () => setActiveView('projects'),
    job,
  };

  return (
    <div
      className={`theme-root min-h-dvh max-h-dvh flex flex-col lg:flex-row overflow-hidden ${isLight ? 'light' : ''}`}
    >
      <AppSidebar
        active={activeView === 'projects' ? 'projects' : 'overview'}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        onNavigate={(id) => {
          if (id === 'overview') {
            setEditingHighlightId(null);
            setActiveView('clips');
          }
          if (id === 'projects') {
            setEditingHighlightId(null);
            setActiveView('projects');
          }
        }}
        history={recentProjects}
        activeJobId={result?.jobId}
        onLoadProject={handleLoadProject}
        onNewProject={handleNewProject}
        onHome={handleGoHome}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <div className="relative flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        <HeroBackdrop />
        <div className="relative z-10 lg:hidden shrink-0 flex items-center gap-3 px-4 py-3 border-b peak-bar safe-top">
          <PeakClipLogo className="!scale-105 origin-left" onClick={handleGoHome} />
          {isEditView && (
            <button
              type="button"
              onClick={() => setEditingHighlightId(null)}
              className="ml-auto peak-btn-secondary !py-2 !px-3 !text-xs shrink-0"
            >
              ← Clips
            </button>
          )}
        </div>

        {showCompactBar && (
          <div className="relative z-10 shrink-0">
            <AnalyzeTopBar {...analyzeProps} clipCount={highlights.length} />
          </div>
        )}

        <div className="relative z-10 flex flex-1 min-h-0">
          <main
            data-app-view={appView}
            className={`flex-1 min-w-0 min-h-0 overflow-hidden scrollbar-thin ${
              isEditView
                ? 'flex flex-col p-3 sm:p-4 lg:p-6'
                : showImportHero
                  ? 'flex flex-col overflow-y-auto'
                  : 'overflow-y-auto'
            }`}
          >
            {isEditView ? (
              <section className="flex flex-col w-full max-w-[1600px] mx-auto flex-1 min-h-0 h-full">
                <div className="hidden lg:flex shrink-0 mb-3">
                  <button
                    type="button"
                    onClick={() => setEditingHighlightId(null)}
                    className="editor-back-pill"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                    Zurück zu Clips
                  </button>
                </div>
                <div className="flex-1 min-h-0 h-full">
                  <HighlightCard
                    key={editingHighlight.id}
                    highlight={editingHighlight}
                    jobId={result.jobId}
                    sourceDuration={result.sourceDuration}
                    sourceWidth={result.sourceWidth}
                    sourceHeight={result.sourceHeight}
                    sourceVideoUrl={
                      result.sourceVideo
                        ? `/api/files/${result.jobId}/_root/${result.sourceVideo}`
                        : null
                    }
                    globalSettings={cardSettings}
                    onToast={toast}
                    onClipReady={(id, dl) => setReadyClips((c) => ({ ...c, [id]: dl }))}
                    mood={mood}
                    onMoodChange={setMood}
                    musicTrack={musicTrack}
                    onMusicTrackPick={(trackId) => {
                      setMusicTrack(trackId);
                      setPrefs((p) => ({ ...p, musicAuto: false }));
                    }}
                    onMusicAuto={() => setPrefs((p) => ({ ...p, musicAuto: true }))}
                    customMusicName={customMusicName}
                    onCustomMusic={handleCustomMusic}
                    onSavePrefs={savePrefs}
                    setGlobalAspectRatio={setAspectRatio}
                    debugKillExport={result.debugKillExport}
                  />
                </div>
              </section>
            ) : showProjects ? (
              <LibraryView
                projects={projects}
                savedProjects={savedProjects}
                loading={projectsLoading}
                analyzing={analyzing}
                job={job}
                onOpenProject={handleLoadProject}
                onToggleSave={(project, saved) => {
                  toggleSaved(project.id, saved);
                  toast(saved ? 'Projekt gespeichert' : 'Speicherung aufgehoben', 'success');
                }}
                onDeleteProject={(project) => {
                  if (result?.jobId === project.jobId) {
                    handleGoHome();
                  }
                  removeProject(project.id);
                  toast('Projekt gelöscht');
                }}
                onNewVideo={() => {
                  handleNewProject();
                  setActiveView('clips');
                }}
              />
            ) : (
              <>
                {showImportHero && <HomeWorkspace {...analyzeProps} />}

                {showAnalyzingWorkspace && (
                  <AnalyzingWorkspace
                    projects={projects}
                    job={job}
                    onOpenProject={handleLoadProject}
                    onViewAllProjects={() => setActiveView('projects')}
                  />
                )}

                {result && editingHighlightId && !editingHighlight && (
                  <p className="text-sm text-peak-muted mb-4 px-4 lg:px-6">
                    Clip nicht sichtbar (Filter).{' '}
                    <button
                      type="button"
                      className="text-peak-purple underline"
                      onClick={() => setEditingHighlightId(null)}
                    >
                      Übersicht
                    </button>
                  </p>
                )}

                {result && (
                  <ClipFeed
                    highlights={highlights}
                    detectedGame={detectedGame}
                    onEdit={setEditingHighlightId}
                    onDownloadAll={handleDownloadAll}
                    debugKillExport={result.debugKillExport}
                    showDebugUi={showDebugUi}
                    sourceTitle={result.sourceName || result.url}
                  />
                )}

              </>
            )}
          </main>
        </div>

        <div className="relative z-10 shrink-0">
          <AnalysisFooter active={showFooter} job={job} analyzing={analyzing} />
        </div>
        <div className="relative z-10 shrink-0">
          <MobileBottomBar
            isEditView={isEditView}
            onBackToOverview={() => setEditingHighlightId(null)}
            onHome={handleGoHome}
          />
        </div>
      </div>

      <Toast toasts={toasts} onDismiss={dismissToast} />

      <CookiesExpiredModal
        open={cookiesModalOpen}
        mode={cookiesModalMode}
        cookiesPath={cookiesPathHint}
        refreshing={cookiesRefreshing}
        onAutoRefresh={handleCookiesAutoRefresh}
        onRetry={handleCookiesRetry}
        onClose={() => setCookiesModalOpen(false)}
      />
    </div>
  );
}
