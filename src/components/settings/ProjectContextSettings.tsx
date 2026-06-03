import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, Loader2, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useProjectContext, type ProjectContextRecord, type ProjectTopicRecord } from '../../hooks/useProjectContext';

const MAX_DESCRIPTION = 4000;

export const ProjectContextSettings: React.FC = () => {
  const {
    projects,
    active,
    loading,
    scanning,
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
  } = useProjectContext();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filtered = projects.filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.stack ?? '').toLowerCase().includes(q) ||
      (p.description ?? '').toLowerCase().includes(q) ||
      (p.gitRemote ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h2 className="text-lg font-semibold text-text-primary">Project Context</h2>
        <p className="text-[13px] text-text-secondary max-w-2xl">
          Pick a local project to set as the active context for your meetings. Natively injects the
          project's stack, last commit, description, auto-summary, and selected topics into every
          AI suggestion. The active project is orthogonal to the active Mode (persona) — you can
          be in <em>Sales</em> mode while the active project is <em>PharmaOps</em>.
        </p>
      </header>

      {/* Action bar */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => scan()}
          disabled={scanning}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium
                     bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors"
        >
          {scanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          <span>{scanning ? 'Scanning…' : 'Rescan all roots'}</span>
        </button>
        <div className="relative flex-1 max-w-xs">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter projects…"
            className="w-full pl-7 pr-2 py-1.5 rounded-md bg-bg-item-hover border border-border-subtle
                       text-[13px] text-text-primary placeholder:text-text-secondary/60
                       focus:outline-none focus:border-blue-500/50"
          />
        </div>
        <div className="ml-auto text-[11px] text-text-secondary">
          {projects.length} project{projects.length === 1 ? '' : 's'} •{' '}
          <span className={active ? 'text-blue-400' : ''}>
            {active ? `Active: ${active.name}` : 'No active project'}
          </span>
        </div>
      </div>

      {/* Roots disclosure */}
      {defaultRoots.length > 0 && (
        <details className="rounded-md border border-border-subtle bg-bg-item-hover/40">
          <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-medium text-text-secondary hover:text-text-primary">
            Scan roots ({defaultRoots.length})
          </summary>
          <ul className="px-3 pb-2 text-[12px] text-text-secondary space-y-0.5 font-mono">
            {defaultRoots.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}

      {/* Project list */}
      {loading && (
        <div className="text-text-secondary text-sm py-8 text-center">Loading…</div>
      )}
      {!loading && projects.length === 0 && (
        <div className="rounded-lg border border-border-subtle bg-bg-item-hover/30 p-8 text-center">
          <Folder size={28} className="mx-auto text-text-secondary/60 mb-2" />
          <div className="text-sm font-medium text-text-primary mb-1">No projects discovered</div>
          <p className="text-[12px] text-text-secondary mb-3 max-w-md mx-auto">
            Click <em>Rescan all roots</em> to scan your local files for versioned projects.
          </p>
        </div>
      )}
      {!loading && projects.length > 0 && (
        <div className="rounded-lg border border-border-subtle divide-y divide-border-subtle overflow-hidden">
          {filtered.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              isActive={active?.id === p.id}
              isExpanded={expanded === p.id}
              onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
              onSetActive={() => setActive(active?.id === p.id ? null : p.id)}
              onUpdate={(updates) => update(p.id, updates)}
              onDelete={() => {
                if (window.confirm(`Remove project "${p.name}"? This clears its topics.`)) {
                  remove(p.id);
                }
              }}
              onRescan={() => rescan(p.rootPath)}
              getTopics={getTopics}
              addTopic={addTopic}
              updateTopic={updateTopic}
              deleteTopic={deleteTopic}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface ProjectRowProps {
  project: ProjectContextRecord;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onSetActive: () => void;
  onUpdate: (updates: { name?: string; description?: string; stack?: string | null }) => Promise<void>;
  onDelete: () => void;
  onRescan: () => void;
  getTopics: (projectId: string) => Promise<ProjectTopicRecord[]>;
  addTopic: (projectId: string, title: string, description: string) => Promise<ProjectTopicRecord | null>;
  updateTopic: (id: string, updates: { title?: string; description?: string; sortOrder?: number }) => Promise<void>;
  deleteTopic: (id: string) => Promise<void>;
}

const ProjectRow: React.FC<ProjectRowProps> = ({
  project, isActive, isExpanded, onToggle, onSetActive, onUpdate, onDelete, onRescan,
  getTopics, addTopic, updateTopic, deleteTopic,
}) => {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [topics, setTopics] = useState<ProjectTopicRecord[] | null>(null);
  const [newTopicTitle, setNewTopicTitle] = useState('');
  const [newTopicDesc, setNewTopicDesc] = useState('');

  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
  }, [project.name, project.description]);

  useEffect(() => {
    if (isExpanded && topics === null) {
      getTopics(project.id).then(setTopics);
    }
  }, [isExpanded, project.id, topics, getTopics]);

  const dirty = name !== project.name || description !== project.description;

  const save = async () => {
    await onUpdate({ name: name.trim() || project.name, description });
  };

  const handleAddTopic = async () => {
    const title = newTopicTitle.trim();
    if (!title) return;
    const t = await addTopic(project.id, title, newTopicDesc.trim());
    if (t) {
      setTopics((prev) => [...(prev ?? []), t]);
      setNewTopicTitle('');
      setNewTopicDesc('');
    }
  };

  return (
    <div className={isActive ? 'bg-blue-500/5' : ''}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={onToggle}
          className="p-0.5 rounded hover:bg-bg-item-hover text-text-secondary"
          title={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Folder size={14} className={isActive ? 'text-blue-400 shrink-0' : 'text-text-secondary shrink-0'} />
            <span className="text-sm font-medium text-text-primary truncate">{project.name}</span>
            {isActive && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-300">
                ACTIVE
              </span>
            )}
            {project.stack && (
              <span className="text-[10px] text-text-secondary truncate">{project.stack}</span>
            )}
          </div>
          <div className="text-[11px] text-text-secondary/70 mt-0.5 truncate font-mono">{project.rootPath}</div>
        </div>
        <button
          onClick={onSetActive}
          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors
                      ${isActive
                        ? 'bg-bg-item-hover text-text-secondary hover:bg-bg-item-active'
                        : 'bg-blue-500/20 text-blue-300 hover:bg-blue-500/30'}`}
        >
          {isActive ? 'Deactivate' : 'Set active'}
        </button>
        <button
          onClick={onRescan}
          className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-item-hover"
          title="Re-discover metadata (stack, last commit, README)"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded-md text-text-secondary hover:text-red-400 hover:bg-bg-item-hover"
          title="Remove from Natively (does not delete files)"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {isExpanded && (
        <div className="px-4 pb-4 pl-12 space-y-3 border-t border-border-subtle/50 pt-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Display name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-md bg-bg-item-hover border border-border-subtle
                           text-[13px] text-text-primary focus:outline-none focus:border-blue-500/50"
              />
            </Field>
            <Field label="Stack (auto-detected)">
              <input
                value={project.stack ?? ''}
                readOnly
                className="w-full px-2.5 py-1.5 rounded-md bg-bg-item-hover/40 border border-border-subtle
                           text-[13px] text-text-secondary/80 font-mono focus:outline-none"
                title="Read-only — derived from package.json and file markers"
              />
            </Field>
          </div>

          <Field label={`Description (for the AI) — ${description.length}/${MAX_DESCRIPTION}`}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
              rows={3}
              placeholder="What is this project? What are its constraints, audiences, fiscal/legal context, etc."
              className="w-full px-2.5 py-1.5 rounded-md bg-bg-item-hover border border-border-subtle
                         text-[13px] text-text-primary placeholder:text-text-secondary/50 resize-y
                         focus:outline-none focus:border-blue-500/50"
            />
          </Field>

          {project.autoSummary && (
            <Field label="Auto-summary (from README)">
              <div className="px-2.5 py-1.5 rounded-md bg-bg-item-hover/40 border border-border-subtle text-[12px] text-text-secondary/90 leading-relaxed">
                {project.autoSummary}
              </div>
            </Field>
          )}

          {project.gitRemote && (
            <Field label="Git remote">
              <div className="text-[12px] font-mono text-text-secondary/80">{project.gitRemote}</div>
            </Field>
          )}
          {project.lastCommit && (
            <Field label="Last commit">
              <div className="text-[12px] font-mono text-text-secondary/80">{project.lastCommit}</div>
            </Field>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={!dirty}
              className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-blue-500 hover:bg-blue-600
                         text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => { setName(project.name); setDescription(project.description); }}
              disabled={!dirty}
              className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-bg-item-hover
                         text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
            >
              Reset
            </button>
          </div>

          {/* Topics */}
          <div className="space-y-2 pt-2 border-t border-border-subtle/50">
            <div className="text-[12px] font-semibold text-text-primary">Topics for this meeting</div>
            <p className="text-[11px] text-text-secondary">
              Topics are short, scoped subjects the AI should focus on. They are injected into the
              prompt right after the project description.
            </p>
            {topics === null ? (
              <div className="text-[12px] text-text-secondary/60 py-1">Loading…</div>
            ) : topics.length === 0 ? (
              <div className="text-[12px] text-text-secondary/60 py-1">No topics yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {topics.map((t) => (
                  <TopicItem
                    key={t.id}
                    topic={t}
                    onUpdate={async (updates) => { await updateTopic(t.id, updates); setTopics((prev) => prev ? prev.map((x) => x.id === t.id ? { ...x, ...updates } : x) : prev); }}
                    onDelete={async () => { await deleteTopic(t.id); setTopics((prev) => prev ? prev.filter((x) => x.id !== t.id) : prev); }}
                  />
                ))}
              </ul>
            )}
            <div className="flex items-start gap-2 pt-1">
              <div className="flex-1 grid grid-cols-3 gap-2">
                <input
                  value={newTopicTitle}
                  onChange={(e) => setNewTopicTitle(e.target.value)}
                  placeholder="Topic title (e.g. Refonte DGI)"
                  className="col-span-1 px-2.5 py-1.5 rounded-md bg-bg-item-hover border border-border-subtle
                             text-[12px] text-text-primary placeholder:text-text-secondary/50
                             focus:outline-none focus:border-blue-500/50"
                />
                <input
                  value={newTopicDesc}
                  onChange={(e) => setNewTopicDesc(e.target.value)}
                  placeholder="Short description (optional)"
                  className="col-span-2 px-2.5 py-1.5 rounded-md bg-bg-item-hover border border-border-subtle
                             text-[12px] text-text-primary placeholder:text-text-secondary/50
                             focus:outline-none focus:border-blue-500/50"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddTopic(); }}
                />
              </div>
              <button
                onClick={handleAddTopic}
                disabled={!newTopicTitle.trim()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] font-medium
                           bg-bg-item-hover text-text-secondary hover:text-text-primary hover:bg-bg-item-active
                           disabled:opacity-40 transition-colors"
              >
                <Plus size={11} /> Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const TopicItem: React.FC<{
  topic: ProjectTopicRecord;
  onUpdate: (updates: { title?: string; description?: string }) => Promise<void>;
  onDelete: () => Promise<void>;
}> = ({ topic, onUpdate, onDelete }) => {
  const [title, setTitle] = useState(topic.title);
  const [desc, setDesc] = useState(topic.description);
  const [editing, setEditing] = useState(false);
  const dirty = title !== topic.title || desc !== topic.description;

  return (
    <li className="rounded-md bg-bg-item-hover/50 border border-border-subtle/50 p-2">
      {editing ? (
        <div className="space-y-1.5">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-2 py-1 rounded bg-bg-item-hover border border-border-subtle text-[12px] text-text-primary"
          />
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full px-2 py-1 rounded bg-bg-item-hover border border-border-subtle text-[12px] text-text-primary placeholder:text-text-secondary/50"
          />
          <div className="flex items-center gap-1.5">
            <button
              onClick={async () => { await onUpdate({ title, description: desc }); setEditing(false); }}
              disabled={!dirty}
              className="px-2 py-0.5 rounded text-[11px] bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={() => { setTitle(topic.title); setDesc(topic.description); setEditing(false); }}
              className="px-2 py-0.5 rounded text-[11px] bg-bg-item-hover text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-medium text-text-primary">{topic.title}</div>
            {topic.description && (
              <div className="text-[11px] text-text-secondary mt-0.5">{topic.description}</div>
            )}
          </div>
          <button
            onClick={() => setEditing(true)}
            className="px-1.5 py-0.5 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-item-hover"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded text-text-secondary hover:text-red-400 hover:bg-bg-item-hover"
            title="Delete topic"
          >
            <X size={11} />
          </button>
        </div>
      )}
    </li>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block space-y-1">
    <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary/80">{label}</span>
    {children}
  </label>
);
