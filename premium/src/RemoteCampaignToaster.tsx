import React from 'react';
import { X, Megaphone, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface RemoteCampaign {
  id: string;
  title?: string;
  body?: string;
  cta?: string;
  ctaUrl?: string;
  priority?: number;
}

interface ToasterProps {
  isOpen: boolean;
  campaign?: RemoteCampaign;
  onDismiss: (campaignId?: string) => void;
}

export const RemoteCampaignToaster: React.FC<ToasterProps> = ({
  isOpen,
  campaign,
  onDismiss,
}) => {
  if (!campaign) return null;

  const handleCta = () => {
    if (campaign.ctaUrl) {
      window.electronAPI?.openExternal?.(campaign.ctaUrl);
    }
    onDismiss(campaign.id);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          className="fixed top-4 right-4 z-50 w-80 p-4 rounded-xl border border-rose-500/30 bg-rose-500/[0.08] backdrop-blur-xl shadow-2xl"
        >
          <button
            onClick={() => onDismiss(campaign.id)}
            className="absolute top-3 right-3 p-1 rounded-lg hover:bg-white/10 text-white/40 transition-colors"
          >
            <X size={13} />
          </button>
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-rose-500/20 border border-rose-500/30 shrink-0">
              <Megaphone size={16} className="text-rose-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-white/90 text-sm font-semibold mb-1">
                {campaign.title || 'Special Offer'}
              </h4>
              {campaign.body && (
                <p className="text-white/50 text-xs mb-3 leading-relaxed">{campaign.body}</p>
              )}
              {campaign.cta && (
                <button
                  onClick={handleCta}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium transition-colors"
                >
                  {campaign.cta} <ExternalLink size={11} />
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
