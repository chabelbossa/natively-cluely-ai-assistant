import React from 'react';
import { X, Zap, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface ToasterProps {
  isOpen: boolean;
  onDismiss: (campaignId?: string) => void;
  onUpgrade: () => void;
}

export const PremiumPromoToaster: React.FC<ToasterProps> = ({
  isOpen,
  onDismiss,
  onUpgrade,
}) => (
  <AnimatePresence>
    {isOpen && (
      <motion.div
        initial={{ opacity: 0, y: -20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.95 }}
        className="fixed top-4 right-4 z-50 w-80 p-4 rounded-xl border border-purple-500/30 bg-purple-500/[0.08] backdrop-blur-xl shadow-2xl"
      >
        <button
          onClick={() => onDismiss('promo')}
          className="absolute top-3 right-3 p-1 rounded-lg hover:bg-white/10 text-white/40 transition-colors"
        >
          <X size={13} />
        </button>
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-purple-500/20 border border-purple-500/30 shrink-0">
            <Zap size={16} className="text-purple-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-white/90 text-sm font-semibold mb-1">
              Unlock Premium Features
            </h4>
            <p className="text-white/50 text-xs mb-3 leading-relaxed">
              Custom copilot modes, reference files, profile intelligence, and real-time coaching.
            </p>
            <button
              onClick={() => { onDismiss('promo'); onUpgrade(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition-colors"
            >
              Upgrade Now <ArrowRight size={11} />
            </button>
          </div>
        </div>
      </motion.div>
    )}
  </AnimatePresence>
);
