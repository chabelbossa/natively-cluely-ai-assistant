export type ConferenceMemoryItemStatus = 'open' | 'confirmed' | 'resolved' | 'superseded';

export interface ConferenceMemoryItem {
  text: string;
  evidenceSegmentIds: string[];
  status: ConferenceMemoryItemStatus;
}

export interface ConferenceMemoryCoverage {
  fromSegmentId: string;
  throughSegmentId: string;
  segmentCount: number;
  updatedAt: number;
}

export interface ConferenceMemorySnapshot {
  version: 1;
  currentTopic: string;
  narrativeDigest: string;
  openQuestions: ConferenceMemoryItem[];
  activeProblems: ConferenceMemoryItem[];
  decisions: ConferenceMemoryItem[];
  keyFacts: ConferenceMemoryItem[];
  constraints: ConferenceMemoryItem[];
  uncertainties: ConferenceMemoryItem[];
  coverage: ConferenceMemoryCoverage | null;
}

export interface ConferenceMemorySourceSegment {
  id: string;
  speaker: string;
  text: string;
  timestamp: number;
}

export interface ConferenceMemoryCompactionRequest {
  previousMemory: ConferenceMemorySnapshot | null;
  newSegments: ConferenceMemorySourceSegment[];
}

export interface ConferenceMemoryGenerator {
  compactConferenceMemory(request: ConferenceMemoryCompactionRequest): Promise<ConferenceMemorySnapshot | null>;
}

const MEMORY_ITEM_LIMIT = 32;
const MEMORY_ITEM_TEXT_LIMIT = 640;
const MEMORY_DIGEST_LIMIT = 3_200;
const MEMORY_TOPIC_LIMIT = 480;
const MEMORY_CONTEXT_LIMIT = 8_000;
const EVIDENCE_ID_PATTERN = /^seg_(\d{6})$/;

const MEMORY_SECTIONS: Array<{
  key: keyof Pick<ConferenceMemorySnapshot, 'openQuestions' | 'activeProblems' | 'decisions' | 'keyFacts' | 'constraints' | 'uncertainties'>;
  label: string;
}> = [
  { key: 'openQuestions', label: 'OPEN QUESTIONS' },
  { key: 'activeProblems', label: 'ACTIVE PROBLEMS' },
  { key: 'keyFacts', label: 'KEY FACTS AND NUMBERS' },
  { key: 'constraints', label: 'CONSTRAINTS' },
  { key: 'decisions', label: 'DECISIONS' },
  { key: 'uncertainties', label: 'UNCERTAINTIES' },
];

export function conferenceSegmentId(index: number): string {
  return `seg_${String(index + 1).padStart(6, '0')}`;
}

export function conferenceSegmentIndex(id: string): number | null {
  const match = EVIDENCE_ID_PATTERN.exec(String(id || '').trim());
  if (!match) return null;
  const oneBased = Number(match[1]);
  return Number.isInteger(oneBased) && oneBased > 0 ? oneBased - 1 : null;
}

export function createEmptyConferenceMemory(): ConferenceMemorySnapshot {
  return {
    version: 1,
    currentTopic: '',
    narrativeDigest: '',
    openQuestions: [],
    activeProblems: [],
    decisions: [],
    keyFacts: [],
    constraints: [],
    uncertainties: [],
    coverage: null,
  };
}

export function normalizeConferenceMemorySnapshot(
  candidate: unknown,
  request: ConferenceMemoryCompactionRequest,
  coverage: ConferenceMemoryCoverage,
): ConferenceMemorySnapshot | null {
  if (!candidate || typeof candidate !== 'object') return null;

  const parsed = candidate as Record<string, unknown>;
  const previous = request.previousMemory || createEmptyConferenceMemory();
  const allowedEvidenceIds = new Set<string>(request.newSegments.map((segment) => segment.id));
  for (const item of allMemoryItems(previous)) {
    for (const id of item.evidenceSegmentIds) allowedEvidenceIds.add(id);
  }

  const normalized: ConferenceMemorySnapshot = {
    version: 1,
    currentTopic: cleanText(parsed.currentTopic, MEMORY_TOPIC_LIMIT) || previous.currentTopic,
    narrativeDigest: cleanText(parsed.narrativeDigest, MEMORY_DIGEST_LIMIT) || previous.narrativeDigest,
    openQuestions: mergeMemoryItems(previous.openQuestions, normalizeItems(parsed.openQuestions, allowedEvidenceIds)),
    activeProblems: mergeMemoryItems(previous.activeProblems, normalizeItems(parsed.activeProblems, allowedEvidenceIds)),
    decisions: mergeMemoryItems(previous.decisions, normalizeItems(parsed.decisions, allowedEvidenceIds)),
    keyFacts: mergeMemoryItems(previous.keyFacts, normalizeItems(parsed.keyFacts, allowedEvidenceIds)),
    constraints: mergeMemoryItems(previous.constraints, normalizeItems(parsed.constraints, allowedEvidenceIds)),
    uncertainties: mergeMemoryItems(previous.uncertainties, normalizeItems(parsed.uncertainties, allowedEvidenceIds)),
    coverage,
  };

  const hasUsefulMemory = Boolean(
    normalized.currentTopic ||
    normalized.narrativeDigest ||
    allMemoryItems(normalized).length > 0
  );
  return hasUsefulMemory ? normalized : null;
}

