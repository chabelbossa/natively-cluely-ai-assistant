import React from 'react';
import { X, Globe, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface ToasterProps {
  isOpen: boolean;
  onDismiss: (campaignId?: string) => void;
  onOpenSettings: (tab: string) => void;
}

export const NativelyApiPromoToaster: React.FC<ToasterProps> = ({
  isOpen,
  onDismiss,
  onOpenSettings,
}) => (
  <AnimatePresence>
    {isOpen && (
      <motion.div
        initial={{ opacity: 0, y: -20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.95 }}
        className="fixed top-4 right-4 z-50 w-80 p-4 rounded-xl border border-blue-500/30 bg-blue-500/[0.08] backdrop-blur-xl shadow-2xl"
      >
        <button
          onClick={() => onDismiss('natively_api')}
          className="absolute top-3 right-3 p-1 rounded-lg hover:bg-white/10 text-white/40 transition-colors"
        >
          <X size={13} />
        </button>
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-blue-500/20 border border-blue-500/30 shrink-0">
            <Globe size={16} className="text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-white/90 text-sm font-semibold mb-1">
              Connect Natively API
            </h4>
            <p className="text-white/50 text-xs mb-3 leading-relaxed">
              Get managed STT, AI processing, and cloud sync with the Natively API.
            </p>
            <button
              onClick={() => { onDismiss('natively_api'); onOpenSettings('natively-api'); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
            >
              Set Up API <ArrowRight size={11} />
            </button>
          </div>
        </div>
      </motion.div>
    )}
  </AnimatePresence>
);
