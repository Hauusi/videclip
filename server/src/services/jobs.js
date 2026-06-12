import { v4 as uuidv4 } from 'uuid';

const jobs = new Map();

export const STEPS = ['fetching', 'transcribing', 'analyzing', 'editing', 'ready', 'error'];

export function createJob(type, meta = {}) {
  const id = uuidv4();
  const job = {
    id,
    type,
    status: 'pending',
    step: 'fetching',
    progress: 0,
    message: 'Starting...',
    meta,
    result: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  jobs.set(id, job);
  return job;
}

export function setJobStep(id, step, message, progress) {
  return updateJob(id, { step, message, progress, status: step === 'error' ? 'error' : 'running' });
}

export function completeJob(id, result) {
  return updateJob(id, {
    status: 'completed',
    step: 'ready',
    progress: 100,
    message: 'Ready',
    result,
  });
}

export function failJob(id, error) {
  const message = typeof error === 'string' ? error : error?.message || 'Unknown error';
  const errorCode = typeof error === 'object' && error?.code ? error.code : undefined;
  return updateJob(id, {
    status: 'error',
    step: 'error',
    error: message,
    errorCode,
    message,
  });
}
