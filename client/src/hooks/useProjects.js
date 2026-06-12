import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalStorage } from './useLocalStorage';
import { listProjects, updateProject as apiUpdateProject, deleteProject as apiDeleteProject } from '../api';
import {
  buildProjectFromAnalysis,
  mergeProjectLists,
  migrateHistoryToProjects,
} from '../utils/projects';

const STORAGE_KEY = 'videclip-projects';
const LEGACY_KEY = 'videclip-history';

export function useProjects() {
  const [localProjects, setLocalProjects] = useLocalStorage(STORAGE_KEY, []);
  const [serverProjects, setServerProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy && (!localProjects || localProjects.length === 0)) {
        const parsed = JSON.parse(legacy);
        const migrated = migrateHistoryToProjects(parsed);
        if (migrated.length) {
          setLocalProjects(migrated);
        }
        localStorage.removeItem(LEGACY_KEY);
      }
    } catch {
      /* ignore */
    }
  }, [localProjects, setLocalProjects]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listProjects();
      setServerProjects(data.projects || []);
    } catch {
      setServerProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const projects = useMemo(
    () => mergeProjectLists(localProjects, serverProjects),
    [localProjects, serverProjects],
  );

  const savedProjects = useMemo(() => projects.filter((p) => p.saved), [projects]);

  const upsertFromAnalysis = useCallback(
    (completed, historyKey, fallbackTitle) => {
      const project = buildProjectFromAnalysis(completed, historyKey, fallbackTitle);
      setLocalProjects((list) => {
        const next = [project, ...list.filter((p) => p.id !== project.id)];
        return next.slice(0, 50);
      });
      refresh();
      return project;
    },
    [setLocalProjects, refresh],
  );

  const toggleSaved = useCallback(
    async (projectId, saved) => {
      setLocalProjects((list) =>
        list.map((p) =>
          p.id === projectId
            ? {
                ...p,
                saved,
                expiresAt: saved ? null : Date.now() + 7 * 24 * 60 * 60 * 1000,
                updatedAt: Date.now(),
              }
            : p,
        ),
      );
      try {
        await apiUpdateProject(projectId, { saved });
        await refresh();
      } catch {
        /* local state kept */
      }
    },
    [setLocalProjects, refresh],
  );

  const removeProject = useCallback(
    async (projectId) => {
      setLocalProjects((list) => list.filter((p) => p.id !== projectId));
      try {
        await apiDeleteProject(projectId);
      } catch {
        /* ignore */
      }
      await refresh();
    },
    [setLocalProjects, refresh],
  );

  return {
    projects,
    savedProjects,
    loading,
    refresh,
    upsertFromAnalysis,
    toggleSaved,
    removeProject,
  };
}
