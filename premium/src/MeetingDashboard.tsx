import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  UserCheck,
  Gauge,
} from 'lucide-react';

interface MeetingDashboardProps {
  health?: {
    clarityScore: number;
    openRisks: number;
    confirmedDecisions: number;
    unassignedActions: number;
    openQuestions: number;
    readyToSuggest: number;
    actions?: { task: string; owner?: string; deadline?: string }[];
    constraints?: string[];
    topics?: string[];
    deadlines?: string[];
    responsibilities?: string[];
    summarySoFar?: string;
  } | null;
  risks?: { type: string; explanation: string; severity: string }[];
  isLightTheme?: boolean;
}

export const MeetingDashboard: React.FC<MeetingDashboardProps> = ({
  health,
  risks = [],
  isLightTheme = false,
}) => {
  if (!health) return null;

  const scoreColor =
    health.clarityScore >= 7
      ? 'text-emerald-400'
      : health.clarityScore >= 4
        ? 'text-amber-400'
        : 'text-red-400';
  const shellClass = isLightTheme
    ? 'rounded-xl border border-black/10 bg-white/72 backdrop-blur-md overflow-hidden'
    : 'rounded-xl border border-white/[0.10] bg-black/22 backdrop-blur-md overflow-hidden';
  const headerBorderClass = isLightTheme ? 'border-black/10' : 'border-white/[0.10]';
  const headerIconClass = isLightTheme ? 'text-slate-500' : 'text-white/45';
  const headerTextClass = isLightTheme ? 'text-slate-600' : 'text-white/55';
  const neutralMetricClass = isLightTheme ? 'text-slate-400' : 'text-white/30';
  const metrics = [
    {
      icon: <CheckCircle2 size={11} />,
      label: 'Decisions',
      value: health.confirmedDecisions,
      color: 'text-emerald-400',
    },
    {
      icon: <AlertTriangle size={11} />,
      label: 'Risks',
      value: health.openRisks,
      color: health.openRisks > 0 ? 'text-red-400' : neutralMetricClass,
    },
    {
      icon: <HelpCircle size={11} />,
      label: 'Questions',
      value: health.openQuestions,
      color: health.openQuestions > 0 ? 'text-amber-400' : neutralMetricClass,
    },
    {
      icon: <UserCheck size={11} />,
      label: 'Unassigned',
      value: health.unassignedActions,
      color: health.unassignedActions > 0 ? 'text-red-400' : neutralMetricClass,
    },
  ];

  return (
    <div className={shellClass}>
      {/* Header */}
      <div className={`px-3 py-2 border-b flex items-center justify-between gap-3 ${headerBorderClass}`}>
        <div className="flex items-center gap-1.5 shrink-0">
          <Gauge size={13} className={headerIconClass} />
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${headerTextClass}`}>
            Meeting Health
          </span>
        </div>
        <div className="ml-auto flex min-w-0 items-center justify-end gap-1.5">
          {metrics.map((metric) => (
            <Indicator
              key={metric.label}
              icon={metric.icon}
              label={metric.label}
              value={metric.value}
              color={metric.color}
              isLightTheme={isLightTheme}
            />
          ))}
          <span className={`ml-1 text-xs font-bold tabular-nums ${scoreColor}`}>
            {health.clarityScore}/10
          </span>
        </div>
      </div>

      {(health.topics?.length || health.actions?.length || health.constraints?.length) ? (
        <div className="px-3 py-2 space-y-1.5">
          {health.topics?.length ? (
            <CompactList title="Focus" items={health.topics.slice(-4)} isLightTheme={isLightTheme} />
          ) : null}
          {health.actions?.length ? (
            <CompactList
              title="Next"
              items={health.actions.slice(-3).map((item) => {
                const meta = [item.owner, item.deadline].filter(Boolean).join(' / ');
                return meta ? `${item.task} (${meta})` : item.task;
              })}
              isLightTheme={isLightTheme}
            />
          ) : null}
          {health.constraints?.length ? (
            <CompactList title="Constraints" items={health.constraints.slice(-2)} isLightTheme={isLightTheme} />
          ) : null}
        </div>
      ) : null}

      {/* Risk alerts */}
      {risks.filter((r) => r.severity === 'high').length > 0 && (
        <div className="px-3 pb-3">
          {risks
            .filter((r) => r.severity === 'high')
            .slice(0, 2)
            .map((risk, i) => (
              <div
                key={i}
                className={`flex items-start gap-1.5 px-2 py-1.5 rounded-lg border mb-1 last:mb-0 ${
                  isLightTheme
                    ? 'bg-red-500/8 border-red-500/20'
                    : 'bg-red-500/[0.06] border-red-500/12'
                }`}
              >
                <AlertTriangle size={10} className="text-red-400 mt-0.5 shrink-0" />
                <span className={`text-[10px] leading-relaxed ${isLightTheme ? 'text-red-700/95' : 'text-red-300/80'}`}>
                  {risk.explanation}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
};

function Indicator({
  icon,
  label,
  value,
  color,
  isLightTheme = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  isLightTheme?: boolean;
}) {
  const surfaceClass = isLightTheme
    ? 'bg-white/50 border-black/8'
    : 'bg-white/[0.035] border-white/[0.06]';
  return (
    <div
      className={`flex h-6 items-center gap-1 rounded-full border px-1.5 ${surfaceClass}`}
      title={`${label}: ${value}`}
      aria-label={`${label}: ${value}`}
    >
      <span className={color}>{icon}</span>
      <span className={`text-[10px] font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

function CompactList({
  title,
  items,
  isLightTheme = false,
}: {
  title: string;
  items: string[];
  isLightTheme?: boolean;
}) {
  if (items.length === 0) return null;
  const surfaceClass = isLightTheme
    ? 'bg-white/55 border-black/8'
    : 'bg-white/[0.03] border-white/[0.04]';
  const titleClass = isLightTheme ? 'text-slate-500' : 'text-white/35';
  const textClass = isLightTheme ? 'text-slate-700' : 'text-white/55';
  return (
    <div className={`rounded-lg border px-2 py-1.5 ${surfaceClass}`}>
      <div className={`text-[8.5px] uppercase tracking-wider font-semibold mb-1 ${titleClass}`}>
        {title}
      </div>
      <div className="flex flex-wrap gap-1">
        {items.slice(-6).map((item, index) => (
          <div
            key={`${title}-${index}`}
            className={`max-w-full rounded-md px-1.5 py-0.5 text-[9.5px] leading-snug ${textClass} ${
              isLightTheme ? 'bg-black/[0.035]' : 'bg-white/[0.035]'
            }`}
          >
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
