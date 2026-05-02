import React, { useState } from 'react';
import { X, Zap, Check, Crown, Star, ArrowRight, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface PremiumUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  isPremium: boolean;
  onActivated: () => void;
  onDeactivated?: () => void;
}

const plans = [
  {
    id: 'free',
    name: 'Free',
    icon: <Star size={16} />,
    price: '$0',
    period: 'forever',
    features: [
      'Basic transcription',
      '1 general mode only',
      'Manual chat assistance',
      'Single AI provider key',
    ],
    missing: [
      'Custom copilot modes',
      'Reference files',
      'Profile intelligence',
      'Real-time coaching',
      'Natively API',
    ],
  },
  {
    id: 'premium',
    name: 'Premium',
    icon: <Zap size={16} />,
    price: '$19',
    period: '/month',
    highlight: true,
    features: [
      'Everything in Free',
      'Unlimited custom modes',
      'Reference file uploads',
      'Profile intelligence + CV',
      'Real-time coaching',
      'Negotiation scripts',
      'Company research',
      'Custom summary sections',
    ],
    missing: [],
  },
  {
    id: 'ultra',
    name: 'Ultra',
    icon: <Crown size={16} />,
    price: '$39',
    period: '/month',
    features: [
      'Everything in Premium',
      'Natively API access',
      'Priority AI processing',
      'Advanced analytics',
      'Calendar integration',
      'Email follow-ups',
      'Team collaboration',
    ],
    missing: [],
  },
];

export const PremiumUpgradeModal: React.FC<PremiumUpgradeModalProps> = ({
  isOpen,
  onClose,
  isPremium,
  onActivated,
  onDeactivated,
}) => {
  const [activating, setActivating] = useState(false);
  const [activatingPlan, setActivatingPlan] = useState<string | null>(null);
  const [licenseKey, setLicenseKey] = useState('');
  const [licenseError, setLicenseError] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);

  const handleActivate = async () => {
    if (!licenseKey.trim()) {
      setLicenseError('Please enter a license key.');
      return;
    }
    setActivating(true);
    setLicenseError('');
    try {
      const result = await window.electronAPI?.licenseActivate?.(licenseKey.trim());
      if (result?.success) {
        onActivated();
        setShowKeyInput(false);
        setLicenseKey('');
      } else {
        setLicenseError(result?.error || 'Invalid license key.');
      }
    } catch (e: any) {
      setLicenseError(e?.message || 'Activation failed. Check your connection and try again.');
    } finally {
      setActivating(false);
    }
  };

  const handleManageSubscription = () => {
    window.electronAPI?.openExternal?.('https://natively.software/account');
  };

  const handleStartTrial = async () => {
    setActivating(true);
    setActivatingPlan('trial');
    try {
      const result = await window.electronAPI?.startTrial?.();
      if (result?.ok) {
        onActivated();
      } else {
        setLicenseError(result?.error || 'Could not start trial.');
      }
    } catch (e: any) {
      setLicenseError(e?.message || 'Trial activation failed.');
    } finally {
      setActivating(false);
      setActivatingPlan(null);
    }
  };

  // ─── Already premium ───────────────────────────────────────
  if (isPremium) {
    return (
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-[420px] p-6 rounded-2xl bg-[#1a1a1a] border border-white/10 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-white/90 font-semibold text-lg">Your Plan</h2>
                <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 transition-colors">
                  <X size={16} />
                </button>
              </div>
              <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Check size={18} className="text-emerald-400" />
                  <span className="text-emerald-400 font-semibold">Premium Active</span>
                </div>
                <p className="text-white/60 text-sm">
                  You have access to all premium features including custom modes, reference files, and profile intelligence.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleManageSubscription}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white/70 text-sm font-medium transition-colors"
                >
                  Manage Subscription
                </button>
                {onDeactivated && (
                  <button
                    onClick={onDeactivated}
                    className="px-4 py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm font-medium transition-colors"
                  >
                    Deactivate
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  // ─── Upgrade screen ──────────────────────────────────────
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm overflow-y-auto py-10"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            className="w-[720px] max-w-[95vw] rounded-2xl bg-[#1a1a1a] border border-white/10 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="p-5 border-b border-white/10 flex items-center justify-between">
              <div>
                <h2 className="text-white/90 font-semibold text-lg flex items-center gap-2">
                  <Zap size={18} className="text-purple-400" />
                  Upgrade to Pro
                </h2>
                <p className="text-white/40 text-sm mt-0.5">
                  Unlock the full potential of Natively
                </p>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Plans grid */}
            <div className="p-5 grid grid-cols-3 gap-3">
              {plans.map((plan) => (
                <div
                  key={plan.id}
                  className={`rounded-xl border p-4 flex flex-col ${
                    plan.highlight
                      ? 'border-purple-500/30 bg-purple-500/[0.06]'
                      : 'border-white/[0.08] bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <span className={plan.highlight ? 'text-purple-400' : 'text-white/50'}>
                      {plan.icon}
                    </span>
                    <span className={`font-semibold text-sm ${plan.highlight ? 'text-purple-400' : 'text-white/70'}`}>
                      {plan.name}
                    </span>
                    {plan.highlight && (
                      <span className="ml-auto px-1.5 py-0.5 rounded bg-purple-500/20 text-[9px] text-purple-400 font-medium">
                        POPULAR
                      </span>
                    )}
                  </div>
                  <div className="mb-3">
                    <span className="text-2xl font-bold text-white/90">{plan.price}</span>
                    <span className="text-xs text-white/40 ml-1">{plan.period}</span>
                  </div>
                  <div className="space-y-1.5 flex-1">
                    {plan.features.map((f, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        <Check size={12} className="text-emerald-400/70 mt-0.5 shrink-0" />
                        <span className="text-[11px] text-white/60">{f}</span>
                      </div>
                    ))}
                    {plan.missing.map((f, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        <X size={12} className="text-white/20 mt-0.5 shrink-0" />
                        <span className="text-[11px] text-white/25">{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="p-5 border-t border-white/10 space-y-3">
              {showKeyInput ? (
                <div>
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={licenseKey}
                      onChange={(e) => {
                        setLicenseKey(e.target.value);
                        setLicenseError('');
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleActivate(); }}
                      placeholder="Enter your license key..."
                      className="flex-1 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.06] text-white/80 text-sm outline-none focus:border-purple-500/50"
                    />
                    <button
                      onClick={handleActivate}
                      disabled={activating}
                      className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-white/10 text-white text-sm font-medium transition-colors flex items-center gap-1.5"
                    >
                      {activating ? <Loader2 size={14} className="animate-spin" /> : null}
                      Activate
                    </button>
                    <button
                      onClick={() => { setShowKeyInput(false); setLicenseError(''); }}
                      className="px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 text-sm transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                  {licenseError && (
                    <p className="text-xs text-red-400 mt-1.5">{licenseError}</p>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowKeyInput(true)}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white/70 text-sm font-medium transition-colors flex items-center justify-center gap-1.5"
                  >
                    Activate License <ArrowRight size={14} />
                  </button>
                  <button
                    onClick={handleManageSubscription}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-white/50 text-sm font-medium transition-colors"
                  >
                    Subscribe
                  </button>
                  <button
                    onClick={handleStartTrial}
                    disabled={activating}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/20 text-emerald-300 text-sm font-medium transition-colors flex items-center justify-center gap-1.5"
                  >
                    {activatingPlan === 'trial' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : null}
                    Start Free Trial
                  </button>
                </div>
              )}
              <p className="text-[10px] text-white/25 text-center">
                Natively is free and open-source. Premium features support ongoing development.
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
