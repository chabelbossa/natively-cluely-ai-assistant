import React from 'react';
import { X, User, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface ToasterProps {
  isOpen: boolean;
  onDismiss: (campaignId?: string) => void;
  onSetupProfile: () => void;
}

export const ProfileFeatureToaster: React.FC<ToasterProps> = ({
  isOpen,
  onDismiss,
  onSetupProfile,
}) => (
  <AnimatePresence>
    {isOpen && (
      <motion.div
        initial={{ opacity: 0, y: -20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.95 }}
        className="fixed top-4 right-4 z-50 w-80 p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] backdrop-blur-xl shadow-2xl"
      >
        <button
          onClick={() => onDismiss('profile')}
          className="absolute top-3 right-3 p-1 rounded-lg hover:bg-white/10 text-white/40 transition-colors"
        >
          <X size={13} />
        </button>
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 shrink-0">
            <User size={16} className="text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-white/90 text-sm font-semibold mb-1">
              Build Your Professional Profile
            </h4>
            <p className="text-white/50 text-xs mb-3 leading-relaxed">
              Upload your resume and job descriptions so Natively can give you personalized interview and meeting coaching.
            </p>
            <button
              onClick={() => { onDismiss('profile'); onSetupProfile(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
            >
              Set Up Profile <ArrowRight size={11} />
            </button>
          </div>
        </div>
      </motion.div>
    )}
  </AnimatePresence>
);
