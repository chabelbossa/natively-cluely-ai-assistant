import fs from 'fs';
import { TranscriptRouter } from '../transcript/TranscriptRouter';
import type { CanonicalTranscriptRole, RawTranscriptSegment, TranscriptRouteResult } from '../transcript/types';

export interface ReplayEvent extends RawTranscriptSegment {
  expectedRole?: CanonicalTranscriptRole | 'suppressed';
  expectedTextIncludes?: string;
  expectedTextExcludes?: string[];
  note?: string;
}

export interface ReplayFixture {
  name: string;
  description?: string;
  events: ReplayEvent[];
  thresholds?: {
    maxFalseMeRate?: number;
    maxDuplicateRate?: number;
    minInterlocutorFinals?: number;
    minDistinctInterlocutorSpeakers?: number;
    maxSuppressedExpectedMe?: number;
    maxUnsuppressedExpectedSuppressed?: number;
    maxRoleMismatches?: number;
  };
}

export interface ReplayReport {
  name: string;
  totalEvents: number;
  canonicalSegments: number;
  suppressedSegments: number;
  finalInterlocutorSegments: number;
  falseMeCount: number;
  suppressedExpectedMe: number;
  unsuppressedExpectedSuppressed: number;
  roleMismatchCount: number;
  textMismatchCount: number;
  duplicateCount: number;
  distinctInterlocutorSpeakers: number;
  falseMeRate: number;
  duplicateRate: number;
  passed: boolean;
  failures: string[];
  routeResults: Array<{
    input: ReplayEvent;
    result: TranscriptRouteResult;
  }>;
}

export function loadReplayFixture(filePath: string): ReplayFixture {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ReplayFixture;
}

export function runReplayFixture(fixture: ReplayFixture): ReplayReport {
  const router = new TranscriptRouter();
  const routeResults: ReplayReport['routeResults'] = [];
  let canonicalSegments = 0;
  let suppressedSegments = 0;
  let finalInterlocutorSegments = 0;
  let falseMeCount = 0;
  let suppressedExpectedMe = 0;
  let unsuppressedExpectedSuppressed = 0;
  let roleMismatchCount = 0;
  let textMismatchCount = 0;
  let duplicateCount = 0;
  const seenFinals: Array<{ role: string; text: string; timestamp: number }> = [];
  const distinctInterlocutorSpeakers = new Set<string>();

  const baseTimestamp = Date.now();
  const events = fixture.events.map((event, index) => ({
    ...event,
    timestamp: event.timestamp || baseTimestamp + index * 900,
  }));

  for (const event of events) {
    const result = router.route(event);
    routeResults.push({ input: event, result });

    if (result.suppressed || !result.segment) {
      suppressedSegments += 1;
      if (event.expectedRole === 'me') suppressedExpectedMe += 1;
      continue;
    }

    const segment = result.segment;
    canonicalSegments += 1;

    if (event.expectedRole === 'suppressed') {
      unsuppressedExpectedSuppressed += 1;
    }

    if (
      event.expectedRole &&
      event.expectedRole !== 'suppressed' &&
      segment.role !== event.expectedRole
    ) {
      roleMismatchCount += 1;
    }

    if (event.expectedTextIncludes && !normalize(segment.text).includes(normalize(event.expectedTextIncludes))) {
      textMismatchCount += 1;
    }

    for (const excludedText of event.expectedTextExcludes || []) {
      if (normalize(segment.text).includes(normalize(excludedText))) {
        textMismatchCount += 1;
        break;
      }
    }

    if (segment.final && segment.role !== 'me' && segment.role !== 'assistant') {
      finalInterlocutorSegments += 1;
      distinctInterlocutorSpeakers.add(segment.role);
    }

    if (segment.role === 'me' && event.expectedRole && event.expectedRole !== 'me') {
      falseMeCount += 1;
    }

    if (segment.final) {
      const normalized = normalize(segment.text);
      const duplicate = seenFinals.some((seen) =>
        seen.role !== segment.role &&
        Math.abs(segment.timestamp - seen.timestamp) <= 12_000 &&
        textSimilarity(normalized, seen.text) >= 0.72
      );
      if (duplicate) duplicateCount += 1;
      seenFinals.push({ role: segment.role, text: normalized, timestamp: segment.timestamp });
    }
  }

  const thresholds = {
    maxFalseMeRate: 0.02,
    maxDuplicateRate: 0.12,
    minInterlocutorFinals: 1,
    minDistinctInterlocutorSpeakers: 0,
    maxSuppressedExpectedMe: 0,
    maxUnsuppressedExpectedSuppressed: 0,
    maxRoleMismatches: 0,
    ...(fixture.thresholds || {}),
  };

  const finalEvents = Math.max(1, events.filter((event) => event.final).length);
  const falseMeRate = falseMeCount / finalEvents;
  const duplicateRate = duplicateCount / finalEvents;
  const failures: string[] = [];

  if (falseMeRate > thresholds.maxFalseMeRate) {
    failures.push(`false_me_rate ${falseMeRate.toFixed(3)} > ${thresholds.maxFalseMeRate}`);
  }
  if (duplicateRate > thresholds.maxDuplicateRate) {
    failures.push(`duplicate_rate ${duplicateRate.toFixed(3)} > ${thresholds.maxDuplicateRate}`);
  }
  if (finalInterlocutorSegments < thresholds.minInterlocutorFinals) {
    failures.push(`final_interlocutor_segments ${finalInterlocutorSegments} < ${thresholds.minInterlocutorFinals}`);
  }
  if (distinctInterlocutorSpeakers.size < thresholds.minDistinctInterlocutorSpeakers) {
    failures.push(`distinct_interlocutor_speakers ${distinctInterlocutorSpeakers.size} < ${thresholds.minDistinctInterlocutorSpeakers}`);
  }
  if (suppressedExpectedMe > thresholds.maxSuppressedExpectedMe) {
    failures.push(`suppressed_expected_me ${suppressedExpectedMe} > ${thresholds.maxSuppressedExpectedMe}`);
  }
  if (unsuppressedExpectedSuppressed > thresholds.maxUnsuppressedExpectedSuppressed) {
    failures.push(`unsuppressed_expected_suppressed ${unsuppressedExpectedSuppressed} > ${thresholds.maxUnsuppressedExpectedSuppressed}`);
  }
  if (roleMismatchCount > thresholds.maxRoleMismatches) {
    failures.push(`role_mismatches ${roleMismatchCount} > ${thresholds.maxRoleMismatches}`);
  }
  if (textMismatchCount > 0) {
    failures.push(`text_mismatches ${textMismatchCount} > 0`);
  }

  return {
    name: fixture.name,
    totalEvents: events.length,
    canonicalSegments,
    suppressedSegments,
    finalInterlocutorSegments,
    falseMeCount,
    suppressedExpectedMe,
    unsuppressedExpectedSuppressed,
    roleMismatchCount,
    textMismatchCount,
    duplicateCount,
    distinctInterlocutorSpeakers: distinctInterlocutorSpeakers.size,
    falseMeRate,
    duplicateRate,
    passed: failures.length === 0,
    failures,
    routeResults,
  };
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textSimilarity(a: string, b: string): number {
  const aWords = a.split(' ').filter(Boolean);
  const bWords = b.split(' ').filter(Boolean);
  if (aWords.length === 0 || bWords.length === 0) return 0;
  const aSet = new Set(aWords);
  const bSet = new Set(bWords);
  let intersection = 0;
  for (const word of aSet) {
    if (bSet.has(word)) intersection += 1;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}
