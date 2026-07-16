import { useState, useEffect, useCallback } from 'react';

interface PlanDetails {
  isPremium: boolean;
  plan?: string;
  provider?: string;
}

interface RemoteCampaign {
  id: string;
  title?: string;
  body?: string;
  cta?: string;
  ctaUrl?: string;
  priority?: number;
}

type ActiveAd = string | RemoteCampaign | null;

// ─── Campaign rules ────────────────────────────────────────────────
const MEETING_MIN_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const MEETING_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

// localStorage keys for cooldowns
const LAST_SHOWN_KEY = 'natively_ad_last_shown';
const SHOWN_TODAY_KEY = 'natively_ad_shown_today';

function getCooldownRemaining(campaignId: string): number {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_SHOWN_KEY) || '{}');
    const lastShown = stored[campaignId];
    if (!lastShown) return 0;
    const elapsed = Date.now() - lastShown;
    return Math.max(0, SESSION_COOLDOWN_MS - elapsed);
  } catch {
    return 0;
  }
}

function setLastShown(campaignId: string): void {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_SHOWN_KEY) || '{}');
    stored[campaignId] = Date.now();
    localStorage.setItem(LAST_SHOWN_KEY, JSON.stringify(stored));
  } catch {
    // Ignore storage errors
  }
}

function getShownTodayCount(): number {
  try {
    const data = JSON.parse(localStorage.getItem(SHOWN_TODAY_KEY) || '{}');
    const today = new Date().toDateString();
    return data[today] || 0;
  } catch {
    return 0;
  }
}

function incrementShownToday(): void {
  try {
    const data = JSON.parse(localStorage.getItem(SHOWN_TODAY_KEY) || '{}');
    const today = new Date().toDateString();
    data[today] = (data[today] || 0) + 1;
    localStorage.setItem(SHOWN_TODAY_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage errors
  }
}

export function useAdCampaigns(
  planDetails: PlanDetails,
  hasProfile: boolean,
  isAppReady: boolean,
  appStartTime?: number,
  lastMeetingEndTime?: number | null,
  isProcessingMeeting?: boolean,
  hasNativelyApi?: boolean,
) {
  const [activeAd, setActiveAd] = useState<ActiveAd>(null);
  const [shownToday, setShownToday] = useState(0);
  const adsDisabled = true;

  // Update shown count
  useEffect(() => {
    setShownToday(getShownTodayCount());
  }, [activeAd]);

  const dismissAd = useCallback(
    (campaignId?: string) => {
      if (campaignId) setLastShown(campaignId);
      setActiveAd(null);
    },
    [],
  );

  const previewAd = useCallback((ad: any) => {
    if (adsDisabled) return;
    if (typeof ad === 'string') {
      setActiveAd(ad);
    } else if (ad && typeof ad === 'object') {
      setActiveAd(ad as RemoteCampaign);
    }
  }, [adsDisabled]);

  // ─── Auto-select campaign based on user state ─────────────────
  useEffect(() => {
    if (adsDisabled) return;
    if (!isAppReady) return;
    if (planDetails.isPremium) return;

    const maxDaily = 3;
    const todayCount = getShownTodayCount();
    if (todayCount >= maxDaily) return;

    // Priority 1: Natively API promo (if not yet using it)
    if (!hasNativelyApi) {
      const cooldown = getCooldownRemaining('natively_api');
      if (cooldown === 0) {
        setActiveAd('natively_api');
        incrementShownToday();
        setLastShown('natively_api');
        return;
      }
    }

    // Priority 2: Profile feature (if no profile set up)
    if (!hasProfile) {
      const cooldown = getCooldownRemaining('profile');
      if (cooldown === 0) {
        setActiveAd('profile');
        incrementShownToday();
        setLastShown('profile');
        return;
      }
    }

    // Priority 3: Premium promo after meeting ends
    if (
      lastMeetingEndTime &&
      !isProcessingMeeting &&
      Date.now() - lastMeetingEndTime < MEETING_COOLDOWN_MS &&
      lastMeetingEndTime - (appStartTime || 0) > MEETING_MIN_DURATION_MS
    ) {
      const cooldown = getCooldownRemaining('promo');
      if (cooldown === 0) {
        setActiveAd('promo');
        incrementShownToday();
        setLastShown('promo');
        return;
      }
    }

    // Priority 4: JD awareness (has profile but no JD — handled by JDAwarenessToaster)
    // Already covered above
  }, [
    isAppReady,
    planDetails.isPremium,
    hasProfile,
    hasNativelyApi,
    lastMeetingEndTime,
    isProcessingMeeting,
    appStartTime,
    adsDisabled,
  ]);

  return {
    activeAd,
    dismissAd,
    previewAd,
  };
}
