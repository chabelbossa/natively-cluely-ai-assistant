import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  Trash2,
  Pencil,
  X,
  Check,
  FileText,
  Upload,
  GripVertical,
  ChevronRight,
  ChevronDown,
  LayoutGrid,
  Settings,
  BookOpen,
  Brain,
  AlertCircle,
  Zap,
  Search,
  Clock,
  Loader2,
  Bug,
  Blocks,
  GitBranch,
  Terminal,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────
type TemplateType =
  | 'general'
  | 'looking-for-work'
  | 'sales'
  | 'recruiting'
  | 'team-meet'
  | 'lecture'
  | 'technical-interview'
  | 'bug-triage'
  | 'feature-planning'
  | 'architecture-review'
  | 'coding-assessment';

interface Mode {
  id: string;
  name: string;
  templateType: TemplateType;
  customContext: string;
  isActive: boolean;
  createdAt: string;
  referenceFileCount?: number;
}

interface ReferenceFile {
  id: string;
  modeId: string;
  fileName: string;
  content: string;
  createdAt: string;
}

interface NoteSection {
  id: string;
  modeId: string;
  title: string;
  description: string;
  sortOrder: number;
  createdAt: string;
}

interface ModesSettingsProps {
  onClose: () => void;
  isPremium: boolean;
  isLoaded: boolean;
  isTrialActive: boolean;
  onOpenNativelyAPI: () => void;
}

// ─── Constants ────────────────────────────────────────────────────
const TEMPLATE_LABELS: Record<TemplateType, string> = {
  general: 'General',
  'looking-for-work': 'Looking for Work',
  sales: 'Sales',
  recruiting: 'Recruiting',
  'team-meet': 'Team Meeting',
  lecture: 'Lecture / Course',
  'technical-interview': 'Technical Interview',
  'bug-triage': 'Bug Triage',
  'feature-planning': 'Feature Planning',
  'architecture-review': 'Architecture Review',
  'coding-assessment': 'Coding Assessment',
};

const TEMPLATE_DESCRIPTIONS: Record<TemplateType, string> = {
  general: 'Universal adaptive copilot — detects context and adapts automatically.',
  'looking-for-work': 'Job interview copilot — helps structure answers and prepare responses.',
  sales: 'Sales call copilot — strategic discovery, objection handling, closing support.',
  recruiting: 'Recruiting interview copilot — candidate evaluation and question guidance.',
  'team-meet': 'Team meeting copilot — action items, decisions, blockers, and follow-ups.',
  lecture: 'Lecture & course copilot — wait for complete points, then suggest clarifying questions.',
  'technical-interview': 'Technical interview copilot — DSA, system design, coding hints.',
  'bug-triage': 'Bug triage copilot — clarify reproduction, impact, priority, and ownership.',
  'feature-planning': 'Feature planning copilot — define scope, acceptance criteria, dependencies.',
  'architecture-review': 'Architecture review copilot — tradeoffs, failure modes, scalability.',
  'coding-assessment': 'Coding assessment copilot — progressive hints, complexity analysis.',
};

const TEMPLATE_ICONS: Record<TemplateType, React.ReactNode> = {
  general: <Brain size={16} />,
  'looking-for-work': <Search size={16} />,
  sales: <Zap size={16} />,
  recruiting: <Search size={16} />,
  'team-meet': <LayoutGrid size={16} />,
  lecture: <BookOpen size={16} />,
  'technical-interview': <Settings size={16} />,
  'bug-triage': <Bug size={16} />,
  'feature-planning': <Blocks size={16} />,
  'architecture-review': <GitBranch size={16} />,
  'coding-assessment': <Terminal size={16} />,
};

const CONTEXT_MAX_LENGTH = 4000;

