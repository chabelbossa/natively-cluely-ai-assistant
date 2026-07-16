const SUMMARY_LABEL_PREFIX = /^(?:d[eé]cision retenue|action|question ouverte|risque|[àa] v[eé]rifier|point cl[eé])\s*:\s*/i;

export interface SupplementalSummaryItem {
  item: string;
  sourceIndex: number;
}

export function insertEditableSummaryItemAfter(
  items: string[] | undefined,
  sourceIndex: number,
  currentValue: string,
): string[] {
  const nextItems = [...(items || [])];
  nextItems[sourceIndex] = currentValue;
  nextItems.splice(sourceIndex + 1, 0, '');
  return nextItems;
}

function comparableSummaryItem(value: string): string {
  return String(value || '')
    .replace(SUMMARY_LABEL_PREFIX, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function substantiallyMatches(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 48 && longer.includes(shorter) && shorter.length / longer.length >= 0.82;
}

export function summaryItemsEquivalent(left: string, right: string): boolean {
  return substantiallyMatches(comparableSummaryItem(left), comparableSummaryItem(right));
}

export function selectSupplementalSummaryItems(
  items: string[] | undefined,
  coveredItems: string[],
): SupplementalSummaryItem[] {
  const coveredKeys = coveredItems.map(comparableSummaryItem).filter(Boolean);
  const selectedKeys: string[] = [];
  const selected: SupplementalSummaryItem[] = [];

  for (const [sourceIndex, rawItem] of (items || []).entries()) {
    const item = String(rawItem || '').trim();
    const key = comparableSummaryItem(item);
    if (!key) continue;
    if (coveredKeys.some((covered) => substantiallyMatches(covered, key))) continue;
    if (selectedKeys.some((existing) => substantiallyMatches(existing, key))) continue;
    selectedKeys.push(key);
    selected.push({ item, sourceIndex });
  }

  return selected;
}