export function formatConferenceMemoryContext(memory: ConferenceMemorySnapshot | null): string {
  if (!memory?.coverage) return '';

  const lines = [
    '[SEMANTIC CONFERENCE MEMORY]',
    'source=LLM-generated structured compaction validated by the application',
    `coverage=${memory.coverage.fromSegmentId}..${memory.coverage.throughSegmentId} (${memory.coverage.segmentCount} raw segments retained)`,
    'authority=This memory describes older discussion. The recent verbatim transcript is authoritative for the latest wording and state.',
    'retrieval=Evidence IDs point to the immutable raw transcript and may be used to recover exact older wording.',
  ];

  if (memory.currentTopic) lines.push(`current_topic=${memory.currentTopic}`);
  if (memory.narrativeDigest) lines.push(`narrative_digest=${memory.narrativeDigest}`);

  let omitted = 0;
  for (const section of MEMORY_SECTIONS) {
    const items = memory[section.key];
    if (items.length === 0) continue;
    lines.push(`${section.label}:`);
    for (const item of items) {
      const evidence = item.evidenceSegmentIds.length > 0
        ? ` evidence=${item.evidenceSegmentIds.join(',')}`
        : '';
      const line = `- [${item.status}] ${item.text}${evidence}`;
      if ([...lines, line, '[/SEMANTIC CONFERENCE MEMORY]'].join('\n').length > MEMORY_CONTEXT_LIMIT) {
        omitted++;
        continue;
      }
      lines.push(line);
    }
  }

  if (omitted > 0) {
    lines.push(`additional_structured_items_not_rendered=${omitted}; exact source remains available in the raw transcript`);
  }
  lines.push('[/SEMANTIC CONFERENCE MEMORY]');
  return lines.join('\n');
}

export function selectConferenceMemoryEvidenceIds(
  memory: ConferenceMemorySnapshot | null,
  query: string,
  maxIds: number = 6,
): string[] {
  if (!memory || maxIds <= 0) return [];
  const queryTerms = contentTerms(query);
  const scored = allMemoryItems(memory).map((item, index) => {
    const normalized = normalize(item.text);
    const overlap = queryTerms.filter((term) => normalized.includes(term)).length;
    const activeBoost = item.status === 'open' ? 1.2 : item.status === 'confirmed' ? 0.5 : 0;
    return { item, score: overlap * 2 + activeBoost + index / 10_000 };
  });

  const candidates = scored
    .filter((entry) => queryTerms.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const ids: string[] = [];
  for (const { item } of candidates) {
    for (const id of item.evidenceSegmentIds) {
      if (!ids.includes(id)) ids.push(id);
      if (ids.length >= maxIds) return ids;
    }
  }
  return ids;
}

function normalizeItems(value: unknown, allowedEvidenceIds: Set<string>): ConferenceMemoryItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ConferenceMemoryItem | null => {
      if (typeof entry === 'string') {
        const text = cleanText(entry, MEMORY_ITEM_TEXT_LIMIT);
        return text ? { text, evidenceSegmentIds: [], status: 'confirmed' } : null;
      }
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      const text = cleanText(item.text, MEMORY_ITEM_TEXT_LIMIT);
      if (!text) return null;
      const evidenceSegmentIds = Array.isArray(item.evidenceSegmentIds)
        ? [...new Set(item.evidenceSegmentIds
          .map((id) => String(id || '').trim())
          .filter((id) => allowedEvidenceIds.has(id)))]
        : [];
      return {
        text,
        evidenceSegmentIds,
        status: normalizeStatus(item.status),
      };
    })
    .filter((item): item is ConferenceMemoryItem => Boolean(item));
}

function mergeMemoryItems(previous: ConferenceMemoryItem[], incoming: ConferenceMemoryItem[]): ConferenceMemoryItem[] {
  const merged = new Map<string, ConferenceMemoryItem>();
  for (const item of [...previous, ...incoming]) {
    const key = normalize(item.text);
    if (!key) continue;
    const existing = merged.get(key);
    merged.set(key, existing
      ? {
        ...item,
        evidenceSegmentIds: [...new Set([...existing.evidenceSegmentIds, ...item.evidenceSegmentIds])],
      }
      : item);
  }
  return [...merged.values()].slice(-MEMORY_ITEM_LIMIT);
}

function allMemoryItems(memory: ConferenceMemorySnapshot): ConferenceMemoryItem[] {
  return [
    ...memory.openQuestions,
    ...memory.activeProblems,
    ...memory.decisions,
    ...memory.keyFacts,
    ...memory.constraints,
    ...memory.uncertainties,
  ];
}

function normalizeStatus(value: unknown): ConferenceMemoryItemStatus {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'open' || status === 'resolved' || status === 'superseded' || status === 'confirmed') {
    return status;
  }
  return 'confirmed';
}

function cleanText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function contentTerms(text: string): string[] {
  const stopWords = new Set([
    'avec', 'pour', 'dans', 'donc', 'alors', 'comme', 'cette', 'cela', 'vous', 'nous', 'leur', 'notre',
    'that', 'this', 'with', 'from', 'your', 'their', 'what', 'why', 'how', 'une', 'des', 'les', 'sur', 'par',
    'faire', 'etre', 'être', 'avoir', 'question', 'probleme', 'problème',
  ]);
  return [...new Set(normalize(text)
    .split(' ')
    .filter((word) => (word.length >= 4 || /^\d+$/.test(word)) && !stopWords.has(word)))]
    .slice(0, 36);
}

function normalize(text: string): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