// ─── Component ──────────────────────────────────────────────────
const ModesSettings: React.FC<ModesSettingsProps> = ({
  onClose,
  isPremium,
  isLoaded: _isLoaded,
  isTrialActive,
  onOpenNativelyAPI,
}) => {
  const hasPro = isPremium || isTrialActive;

  const [modes, setModes] = useState<Mode[]>([]);
  const [activeModeId, setActiveModeId] = useState<string | null>(null);
  const [selectedModeId, setSelectedModeId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Editor state
  const [editName, setEditName] = useState('');
  const [editTemplate, setEditTemplate] = useState<TemplateType>('general');
  const [editContext, setEditContext] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Reference files
  const [referenceFiles, setReferenceFiles] = useState<ReferenceFile[]>([]);
  const [showRefFiles, setShowRefFiles] = useState(false);

  // Note sections
  const [noteSections, setNoteSections] = useState<NoteSection[]>([]);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [newSectionTitle, setNewSectionTitle] = useState('');
  const [newSectionDesc, setNewSectionDesc] = useState('');

  // Create mode
  const [isCreating, setIsCreating] = useState(false);
  const [newModeName, setNewModeName] = useState('');
  const [newModeTemplate, setNewModeTemplate] = useState<TemplateType>('general');
  const [createError, setCreateError] = useState('');

  const nameInputRef = useRef<HTMLInputElement>(null);

  // ─── Load modes ──────────────────────────────────────────────
  const loadModes = useCallback(async () => {
    try {
      const all = await window.electronAPI?.modesGetAll?.();
      const active = await window.electronAPI?.modesGetActive?.();
      setModes((all || []) as Mode[]);
      setActiveModeId(active?.id || null);
      if (all?.length && !selectedModeId) {
        setSelectedModeId(all[0].id);
      }
    } catch (e) {
      console.error('[ModesSettings] Failed to load modes:', e);
    } finally {
      setIsLoading(false);
    }
  }, [selectedModeId]);

  useEffect(() => {
    loadModes();
  }, [loadModes]);

  // ─── Load mode details ───────────────────────────────────────
  useEffect(() => {
    if (!selectedModeId) return;
    const mode = modes.find((m) => m.id === selectedModeId);
    if (mode) {
      setEditName(mode.name);
      setEditTemplate(mode.templateType);
      setEditContext(mode.customContext || '');
      setHasUnsavedChanges(false);
      loadReferenceFiles(selectedModeId);
      loadNoteSections(selectedModeId);
    }
  }, [selectedModeId, modes]);

  const loadReferenceFiles = async (modeId: string) => {
    try {
      const files = await window.electronAPI?.modesGetReferenceFiles?.(modeId);
      setReferenceFiles(files || []);
    } catch (e) {
      console.error('[ModesSettings] Failed to load reference files:', e);
    }
  };

  const loadNoteSections = async (modeId: string) => {
    try {
      const sections = await window.electronAPI?.modesGetNoteSections?.(modeId);
      setNoteSections((sections || []) as NoteSection[]);
    } catch (e) {
      console.error('[ModesSettings] Failed to load note sections:', e);
    }
  };

  // ─── Handlers ──────────────────────────────────────────────
  const selectedMode = modes.find((m) => m.id === selectedModeId);
  const isGeneral = selectedMode?.templateType === 'general';

  const handleSelectMode = (id: string) => {
    if (hasUnsavedChanges) {
      if (!window.confirm('You have unsaved changes. Discard them?')) return;
    }
    setSelectedModeId(id);
  };

  const handleSave = async () => {
    if (!selectedModeId || !editName.trim()) return;
    try {
      await window.electronAPI?.modesUpdate?.(selectedModeId, {
        name: editName.trim(),
        templateType: editTemplate,
        customContext: editContext,
      });
      setHasUnsavedChanges(false);
      loadModes();
    } catch (e: any) {
      console.error('[ModesSettings] Save failed:', e);
      if (e?.message?.includes('pro_required') || e?.error === 'pro_required') {
        alert('This feature requires a Pro license or active trial.');
      }
    }
  };

  const handleDelete = async () => {
    if (!selectedModeId || isGeneral) return;
    if (!window.confirm(`Delete "${editName}"? This cannot be undone.`)) return;
    try {
      await window.electronAPI?.modesDelete?.(selectedModeId);
      const all = await window.electronAPI?.modesGetAll?.();
      setModes((all || []) as Mode[]);
      if (all?.length) {
        setSelectedModeId(all[0].id);
      } else {
        setSelectedModeId(null);
      }
    } catch (e: any) {
      console.error('[ModesSettings] Delete failed:', e);
    }
  };

  const handleSetActive = async (id: string | null) => {
    if (id && !hasPro && id !== 'mode_general_default') {
      alert('Setting a non-general mode as active requires a Pro license or active trial.');
      return;
    }
    try {
      await window.electronAPI?.modesSetActive?.(id);
      setActiveModeId(id);
    } catch (e: any) {
      console.error('[ModesSettings] Set active failed:', e);
      if (e?.message?.includes('pro_required') || e?.error === 'pro_required') {
        alert('This feature requires a Pro license or active trial.');
      }
    }
  };

  const handleCreateMode = async () => {
    if (!newModeName.trim()) {
      setCreateError('Please enter a mode name.');
      return;
    }
    if (!hasPro && newModeTemplate !== 'general') {
      setCreateError('Creating a non-general mode requires Pro. Please select General template.');
      return;
    }
    try {
      const created = await window.electronAPI?.modesCreate?.({
        name: newModeName.trim(),
        templateType: newModeTemplate,
      });
      if (created?.success && created.mode) {
        setSelectedModeId(created.mode.id);
        setActiveModeId(created.mode.id);
      }
      setIsCreating(false);
      setNewModeName('');
      setNewModeTemplate('general');
      setCreateError('');
      loadModes();
    } catch (e: any) {
      setCreateError(e?.error || e?.message || 'Failed to create mode.');
    }
  };

  const handleUploadFile = async () => {
    if (!selectedModeId) return;
    try {
      await window.electronAPI?.modesUploadReferenceFile?.(selectedModeId);
      loadReferenceFiles(selectedModeId);
    } catch (e: any) {
      if (e?.error === 'pro_required') {
        alert('Reference files require a Pro license or active trial.');
      }
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    try {
      await window.electronAPI?.modesDeleteReferenceFile?.(fileId);
      if (selectedModeId) loadReferenceFiles(selectedModeId);
    } catch (e) {
      console.error('[ModesSettings] Delete file failed:', e);
    }
  };

  const handleAddSection = async () => {
    if (!selectedModeId || !newSectionTitle.trim()) return;
    try {
      await window.electronAPI?.modesAddNoteSection?.(
        selectedModeId,
        newSectionTitle.trim(),
        newSectionDesc.trim(),
      );
      setNewSectionTitle('');
      setNewSectionDesc('');
      loadNoteSections(selectedModeId);
    } catch (e: any) {
      if (e?.error === 'pro_required') {
        alert('Note sections require a Pro license or active trial.');
      }
    }
  };

  const handleUpdateSection = async (id: string, title: string, desc: string) => {
    try {
      await window.electronAPI?.modesUpdateNoteSection?.(id, {
        title: title.trim(),
        description: desc.trim(),
      });
      setEditingSection(null);
      if (selectedModeId) loadNoteSections(selectedModeId);
    } catch (e) {
      console.error('[ModesSettings] Update section failed:', e);
    }
  };

  const handleDeleteSection = async (id: string) => {
    try {
      await window.electronAPI?.modesDeleteNoteSection?.(id);
      if (selectedModeId) loadNoteSections(selectedModeId);
    } catch (e) {
      console.error('[ModesSettings] Delete section failed:', e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (isCreating) {
        setIsCreating(false);
        setCreateError('');
      } else {
        onClose();
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (!isCreating) handleSave();
    }
  };

  // ─── Pro Gate ─────────────────────────────────────────────
  if (!hasPro && !isLoading && modes.length <= 1) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <Zap className="text-amber-400/60 mb-4" size={40} />
        <h3 className="text-white/80 text-lg font-semibold mb-2">Pro Feature</h3>
        <p className="text-white/50 text-sm max-w-xs mb-6">
          Custom modes unlock specialized AI copilots for interviews, sales calls, lectures, and more.
        </p>
        <button
          onClick={onOpenNativelyAPI}
          className="px-5 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors"
        >
          Explore Pro Plans
        </button>
      </div>
    );
  }

  // ─── Loading ─────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="animate-spin text-white/30" size={24} />
      </div>
    );
  }

  // ─── Empty ───────────────────────────────────────────────
  if (modes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <LayoutGrid className="text-white/30 mb-4" size={40} />
        <p className="text-white/50 text-sm mb-4">No modes yet. Create your first custom copilot mode.</p>
        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white text-sm transition-colors"
        >
          <Plus size={14} /> Create Mode
        </button>
      </div>
    );
  }

  // ─── Main UI ────────────────────────────────────────────
  return (
    <div className="flex h-full text-white" onKeyDown={handleKeyDown} tabIndex={-1}>
      {/* ─── Sidebar ─────────────────────────────────────── */}
      <div className="w-56 shrink-0 border-r border-white/10 flex flex-col bg-white/[0.03]">
        <div className="p-3 border-b border-white/10 flex items-center justify-between">
          <span className="text-xs font-semibold text-white/60 uppercase tracking-wider">
            Modes
          </span>
          <button
            onClick={() => setIsCreating(true)}
            className="p-1 rounded-md hover:bg-white/10 text-white/60 hover:text-white/90 transition-colors"
            title="Create Mode"
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {modes.map((mode) => (
            <button
              key={mode.id}
              onClick={() => handleSelectMode(mode.id)}
              className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 text-sm transition-colors ${
                selectedModeId === mode.id
                  ? 'bg-white/10 text-white'
                  : 'text-white/60 hover:bg-white/5 hover:text-white/80'
              }`}
            >
              <span className="text-white/40 shrink-0">
                {TEMPLATE_ICONS[mode.templateType] || <Brain size={14} />}
              </span>
              <span className="truncate flex-1">{mode.name}</span>
              {mode.isActive && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              )}
            </button>
          ))}
        </div>
        {!hasPro && (
          <div className="p-2 border-t border-white/10">
            <button
              onClick={onOpenNativelyAPI}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-purple-600/40 hover:bg-purple-600/60 text-purple-200 text-xs font-medium transition-colors"
            >
              <Zap size={12} /> Unlock Pro Modes
            </button>
          </div>
        )}
      </div>

      {/* ─── Editor panel ────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedMode ? (
          <>
            {/* Mode header */}
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <input
                  ref={nameInputRef}
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  className="bg-transparent border-none text-lg font-semibold text-white/90 outline-none focus:ring-0 w-64"
                  placeholder="Mode name..."
                />
                {selectedMode.isActive && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-[10px] font-medium">
                    Active
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!selectedMode.isActive && (
                  <button
                    onClick={() => handleSetActive(selectedMode.id)}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 text-xs font-medium transition-colors"
                  >
                    Set Active
                  </button>
                )}
                {selectedMode.isActive && (
                  <button
                    onClick={() => handleSetActive(null)}
                    className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white/60 text-xs font-medium transition-colors"
                  >
                    Deactivate
                  </button>
                )}
                {!isGeneral && (
                  <button
                    onClick={handleDelete}
                    className="p-1.5 rounded-lg hover:bg-red-500/20 text-white/40 hover:text-red-400 transition-colors"
                    title="Delete mode"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              {/* Template type */}
              <div>
                <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
                  Template Type
                </label>
                <select
                  value={editTemplate}
                  onChange={(e) => {
                    setEditTemplate(e.target.value as TemplateType);
                    setHasUnsavedChanges(true);
                  }}
                  className={`w-full px-3 py-2 rounded-lg border border-white/10 bg-white/[0.06] text-white/80 text-sm outline-none focus:border-purple-500/50 transition-colors ${
                    !hasPro && editTemplate !== 'general' ? 'opacity-50' : ''
                  }`}
                  disabled={!hasPro && editTemplate !== 'general'}
                >
                  {(Object.keys(TEMPLATE_LABELS) as TemplateType[]).map((t) => (
                    <option key={t} value={t} className="bg-[#1a1a1a]">
                      {TEMPLATE_LABELS[t]}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-white/40 mt-1.5">
                  {TEMPLATE_DESCRIPTIONS[editTemplate]}
                </p>
              </div>

              {/* Custom context */}
              <div>
                <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
                  Custom Context / Instructions
                </label>
                <textarea
                  value={editContext}
                  onChange={(e) => {
                    setEditContext(e.target.value);
                    setHasUnsavedChanges(true);
                  }}
                  maxLength={CONTEXT_MAX_LENGTH}
                  rows={5}
                  className="w-full px-3 py-2.5 rounded-lg border border-white/10 bg-white/[0.06] text-white/80 text-sm outline-none focus:border-purple-500/50 resize-none transition-colors"
                  placeholder="Give specific instructions for how the AI should behave in this mode..."
                />
                <div className="flex justify-between items-center mt-1">
                  <p className="text-[10px] text-white/30">
                    Custom instructions for the AI copilot. Supports direct system-prompt-like instructions.
                  </p>
                  <span className="text-[10px] text-white/30">
                    {editContext.length}/{CONTEXT_MAX_LENGTH}
                  </span>
                </div>
              </div>

              {/* Reference files */}
              <div>
                <button
                  onClick={() => setShowRefFiles(!showRefFiles)}
                  className="flex items-center gap-2 text-xs font-semibold text-white/50 uppercase tracking-wider hover:text-white/70 transition-colors"
                >
                  {showRefFiles ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Reference Files ({referenceFiles.length})
                </button>
                {showRefFiles && (
                  <div className="mt-2 space-y-1.5">
                    {referenceFiles.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/5"
                      >
                        <FileText size={13} className="text-white/40 shrink-0" />
                        <span className="text-xs text-white/70 truncate flex-1">
                          {file.fileName}
                        </span>
                        <button
                          onClick={() => handleDeleteFile(file.id)}
                          className="p-1 rounded hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-colors shrink-0"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={handleUploadFile}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-white/10 hover:border-white/20 text-white/40 hover:text-white/60 text-xs transition-colors w-full ${
                        !hasPro ? 'opacity-50 pointer-events-none' : ''
                      }`}
                    >
                      <Upload size={12} /> Upload Reference File
                    </button>
                    {!hasPro && (
                      <p className="text-[10px] text-amber-400/60 flex items-center gap-1">
                        <Zap size={10} /> Pro-only feature
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Note sections */}
              <div>
                <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
                  Summary Note Sections
                </label>
                <p className="text-[10px] text-white/30 mb-3">
                  Define the sections that will appear in your meeting summary when this mode is active.
                </p>
                <div className="space-y-1.5">
                  {noteSections.map((section) => (
                    <div
                      key={section.id}
                      className={`rounded-lg border border-white/5 ${
                        editingSection === section.id
                          ? 'bg-white/[0.06] border-purple-500/30 p-2'
                          : 'bg-white/[0.02] p-2'
                      }`}
                    >
                      {editingSection === section.id ? (
                        <div className="space-y-2">
                          <input
                            autoFocus
                            defaultValue={section.title}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const input = e.target as HTMLInputElement;
                                handleUpdateSection(
                                  section.id,
                                  input.value,
                                  (input.nextElementSibling as HTMLInputElement)?.value || '',
                                );
                              }
                              if (e.key === 'Escape') setEditingSection(null);
                            }}
                            className="w-full px-2 py-1 rounded bg-white/[0.08] border border-white/10 text-white/80 text-xs outline-none"
                            placeholder="Section title"
                          />
                          <input
                            defaultValue={section.description}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const desc = e.target as HTMLInputElement;
                                handleUpdateSection(
                                  section.id,
                                  (desc.previousElementSibling as HTMLInputElement)?.value || '',
                                  desc.value,
                                );
                              }
                            }}
                            className="w-full px-2 py-1 rounded bg-white/[0.08] border border-white/10 text-white/50 text-xs outline-none"
                            placeholder="Short description (optional)"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                const inputs = document.querySelectorAll(
                                  `[data-section-id="${section.id}"]`,
                                ) as NodeListOf<HTMLInputElement>;
                                handleUpdateSection(section.id, inputs[0]?.value || '', inputs[1]?.value || '');
                              }}
                              className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400"
                            >
                              <Check size={12} />
                            </button>
                            <button
                              onClick={() => setEditingSection(null)}
                              className="p-1 rounded hover:bg-white/10 text-white/40"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className="flex items-center gap-2 cursor-pointer"
                          onClick={() => setEditingSection(section.id)}
                        >
                          <GripVertical size={12} className="text-white/20 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-white/80 truncate">{section.title}</p>
                            {section.description && (
                              <p className="text-[10px] text-white/40 truncate">
                                {section.description}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSection(section.id);
                            }}
                            className="p-1 rounded hover:bg-red-500/20 text-white/20 hover:text-red-400 transition-colors shrink-0"
                          >
                            <X size={11} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {/* Add section form */}
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={newSectionTitle}
                    onChange={(e) => setNewSectionTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddSection();
                    }}
                    placeholder="New section title..."
                    className={`flex-1 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-white/70 text-xs outline-none focus:border-purple-500/30 ${
                      !hasPro ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  />
                  <input
                    value={newSectionDesc}
                    onChange={(e) => setNewSectionDesc(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddSection();
                    }}
                    placeholder="Description (optional)"
                    className={`hidden sm:block w-40 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-white/50 text-xs outline-none focus:border-purple-500/30 ${
                      !hasPro ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  />
                  <button
                    onClick={handleAddSection}
                    disabled={!newSectionTitle.trim() || !hasPro}
                    className="p-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white/60 disabled:opacity-30 transition-colors"
                  >
                    <Plus size={13} />
                  </button>
                </div>
                {!hasPro && (
                  <p className="text-[10px] text-amber-400/60 mt-1.5 flex items-center gap-1">
                    <Zap size={10} /> Pro-only feature
                  </p>
                )}
              </div>
            </div>

            {/* Bottom bar */}
            <div className="p-3 border-t border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[10px] text-white/30">
                <Clock size={11} />
                {selectedMode.createdAt
                  ? new Date(selectedMode.createdAt).toLocaleDateString()
                  : ''}
              </div>
              <div className="flex items-center gap-2">
                {hasUnsavedChanges && (
                  <span className="text-[10px] text-amber-400/60 flex items-center gap-1">
                    <AlertCircle size={10} /> Unsaved changes
                  </span>
                )}
                <button
                  onClick={handleSave}
                  disabled={!hasUnsavedChanges}
                  className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-white/10 disabled:text-white/30 text-white text-xs font-medium transition-colors"
                >
                  Save
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-white/30 text-sm">
            Select a mode to configure
          </div>
        )}
      </div>

      {/* ─── Create mode modal ────────────────────────────── */}
      <AnimatePresence>
        {isCreating && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setIsCreating(false);
                setCreateError('');
              }
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              className="w-96 p-5 rounded-xl bg-[#1a1a1a] border border-white/10 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-white/90 font-semibold mb-4 flex items-center gap-2">
                <Plus size={16} /> Create New Mode
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-[11px] font-semibold text-white/50 uppercase tracking-wider mb-1.5">
                    Name
                  </label>
                  <input
                    autoFocus
                    value={newModeName}
                    onChange={(e) => {
                      setNewModeName(e.target.value);
                      setCreateError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateMode();
                    }}
                    placeholder="e.g., Client Meeting, Tech Interview..."
                    className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/[0.06] text-white/80 text-sm outline-none focus:border-purple-500/50"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-white/50 uppercase tracking-wider mb-1.5">
                    Template
                  </label>
                  <select
                    value={newModeTemplate}
                    onChange={(e) => {
                      setNewModeTemplate(e.target.value as TemplateType);
                      setCreateError('');
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/[0.06] text-white/80 text-sm outline-none focus:border-purple-500/50"
                  >
                    {(Object.keys(TEMPLATE_LABELS) as TemplateType[]).map((t) => (
                      <option key={t} value={t} className="bg-[#1a1a1a]">
                        {TEMPLATE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
                {createError && (
                  <p className="text-xs text-red-400 flex items-center gap-1">
                    <AlertCircle size={11} /> {createError}
                  </p>
                )}
                {!hasPro && newModeTemplate !== 'general' && (
                  <p className="text-xs text-amber-400/60 flex items-center gap-1">
                    <Zap size={10} /> Non-general templates require Pro
                  </p>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 mt-5">
                <button
                  onClick={() => {
                    setIsCreating(false);
                    setCreateError('');
                  }}
                  className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateMode}
                  className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors"
                >
                  Create
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ModesSettings;
