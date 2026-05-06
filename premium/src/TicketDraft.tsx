import React, { useState } from 'react';
import { FileText, Copy, Check } from 'lucide-react';

interface TrackedDecision {
  what: string;
  owner?: string;
}

interface TrackedRisk {
  description: string;
  severity: string;
}

interface TicketDraftProps {
  mode?: string;
  decisions?: TrackedDecision[];
  risks?: TrackedRisk[];
  actions?: { task: string; owner?: string; deadline?: string }[];
}

function generateTicketDraft(props: TicketDraftProps): string {
  const mode = props.mode || 'feature';
  const lines: string[] = [];
  lines.push(`### ${mode === 'bug_triage' ? 'Bug: ' : 'Task: '}${mode}`);

  if (props.decisions?.length) {
    lines.push('');
    lines.push('**Context**');
    props.decisions.forEach((d) =>
      lines.push(`- ${d.what}${d.owner ? ` (Owner: ${d.owner})` : ''}`),
    );
  }

  if (props.risks?.length) {
    lines.push('');
    lines.push('**Risks**');
    props.risks.forEach((r) =>
      lines.push(`- [${r.severity}] ${r.description}`),
    );
  }

  if (props.actions?.length) {
    lines.push('');
    lines.push('**Action Items**');
    props.actions.forEach((a) =>
      lines.push(
        `- [ ] ${a.task}${a.owner ? ` → @${a.owner}` : ''}${a.deadline ? ` ⏱ ${a.deadline}` : ''}`,
      ),
    );
  }

  lines.push('');
  lines.push('**Acceptance Criteria**');
  lines.push('- [ ] Criteria 1');
  lines.push('- [ ] Criteria 2');

  return lines.join('\n');
}

export const TicketDraft: React.FC<TicketDraftProps> = (props) => {
  const [copied, setCopied] = useState(false);
  const draft = generateTicketDraft(props);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <FileText size={13} className="text-white/40" />
          <span className="text-[10px] font-semibold text-white/50 uppercase tracking-wider">
            Ticket Draft
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white/50 hover:text-white/70 text-[10px] transition-colors"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-3 text-[10px] text-white/60 font-mono whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
        {draft}
      </pre>
    </div>
  );
};
