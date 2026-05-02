import React, { useEffect, useState } from 'react';
import { Lightbulb, TrendingUp, AlertTriangle, Target, DollarSign, MessageCircle } from 'lucide-react';
import { motion } from 'framer-motion';

interface NegotiationCoachingCardProps {
  phase?: string;
  currentPhase?: string;
  silenceRisk?: boolean;
  showSilenceTimer?: boolean;
  objectionDetected?: string;
  priceSensitivity?: number;
  confidence?: number;
  suggestions?: string[];
  onSilenceTimerEnd?: () => void;
}

const PHASE_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  opening: { icon: <MessageCircle size={14} />, color: 'text-blue-400', label: 'Build Rapport' },
  discovery: { icon: <Target size={14} />, color: 'text-purple-400', label: 'Discovery' },
  presentation: { icon: <Lightbulb size={14} />, color: 'text-amber-400', label: 'Present Value' },
  objection: { icon: <AlertTriangle size={14} />, color: 'text-red-400', label: 'Handle Objections' },
  negotiation: { icon: <DollarSign size={14} />, color: 'text-emerald-400', label: 'Negotiate' },
  closing: { icon: <TrendingUp size={14} />, color: 'text-green-400', label: 'Close' },
  follow_up: { icon: <MessageCircle size={14} />, color: 'text-teal-400', label: 'Follow Up' },
};

export const NegotiationCoachingCard: React.FC<NegotiationCoachingCardProps> = ({
  phase,
  currentPhase,
  silenceRisk,
  showSilenceTimer,
  objectionDetected,
  priceSensitivity,
  confidence,
  suggestions = [],
  onSilenceTimerEnd,
}) => {
  const activePhase = phase || currentPhase || 'discovery';
  const phaseConfig = PHASE_CONFIG[activePhase] || PHASE_CONFIG.discovery;

  const [silenceTimer, setSilenceTimer] = useState(showSilenceTimer ? 10 : 0);

  useEffect(() => {
    if (!showSilenceTimer) return;
    setSilenceTimer(10);
    const interval = setInterval(() => {
      setSilenceTimer((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          onSilenceTimerEnd?.();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [showSilenceTimer]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur-md overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-1 rounded-md bg-white/[0.06] ${phaseConfig.color}`}>
            {phaseConfig.icon}
          </div>
          <span className="text-xs font-semibold text-white/70">
            {phaseConfig.label}
          </span>
        </div>
        {confidence !== undefined && (
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.round(confidence * 100)}%` }}
                className={`h-full rounded-full ${
                  confidence > 0.7
                    ? 'bg-emerald-400'
                    : confidence > 0.4
                      ? 'bg-amber-400'
                      : 'bg-red-400'
                }`}
              />
            </div>
            <span className="text-[10px] text-white/40">{Math.round(confidence * 100)}%</span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {/* Silence timer */}
        {silenceTimer > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/15">
            <AlertTriangle size={14} className="text-amber-400 shrink-0" />
            <span className="text-xs text-amber-300/80">
              {silenceRisk
                ? 'Long silence — the prospect may be disengaging.'
                : 'Pause detected. Consider asking an open question.'}
            </span>
            <span className="ml-auto text-[10px] text-amber-400/60 font-mono">
              {silenceTimer}s
            </span>
          </div>
        )}

        {/* Objection alert */}
        {objectionDetected && (
          <div className="px-3 py-2 rounded-lg bg-red-500/[0.06] border border-red-500/15">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle size={13} className="text-red-400 shrink-0" />
              <span className="text-xs font-medium text-red-300/90">
                Objection Detected
              </span>
            </div>
            <p className="text-xs text-red-300/70 pl-6">
              {objectionDetected}
            </p>
          </div>
        )}

        {/* Price sensitivity gauge */}
        {priceSensitivity !== undefined && priceSensitivity > 0.5 && (
          <div className="px-3 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/15">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign size={13} className="text-amber-400 shrink-0" />
              <span className="text-xs font-medium text-amber-300/90">
                Price Sensitivity: {Math.round(priceSensitivity * 100)}%
              </span>
            </div>
            <p className="text-xs text-amber-300/70 pl-6">
              The prospect shows sensitivity to pricing. Focus on value and ROI rather than features.
            </p>
          </div>
        )}

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Lightbulb size={12} className="text-purple-400/70" />
              <span className="text-[10px] font-semibold text-purple-400/70 uppercase tracking-wider">
                Suggested Responses
              </span>
            </div>
            {suggestions.map((suggestion, i) => (
              <div
                key={i}
                className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06] text-xs text-white/70 leading-relaxed"
              >
                {suggestion}
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
};
