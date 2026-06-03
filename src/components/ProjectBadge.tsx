import React from 'react';
import { Folder, FolderOpen, X } from 'lucide-react';
import type { ProjectContextRecord } from '../hooks/useProjectContext';

interface ProjectBadgeProps {
  active: ProjectContextRecord | null;
  onOpen: () => void;
  onClear: () => void;
}

export const ProjectBadge: React.FC<ProjectBadgeProps> = ({ active, onOpen, onClear }) => {
  if (!active) {
    return (
      <button
        onClick={onOpen}
        className="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium
                   bg-bg-item-hover/60 text-text-secondary hover:text-text-primary hover:bg-bg-item-active
                   border border-border-subtle transition-colors"
        title="Pick a project for this meeting"
      >
        <Folder size={12} className="opacity-70 group-hover:opacity-100" />
        <span>Pick project</span>
      </button>
    );
  }

  return (
    <div className="group inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full text-[11px] font-medium
                    bg-blue-500/15 text-blue-300 border border-blue-500/30 hover:bg-blue-500/20 transition-colors">
      <button
        onClick={onOpen}
        className="inline-flex items-center gap-1.5"
        title={`Active project: ${active.name}\n${active.rootPath}`}
      >
        <FolderOpen size={12} />
        <span className="max-w-[140px] truncate">{active.name}</span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onClear(); }}
        className="ml-0.5 p-0.5 rounded-full hover:bg-blue-500/30 transition-colors"
        title="Clear active project"
        aria-label="Clear active project"
      >
        <X size={10} />
      </button>
    </div>
  );
};
