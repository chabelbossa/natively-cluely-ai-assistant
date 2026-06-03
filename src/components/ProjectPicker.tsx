import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Folder, FolderOpen, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { useProjectContext, type ProjectContextRecord } from '../hooks/useProjectContext';

interface ProjectPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onManageInSettings?: () => void;
}

export const ProjectPicker: React.FC<ProjectPickerProps> = ({ isOpen, onClose, onManageInSettings }) => {
  const {
    projects,
    active,
    loading,
    scanning,
    scan,
    setActive,
  } = useProjectContext();

  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      // small timeout so the modal transition can play
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => {
      return (
        p.name.toLowerCase().includes(q) ||
        (p.stack ?? '').toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        (p.gitRemote ?? '').toLowerCase().includes(q)
      );
    });
  }, [projects, query]);

  if (!isOpen) return null;

  const pick = async (id: string) => {
    await setActive(id);
    onClose();
  };

  const clear = async () => {
    await setActive(null);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl bg-bg-primary border border-border-subtle shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header / Search */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-subtle">
          <Search size={14} className="text-text-secondary shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder:text-text-secondary/60"
          />
          <button
            onClick={() => scan()}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium
                       bg-bg-item-hover text-text-secondary hover:text-text-primary hover:bg-bg-item-active
                       disabled:opacity-50 transition-colors"
            title="Rescan local project roots"
          >
            {scanning ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            <span>Rescan</span>
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-item-hover transition-colors"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto">
          {loading && (
            <div className="p-6 text-center text-text-secondary text-sm">Loading projects…</div>
          )}
          {!loading && projects.length === 0 && (
            <EmptyState scanning={scanning} onScan={() => scan()} />
          )}
          {!loading && projects.length > 0 && filtered.length === 0 && (
            <div className="p-6 text-center text-text-secondary text-sm">
              No project matches “{query}”.
            </div>
          )}
          {filtered.length > 0 && (
            <ul className="py-1">
              {filtered.map((p) => (
                <ProjectRow key={p.id} project={p} isActive={active?.id === p.id} onPick={() => pick(p.id)} />
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-3 py-2 border-t border-border-subtle text-[11px] text-text-secondary">
          <span>
            {projects.length} project{projects.length === 1 ? '' : 's'} •{' '}
            <span className={active ? 'text-blue-400' : ''}>
              {active ? `Active: ${active.name}` : 'No active project'}
            </span>
          </span>
          <div className="flex items-center gap-2">
            {active && (
              <button
                onClick={clear}
                className="px-2 py-0.5 rounded hover:bg-bg-item-hover text-text-secondary hover:text-text-primary"
              >
                Clear
              </button>
            )}
            {onManageInSettings && (
              <button
                onClick={() => { onManageInSettings(); onClose(); }}
                className="px-2 py-0.5 rounded hover:bg-bg-item-hover text-text-secondary hover:text-text-primary"
              >
                Manage in Settings →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const ProjectRow: React.FC<{
  project: ProjectContextRecord;
  isActive: boolean;
  onPick: () => void;
}> = ({ project, isActive, onPick }) => {
  const Icon = isActive ? FolderOpen : Folder;
  return (
    <li>
      <button
        onClick={onPick}
        className={`w-full px-3 py-2.5 flex items-start gap-2.5 text-left transition-colors
                    ${isActive
                      ? 'bg-blue-500/10 hover:bg-blue-500/15'
                      : 'hover:bg-bg-item-hover'}`}
      >
        <Icon size={14} className={`shrink-0 mt-0.5 ${isActive ? 'text-blue-400' : 'text-text-secondary'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">{project.name}</span>
            {isActive && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-300">
                <Check size={9} /> ACTIVE
              </span>
            )}
            {project.stack && (
              <span className="text-[10px] text-text-secondary/80 truncate">{project.stack}</span>
            )}
          </div>
          {project.description ? (
            <div className="text-[11px] text-text-secondary mt-0.5 line-clamp-2">{project.description}</div>
          ) : project.autoSummary ? (
            <div className="text-[11px] text-text-secondary/70 mt-0.5 line-clamp-2">{project.autoSummary}</div>
          ) : (
            <div className="text-[11px] text-text-secondary/50 mt-0.5 truncate">{project.rootPath}</div>
          )}
        </div>
      </button>
    </li>
  );
};

const EmptyState: React.FC<{ scanning: boolean; onScan: () => void }> = ({ scanning, onScan }) => (
  <div className="p-8 text-center">
    <div className="mx-auto w-12 h-12 rounded-full bg-bg-item-hover flex items-center justify-center mb-3">
      <Folder size={20} className="text-text-secondary" />
    </div>
    <div className="text-sm font-medium text-text-primary mb-1">No projects yet</div>
    <p className="text-[12px] text-text-secondary mb-4 max-w-sm mx-auto">
      Natively will scan your machine for versioned projects and let you pick one as the active context for a meeting.
    </p>
    <button
      onClick={onScan}
      disabled={scanning}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium
                 bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors"
    >
      {scanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      <span>{scanning ? 'Scanning…' : 'Scan now'}</span>
    </button>
  </div>
);
