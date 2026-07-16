const SUMMARY_LABEL_PREFIX = /^(?:d[eé]cision retenue|action|question ouverte|risque|[àa] v[eé]rifier|point cl[eé])\s*:\s*/i;

const SECTION_BULLET_LIMITS: Record<string, number> = {
  'resume executif': 3,
  decisions: 6,
  'plan d action': 6,
  'questions ouvertes': 4,
  risques: 4,
  'points a verifier': 5,
};

export function normalizeSummaryComparable(text: string): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitleText(value: string): string {
  return String(value || '')
    .replace(/```(?:text)?/gi, '')
    .replace(/^(?:title|titre)\s*:\s*/i, '')
    .replace(/["*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function collapseRepeatedTextBlock(value: string): string {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 8) return clean;

  for (let separatorLength = 0; separatorLength <= 3; separatorLength += 1) {
    const contentLength = clean.length - separatorLength;
    if (contentLength <= 0 || contentLength % 2 !== 0) continue;
    const half = contentLength / 2;
    const first = clean.slice(0, half).trim();
    const second = clean.slice(half + separatorLength).trim();
    if (first.length >= 4 && normalizeSummaryComparable(first) === normalizeSummaryComparable(second)) {
      return first;
    }
  }

  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 6 && words.length % 2 === 0) {
    const half = words.length / 2;
    const first = words.slice(0, half).join(' ');
    const second = words.slice(half).join(' ');
    if (normalizeSummaryComparable(first) === normalizeSummaryComparable(second)) {
      return first;
    }
  }

  return clean;
}

export function sanitizeMeetingTitle(value: string): string {
  return collapseRepeatedTextBlock(cleanTitleText(value)).slice(0, 140).trim();
}

export function isRepeatedMeetingTitle(value: string): boolean {
  const clean = cleanTitleText(value);
  return Boolean(clean) && normalizeSummaryComparable(sanitizeMeetingTitle(clean)) !== normalizeSummaryComparable(clean);
}

export function summaryItemKey(value: string): string {
  return normalizeSummaryComparable(String(value || '').replace(SUMMARY_LABEL_PREFIX, ''));
}

function isSubstantialDuplicate(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 48 && longer.includes(shorter) && shorter.length / longer.length >= 0.82;
}

export function deduplicateSummaryItems(items: unknown[], maxItems = Number.POSITIVE_INFINITY): string[] {
  const kept: Array<{ key: string; text: string }> = [];
  for (const item of items || []) {
    const text = collapseRepeatedTextBlock(String(item || '')).trim();
    const key = summaryItemKey(text);
    if (!key || kept.some((existing) => isSubstantialDuplicate(existing.key, key))) continue;
    kept.push({ key, text });
    if (kept.length >= maxItems) break;
  }
  return kept.map((entry) => entry.text);
}

export function countDuplicateSummaryItems(items: unknown[]): number {
  const cleanItems = (items || []).map((item) => String(item || '').trim()).filter(Boolean);
  return cleanItems.length - deduplicateSummaryItems(cleanItems).length;
}

export function getSummarySectionBulletLimit(title: string): number {
  return SECTION_BULLET_LIMITS[normalizeSummaryComparable(title)] || 5;
}

export function summaryNeedsReview(score: number, checks: string[]): boolean {
  return score < 72 || checks.length > 0;
}
