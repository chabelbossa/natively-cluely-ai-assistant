import { useCallback, useEffect, useState } from 'react';

export interface ProjectContextRecord {
  id: string;
  name: string;
  rootPath: string;
  stack: string | null;
  description: string;
  autoSummary: string;
  gitRemote: string | null;
  lastCommit: string | null;
  lastScannedAt: string;
  isActive: boolean;
  createdAt: string;
}

export interface ProjectTopicRecord {
  id: string;
  projectId: string;
  title: string;
  description: string;
  sortOrder: number;
  createdAt: string;
}

interface UseProjectContextResult {
  projects: ProjectContextRecord[];
  active: ProjectContextRecord | null;
  loading: boolean;
  scanning: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  scan: (opts?: { roots?: string[] }) => Promise<void>;
  rescan: (rootPath: string) => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  update: (id: string, updates: { name?: string; description?: string; stack?: string | null; autoSummary?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  getTopics: (projectId: string) => Promise<ProjectTopicRecord[]>;
  addTopic: (projectId: string, title: string, description: string) => Promise<ProjectTopicRecord | null>;
  updateTopic: (id: string, updates: { title?: string; description?: string; sortOrder?: number }) => Promise<void>;
  deleteTopic: (id: string) => Promise<void>;
  defaultRoots: string[];
}

export function useProjectContext(): UseProjectContextResult {
  const [projects, setProjects] = useState<ProjectContextRecord[]>([]);
  const [active, setActiveState] = useState<ProjectContextRecord | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [scanning, setScanning] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultRoots, setDefaultRoots] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = (await window.electronAPI.projectContextGetAll()) as ProjectContextRecord[];
      const act = (await window.electronAPI.projectContextGetActive()) as ProjectContextRecord | null;
      setProjects(list);
      setActiveState(act);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    window.electronAPI.projectContextDefaultRoots().then(setDefaultRoots).catch(() => {});
    const off = window.electronAPI.onProjectContextChanged(() => {
      refresh();
    });
    return off;
  }, [refresh]);

  const scan = useCallback(async (opts?: { roots?: string[] }) => {
    setScanning(true);
    setError(null);
    try {
      const result = await window.electronAPI.projectContextScan(opts);
      if (result?.success) {
        await refresh();
      } else {
        setError(result?.error ?? 'Scan failed');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [refresh]);

  const rescan = useCallback(async (rootPath: string) => {
    setScanning(true);
    setError(null);
    try {
      const result = await window.electronAPI.projectContextRescan(rootPath);
      if (result?.success) {
        await refresh();
      } else {
        setError(result?.error ?? 'Rescan failed');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Rescan failed');
    } finally {
      setScanning(false);
    }
  }, [refresh]);

  const setActive = useCallback(async (id: string | null) => {
    await window.electronAPI.projectContextSetActive(id);
    // The event listener will trigger a refresh.
  }, []);

  const update = useCallback(async (id: string, updates: { name?: string; description?: string; stack?: string | null; autoSummary?: string }) => {
    await window.electronAPI.projectContextUpdate(id, updates);
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await window.electronAPI.projectContextDelete(id);
    await refresh();
  }, [refresh]);

  const getTopics = useCallback(async (projectId: string): Promise<ProjectTopicRecord[]> => {
    return (await window.electronAPI.projectContextGetTopics(projectId)) as ProjectTopicRecord[];
  }, []);

  const addTopic = useCallback(async (projectId: string, title: string, description: string): Promise<ProjectTopicRecord | null> => {
    const result = await window.electronAPI.projectContextAddTopic(projectId, title, description);
    if (result?.success && result.topic) {
      return result.topic as ProjectTopicRecord;
    }
    return null;
  }, []);

  const updateTopic = useCallback(async (id: string, updates: { title?: string; description?: string; sortOrder?: number }) => {
    await window.electronAPI.projectContextUpdateTopic(id, updates);
  }, []);

  const deleteTopic = useCallback(async (id: string) => {
    await window.electronAPI.projectContextDeleteTopic(id);
  }, []);

  return {
    projects,
    active,
    loading,
    scanning,
    error,
    refresh,
    scan,
    rescan,
    setActive,
    update,
    remove,
    getTopics,
    addTopic,
    updateTopic,
    deleteTopic,
    defaultRoots,
  };
}
