const BASE = '';

export function isRetryableConnectionError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('nicht erreichbar') ||
    msg.includes('not reachable') ||
    msg.includes('proxy') ||
    msg.includes('503')
  );
}

export function formatFetchError(err, fallback = 'Request failed') {
  const msg = err?.message || String(err);
  const lower = msg.toLowerCase();

  if (
    lower.includes('internal server error') ||
    lower.includes('internal error') ||
    isRetryableConnectionError(err)
  ) {
    return 'Backend not reachable. Wait for the server to finish starting (npm run dev), then try again.';
  }

  return msg || fallback;
}

export function apiError(data, fallback = 'Request failed') {
  const message = formatFetchError({ message: data?.error || data?.message }, fallback);
  const err = new Error(message);
  if (data?.code) err.code = data.code;
  if (data?.stack) err.stack = data.stack;
  return err;
}

export function isDatacenterBlockError(err) {
  return (
    err?.code === 'YOUTUBE_DATACENTER_BLOCK' ||
    /rechenzentrum|ytdlp_proxy|datacenter/i.test(err?.message || '')
  );
}

export function isCookiesExpiredError(err) {
  if (isDatacenterBlockError(err)) return false;
  return (
    err?.code === 'COOKIES_EXPIRED' ||
    /cookies expired|get cookies\.txt locally|youtube login|could not be refreshed automatically|no logged-in youtube/i.test(
      err?.message || '',
    )
  );
}

export function parseCookiesPathFromError(message) {
  const match = String(message || '').match(/save to:\s*(.+)\s*$/i);
  return match?.[1]?.trim() || '';
}

export async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw err;
    }
    throw new Error(formatFetchError(err, 'Network error'));
  }

  const text = await res.text().catch(() => '');
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) || res.statusText };
    }
  }

  if (!res.ok) {
    throw apiError(data, res.statusText || `HTTP ${res.status}`);
  }

  return data;
}

export function refreshCookies(force = true) {
  return api('/api/cookies/refresh', {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
}

export function startAnalyze(url, mood, renderSettings) {
  return api('/api/analyze', {
    method: 'POST',
    body: JSON.stringify({ url, mood, renderSettings }),
  });
}

export async function uploadAndAnalyzeVideo(file, mood, renderSettings, onProgress) {
  onProgress?.({
    status: 'running',
    step: 'fetching',
    message: 'Video wird hochgeladen…',
    progress: 5,
  });

  const fd = new FormData();
  fd.append('video', file);
  fd.append('mood', mood || 'hype');
  fd.append('renderSettings', JSON.stringify(renderSettings || {}));

  let res;
  try {
    res = await fetch('/api/analyze-upload', { method: 'POST', body: fd });
  } catch (err) {
    throw new Error(formatFetchError(err));
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(formatFetchError({ message: data.error }, 'Upload failed'));
  }

  return pollJob(data.jobId, 1200, onProgress);
}

export function getJob(jobId) {
  return api(`/api/jobs/${jobId}`);
}

export function listProjects(savedOnly = false) {
  const q = savedOnly ? '?saved=1' : '';
  return api(`/api/projects${q}`);
}

export function updateProject(projectId, body) {
  return api(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteProject(projectId) {
  return api(`/api/projects/${projectId}`, { method: 'DELETE' });
}

export function processClip(body) {
  return api('/api/clip', { method: 'POST', body: JSON.stringify(body) });
}

export function previewClip(body, { timeoutMs = 180_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return api('/api/preview', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .catch((err) => {
      if (err?.name === 'AbortError') {
        throw new Error('Vorschau-Timeout — Render dauert ungewöhnlich lange. Bitte erneut versuchen.');
      }
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

export function downloadAll(jobId, clips) {
  return fetch('/api/download-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, clips }),
  });
}

export async function uploadMusic(file) {
  const fd = new FormData();
  fd.append('music', file);
  let res;
  try {
    res = await fetch('/api/upload-music', { method: 'POST', body: fd });
  } catch (err) {
    throw new Error(formatFetchError(err));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(formatFetchError({ message: data.error }, 'Upload failed'));
  return data;
}

/**
 * Poll job until complete. Retries when the backend is temporarily down (e.g. server restart).
 */
export function pollJob(jobId, interval = 1200, onProgress) {
  const maxConnectionRetries = 60;

  return new Promise((resolve, reject) => {
    let connectionRetries = 0;

    const tick = async () => {
      try {
        const job = await getJob(jobId);
        connectionRetries = 0;
        onProgress?.(job);

        if (job.status === 'completed') return resolve(job);
        if (job.status === 'error') {
          const err = new Error(job.error || job.message || 'Processing failed');
          if (job.errorCode) err.code = job.errorCode;
          if (job.stack) err.stack = job.stack;
          return reject(err);
        }

        setTimeout(tick, interval);
      } catch (e) {
        if (isRetryableConnectionError(e) && connectionRetries < maxConnectionRetries) {
          connectionRetries += 1;
          onProgress?.({
            status: 'running',
            step: 'fetching',
            message: 'Waiting for server…',
            progress: 5,
          });
          setTimeout(tick, interval);
          return;
        }
        reject(new Error(formatFetchError(e)));
      }
    };

    tick();
  });
}
